//! Mobile gateway: an authenticated, end-to-end encrypted WebSocket relay that lets
//! paired devices follow and steer the desktop's ACP sessions.
//!
//! The Rust side is a secure pipe. The app UI implements the ACP-facing logic
//! (session list, replay, prompts, permission fan-out) in `src/gateway/hub.ts`.
//!
//! Protocol (see docs/MOBILE-PLAN.md):
//! * Pairing QR carries `u` (ws URL), `i` (pairing id) and `k` (32-byte pairing secret).
//!   The secret is never sent over the network. Device key K = HMAC(k, "supercharge-gw/device-key").
//! * Handshake (JSON text frames):
//!     C→S {t:"hello", id, nc, name}   S→C {t:"challenge", ns}
//!     sk = HMAC(K, "supercharge-gw/session" | nc | ns)
//!     C→S {t:"auth", mac: HMAC(sk, "client" | nc | ns)}
//!     S→C {t:"ok", mac: HMAC(sk, "server" | nc | ns), deviceId}
//! * Then binary frames: AES-256-GCM(sk), nonce = dir(4 bytes BE: 1 c→s, 2 s→c) | counter(u64 BE),
//!   counters strictly increase (replays/reorders are rejected). Plaintext: one JSON-RPC message.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

type HmacSha256 = Hmac<Sha256>;

pub const PAIR_TTL_SECS: u64 = 120;

// ---------- crypto (pure, unit-tested) ----------

pub fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac key");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

pub fn device_key(pair_secret: &[u8]) -> [u8; 32] {
    hmac(pair_secret, &[b"supercharge-gw/device-key"])
}

pub fn session_key(device_key: &[u8], nc: &[u8], ns: &[u8]) -> [u8; 32] {
    hmac(device_key, &[b"supercharge-gw/session", nc, ns])
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct Channel {
    cipher: Aes256Gcm,
    send_dir: u32,
    send_ctr: u64,
    recv_ctr: u64,
}

fn nonce(dir: u32, ctr: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..4].copy_from_slice(&dir.to_be_bytes());
    n[4..].copy_from_slice(&ctr.to_be_bytes());
    n
}

impl Channel {
    /// `server = true` seals with dir 2 and opens dir 1.
    pub fn new(sk: &[u8; 32], server: bool) -> Self {
        Self { cipher: Aes256Gcm::new_from_slice(sk).unwrap(), send_dir: if server { 2 } else { 1 }, send_ctr: 0, recv_ctr: 0 }
    }
    /// Frame = counter (8 bytes BE) | ciphertext+tag.
    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        self.send_ctr += 1;
        let n = nonce(self.send_dir, self.send_ctr);
        let ct = self.cipher.encrypt(Nonce::from_slice(&n), plain).expect("encrypt");
        let mut out = self.send_ctr.to_be_bytes().to_vec();
        out.extend(ct);
        out
    }
    pub fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>, &'static str> {
        if frame.len() < 8 + 16 {
            return Err("short frame");
        }
        let ctr = u64::from_be_bytes(frame[..8].try_into().unwrap());
        if ctr <= self.recv_ctr {
            return Err("replayed frame");
        }
        let n = nonce(3 - self.send_dir, ctr);
        let pt = self.cipher.decrypt(Nonce::from_slice(&n), &frame[8..]).map_err(|_| "bad frame")?;
        self.recv_ctr = ctr;
        Ok(pt)
    }
}

// ---------- state ----------

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub paired_at: u64,
    #[serde(default)]
    pub last_seen: u64,
}

struct Pairing {
    secret: [u8; 32],
    expires: u64,
}

#[derive(Default)]
struct State {
    url: Option<String>,
    stop: Option<oneshot::Sender<()>>,
    pairings: HashMap<String, Pairing>,
    approvals: HashMap<String, oneshot::Sender<bool>>,
    conns: HashMap<String, mpsc::UnboundedSender<Value>>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
fn st() -> std::sync::MutexGuard<'static, State> {
    STATE.get_or_init(Default::default).lock().unwrap()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn rand<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("random");
    b
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn devices_path() -> std::path::PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("supercharge-studio").join("devices.json")
}
pub fn load_devices() -> Vec<Device> {
    std::fs::read(devices_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn save_devices(d: &[Device]) {
    let p = devices_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, serde_json::to_vec_pretty(d).unwrap());
}
fn key_account(id: &str) -> String {
    format!("gateway-device-{id}")
}
/// Keychain access blocks (and some backends start their own runtime), so keep it off the async workers.
async fn off_runtime<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.await.ok()
}

async fn device_secret(id: &str) -> Option<[u8; 32]> {
    if !load_devices().iter().any(|d| d.id == id) {
        return None;
    }
    let acct = key_account(id);
    let (v, _) = off_runtime(move || crate::secrets::get(&acct)).await?;
    B64.decode(v?).ok()?.try_into().ok()
}
async fn store_device_secret(id: &str, key: Option<[u8; 32]>) -> Result<(), String> {
    let acct = key_account(id);
    let val = key.map(|k| B64.encode(k)).unwrap_or_default();
    off_runtime(move || crate::secrets::set(&acct, &val).map(|_| ())).await.unwrap_or_else(|| Err("secure storage unavailable".into()))
}

/// Best-effort LAN address (no packets are sent).
fn lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("192.0.2.1:9").map(|_| s))
        .and_then(|s| s.local_addr())
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

// ---------- connection ----------

async fn handle(app: AppHandle, stream: tokio::net::TcpStream) -> Result<(), String> {
    let mut ws = tokio_tungstenite::accept_async(stream).await.map_err(|e| e.to_string())?;
    let next_json = |m: Option<Result<Message, _>>| -> Result<Value, String> {
        match m {
            Some(Ok(Message::Text(t))) => serde_json::from_str(&t).map_err(|e| e.to_string()),
            _ => Err("expected handshake".into()),
        }
    };
    let timeout = Duration::from_secs(15);
    let hello = next_json(tokio::time::timeout(timeout, ws.next()).await.map_err(|_| "timeout")?)?;
    if hello["t"] != "hello" {
        return Err("bad hello".into());
    }
    let id = hello["id"].as_str().unwrap_or("").to_string();
    let name = hello["name"].as_str().unwrap_or("Device").chars().take(60).collect::<String>();
    let nc = B64.decode(hello["nc"].as_str().unwrap_or("")).map_err(|_| "bad nonce")?;
    if nc.len() != 16 {
        return Err("bad nonce".into());
    }
    // Pairing id (one-time) or known device id.
    let pairing = {
        let mut s = st();
        let p = s.pairings.remove(&id).filter(|p| p.expires >= now());
        p.map(|p| p.secret)
    };
    let (key, is_pairing) = match pairing {
        Some(sec) => (device_key(&sec), true),
        None => match device_secret(&id).await {
            Some(k) => (k, false),
            _ => {
                let _ = ws.send(Message::Text(json!({"t": "denied", "reason": "unknown device or expired pairing"}).to_string().into())).await;
                return Err("unknown device".into());
            }
        },
    };
    let ns: [u8; 16] = rand();
    ws.send(Message::Text(json!({"t": "challenge", "ns": B64.encode(ns)}).to_string().into())).await.map_err(|e| e.to_string())?;
    let auth = next_json(tokio::time::timeout(timeout, ws.next()).await.map_err(|_| "timeout")?)?;
    let sk = session_key(&key, &nc, &ns);
    let mac = B64.decode(auth["mac"].as_str().unwrap_or("")).unwrap_or_default();
    if auth["t"] != "auth" || !ct_eq(&mac, &hmac(&sk, &[b"client", &nc, &ns])) {
        let _ = ws.send(Message::Text(json!({"t": "denied", "reason": "authentication failed"}).to_string().into())).await;
        return Err("auth failed".into());
    }
    let device_id = if is_pairing {
        // The user confirms on the desktop.
        let (tx, rx) = oneshot::channel();
        st().approvals.insert(id.clone(), tx);
        let _ = app.emit("gateway://pair-request", json!({ "pairingId": id, "name": name }));
        let ok = tokio::time::timeout(Duration::from_secs(120), rx).await.ok().and_then(|r| r.ok()).unwrap_or(false);
        st().approvals.remove(&id);
        if !ok {
            let _ = ws.send(Message::Text(json!({"t": "denied", "reason": "pairing rejected on desktop"}).to_string().into())).await;
            return Err("pairing rejected".into());
        }
        let did = hex(&rand::<8>());
        store_device_secret(&did, Some(key)).await?;
        let mut ds = load_devices();
        ds.push(Device { id: did.clone(), name: name.clone(), paired_at: now(), last_seen: now() });
        save_devices(&ds);
        did
    } else {
        id.clone()
    };
    ws.send(Message::Text(json!({"t": "ok", "mac": B64.encode(hmac(&sk, &[b"server", &nc, &ns])), "deviceId": device_id}).to_string().into()))
        .await
        .map_err(|e| e.to_string())?;

    let mut ds = load_devices();
    if let Some(d) = ds.iter_mut().find(|d| d.id == device_id) {
        d.last_seen = now();
        if !is_pairing && d.name != name && !name.is_empty() {
            d.name = name.clone();
        }
    }
    save_devices(&ds);

    let mut ch = Channel::new(&sk, true);
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    if let Some(old) = st().conns.insert(device_id.clone(), tx) {
        drop(old);
    }
    let _ = app.emit("gateway://connected", json!({ "deviceId": device_id, "name": name }));
    let (mut sink, mut stream) = ws.split();
    let result = loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(v) => {
                    if v.get("__close").is_some() { break Ok(()); }
                    let frame = ch.seal(v.to_string().as_bytes());
                    if sink.send(Message::Binary(frame.into())).await.is_err() { break Ok(()); }
                }
                None => break Ok(()),
            },
            msg = stream.next() => match msg {
                Some(Ok(Message::Binary(b))) => match ch.open(&b).ok().and_then(|p| serde_json::from_slice::<Value>(&p).ok()) {
                    Some(v) => { let _ = app.emit("gateway://message", json!({ "deviceId": device_id, "msg": v })); }
                    None => break Err("bad frame".to_string()),
                },
                Some(Ok(Message::Ping(p))) => { let _ = sink.send(Message::Pong(p)).await; }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break Ok(()),
                Some(Ok(_)) => {}
            },
        }
    };
    {
        let mut s = st();
        if s.conns.get(&device_id).map(|c| c.is_closed()).unwrap_or(false) {
            s.conns.remove(&device_id);
        }
    }
    let _ = app.emit("gateway://disconnected", json!({ "deviceId": device_id }));
    result
}

// ---------- commands ----------

#[derive(Serialize)]
pub struct Status {
    running: bool,
    url: Option<String>,
    devices: Vec<Device>,
    connected: Vec<String>,
}

#[tauri::command]
pub fn gateway_status() -> Status {
    let s = st();
    Status {
        running: s.url.is_some(),
        url: s.url.clone(),
        devices: load_devices(),
        connected: s.conns.iter().filter(|(_, c)| !c.is_closed()).map(|(k, _)| k.clone()).collect(),
    }
}

/// Start listening. `bind` defaults to 0.0.0.0:2420 (LAN); use 127.0.0.1:<port> behind a tunnel.
#[tauri::command]
pub async fn gateway_start(app: AppHandle, bind: Option<String>) -> Result<String, String> {
    if let Some(u) = st().url.clone() {
        return Ok(u);
    }
    let bind = bind.unwrap_or_else(|| "0.0.0.0:2420".into());
    let listener = TcpListener::bind(&bind).await.map_err(|e| format!("gateway bind {bind}: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let host = if addr.ip().is_unspecified() { lan_ip() } else { addr.ip().to_string() };
    let url = format!("ws://{host}:{}/gw", addr.port());
    let (stop_tx, mut stop_rx) = oneshot::channel();
    {
        let mut s = st();
        s.url = Some(url.clone());
        s.stop = Some(stop_tx);
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                acc = listener.accept() => if let Ok((sock, _)) = acc {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { let _ = handle(app, sock).await; });
                }
            }
        }
    });
    Ok(url)
}

#[tauri::command]
pub fn gateway_stop() {
    let mut s = st();
    s.url = None;
    if let Some(t) = s.stop.take() {
        let _ = t.send(());
    }
    for (_, c) in s.conns.drain() {
        let _ = c.send(json!({"__close": true}));
    }
    s.pairings.clear();
}

/// New one-time pairing code. `public_url` overrides the advertised URL (tunnel).
#[tauri::command]
pub fn gateway_pair_begin(public_url: Option<String>, desktop_name: Option<String>) -> Result<Value, String> {
    let mut s = st();
    let url = public_url.filter(|u| !u.trim().is_empty()).or_else(|| s.url.clone()).ok_or("gateway is not running")?;
    let id = format!("p-{}", hex(&rand::<8>()));
    let secret: [u8; 32] = rand();
    let expires = now() + PAIR_TTL_SECS;
    s.pairings.retain(|_, p| p.expires >= now());
    s.pairings.insert(id.clone(), Pairing { secret, expires });
    let name = desktop_name.unwrap_or_else(|| "Supercharge Studio".into());
    let uri = format!(
        "scstudio://pair?u={}&i={}&k={}&n={}",
        pct(&url),
        id,
        B64URL.encode(secret),
        pct(&name)
    );
    let svg = qrcode::QrCode::with_error_correction_level(uri.as_bytes(), qrcode::EcLevel::M)
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build();
    Ok(json!({ "uri": uri, "svg": svg, "expiresAt": expires * 1000, "pairingId": id }))
}

fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[tauri::command]
pub fn gateway_pair_answer(pairing_id: String, allow: bool) {
    if let Some(tx) = st().approvals.remove(&pairing_id) {
        let _ = tx.send(allow);
    }
}

#[tauri::command]
pub async fn gateway_revoke(device_id: String) {
    let mut ds = load_devices();
    ds.retain(|d| d.id != device_id);
    save_devices(&ds);
    let _ = store_device_secret(&device_id, None).await;
    if let Some(c) = st().conns.remove(&device_id) {
        let _ = c.send(json!({"__close": true}));
    }
}

/// Send one JSON-RPC message to a connected device (`*` = all).
#[tauri::command]
pub fn gateway_send(device_id: String, msg: Value) -> bool {
    let s = st();
    if device_id == "*" {
        s.conns.values().for_each(|c| {
            let _ = c.send(msg.clone());
        });
        return true;
    }
    s.conns.get(&device_id).map(|c| c.send(msg).is_ok()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_roundtrip_and_replay() {
        let k = device_key(b"0123456789abcdef0123456789abcdef");
        let sk = session_key(&k, &[1; 16], &[2; 16]);
        let mut srv = Channel::new(&sk, true);
        let mut cli = Channel::new(&sk, false);
        let f = cli.seal(b"{\"a\":1}");
        assert_eq!(srv.open(&f).unwrap(), b"{\"a\":1}");
        assert!(srv.open(&f).is_err(), "replay must fail");
        let g = srv.seal(b"hi");
        assert_eq!(cli.open(&g).unwrap(), b"hi");
        // direction separation: a server frame is not valid as a client frame
        let mut srv2 = Channel::new(&sk, true);
        assert!(srv2.open(&g).is_err());
        // tamper
        let mut t = cli.seal(b"xyz");
        let n = t.len();
        t[n - 1] ^= 1;
        assert!(srv.open(&t).is_err());
    }

    #[test]
    fn known_vectors_match_ts_client() {
        // Same vector is asserted in tests/gateway.test.ts (WebCrypto implementation).
        let k = device_key(&[7u8; 32]);
        let sk = session_key(&k, &[1; 16], &[2; 16]);
        let mut cli = Channel::new(&sk, false);
        let f = cli.seal(b"ping");
        println!("VECTOR k={} sk={} frame={}", hex(&k), hex(&sk), hex(&f));
        assert_eq!(hex(&k), "a8d2257bae4eb22c5b7c61b326406960c30a2bec5351a33062fb54d24bdca610");
        assert_eq!(hex(&sk), "5f07b9525e8ae3f800a266d2dc15a0fd4305e9a2073377979ab7e23c27fc74c1");
        assert_eq!(hex(&f), "00000000000000019a5c67de7d49a6a5a8c6cd26d05da1de57c8cff4");
    }

    #[test]
    fn pct_encodes() {
        assert_eq!(pct("ws://1.2.3.4:2420/gw"), "ws%3A%2F%2F1.2.3.4%3A2420%2Fgw");
    }
}
