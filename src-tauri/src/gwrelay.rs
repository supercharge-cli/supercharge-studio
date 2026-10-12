//! Outbound relay client shared by the desktop app and the headless server
//! (docs/MOBILE-PLAN.md, "Relay mode"). The host keeps one control socket to the relay
//! and opens one lane socket per device; each lane then runs the normal gateway
//! handshake + encrypted channel, so the relay only ever forwards opaque frames.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type Lane = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Install the ring crypto provider for rustls (idempotent).
pub fn install_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// URL a phone uses to reach this host through the relay.
pub fn connect_url(relay: &str, host_id: &str) -> String {
    format!("{}/v1/connect/{host_id}", base(relay))
}

/// Next reconnect delay: exponential 1s → 60s with ±20% jitter.
pub fn backoff(attempt: u32, jitter: f64) -> Duration {
    let secs = (1u64 << attempt.min(6)).min(60) as f64;
    Duration::from_millis((secs * 1000.0 * (0.8 + 0.4 * jitter.clamp(0.0, 1.0))) as u64)
}

/// Run until `stop` fires. `status` gets "connecting", "online" or "retrying in Ns: why".
pub async fn run(
    relay: String,
    host_id: String,
    token: String,
    status: Arc<dyn Fn(String) + Send + Sync>,
    on_lane: Arc<dyn Fn(Lane) + Send + Sync>,
    mut stop: oneshot::Receiver<()>,
) {
    install_tls();
    let relay = base(&relay);
    let mut attempt = 0u32;
    loop {
        status("connecting".into());
        let err = match session(&relay, &host_id, &token, &status, &on_lane, &mut stop).await {
            Ok(()) => return, // stopped
            Err(e) => e,
        };
        let wait = backoff(attempt, (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_millis() as f64) / 1000.0);
        attempt = attempt.saturating_add(1);
        status(format!("retrying in {}s: {err}", wait.as_secs().max(1)));
        tokio::select! {
            _ = &mut stop => return,
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

async fn session(
    relay: &str,
    host_id: &str,
    token: &str,
    status: &Arc<dyn Fn(String) + Send + Sync>,
    on_lane: &Arc<dyn Fn(Lane) + Send + Sync>,
    stop: &mut oneshot::Receiver<()>,
) -> Result<(), String> {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{relay}/v1/host/{host_id}")).await.map_err(|e| e.to_string())?;
    ws.send(Message::Text(json!({"t": "register", "token": token}).to_string().into())).await.map_err(|e| e.to_string())?;
    match tokio::time::timeout(Duration::from_secs(10), ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => {
            let v: Value = serde_json::from_str(&t).unwrap_or_default();
            if v["t"] != "registered" {
                return Err(v["reason"].as_str().unwrap_or("registration refused").to_string());
            }
        }
        _ => return Err("no registration reply".into()),
    }
    status("online".into());
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.tick().await;
    loop {
        tokio::select! {
            _ = &mut *stop => { let _ = ws.close(None).await; return Ok(()); }
            _ = ping.tick() => { ws.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?; }
            m = ws.next() => match m {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap_or_default();
                    if v["t"] == "lane" {
                        let lane = v["lane"].as_str().unwrap_or("").to_string();
                        if lane.is_empty() || !lane.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { continue; }
                        let url = format!("{relay}/v1/lane/{host_id}/{lane}?token={}", pct(token));
                        let cb = on_lane.clone();
                        tokio::spawn(async move {
                            if let Ok((lane_ws, _)) = tokio_tungstenite::connect_async(url).await { cb(lane_ws); }
                        });
                    }
                }
                Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                Some(Ok(Message::Close(f))) => return Err(f.map(|f| f.reason.to_string()).filter(|r| !r.is_empty()).unwrap_or_else(|| "relay closed".into())),
                Some(Err(e)) => return Err(e.to_string()),
                None => return Err("relay closed".into()),
                Some(Ok(_)) => {}
            },
        }
    }
}

pub fn pct(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0, 0.5).as_millis(), 1000);
        assert_eq!(backoff(3, 0.5).as_millis(), 8000);
        assert_eq!(backoff(20, 0.5).as_millis(), 60000);
        assert!(backoff(2, 0.0) < backoff(2, 1.0));
    }
    #[test]
    fn urls() {
        assert_eq!(connect_url("wss://r.example/", "abc"), "wss://r.example/v1/connect/abc");
    }
}
