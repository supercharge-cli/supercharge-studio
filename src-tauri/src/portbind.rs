//! Listen without ever failing on a port conflict (shared by the desktop app and the headless server).
//!
//! Order: the preferred port, then 2420..=2430, then a port chosen by the OS.

use tokio::net::TcpListener;

pub const FALLBACK_RANGE: std::ops::RangeInclusive<u16> = 2420..=2430;

/// Split "host:port" (IPv6 in brackets allowed). A missing or bad port gives `default_port`.
pub fn split(bind: &str, default_port: u16) -> (String, u16) {
    match bind.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && !h.ends_with(':') => (h.to_string(), p.parse().unwrap_or(default_port)),
        _ => (bind.to_string(), default_port),
    }
}

/// Bind `host` on `preferred`, falling back as described above. Returns the listener and, when the
/// preferred port was busy, the reason (for logs and the UI).
pub async fn bind(host: &str, preferred: u16) -> Result<(TcpListener, Option<String>), String> {
    let mut first_err = None;
    let mut tried = vec![preferred];
    tried.extend(FALLBACK_RANGE.filter(|p| *p != preferred));
    for p in tried.into_iter().chain(std::iter::once(0)) {
        match TcpListener::bind((host, p)).await {
            Ok(l) => {
                let note = first_err.map(|e: String| format!("port {preferred} unavailable ({e}); using {}", l.local_addr().map(|a| a.port()).unwrap_or(p)));
                return Ok((l, note));
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e.to_string());
                }
                // A bad host (not a port problem) will fail on every port: stop early.
                if e.kind() == std::io::ErrorKind::AddrNotAvailable || e.kind() == std::io::ErrorKind::InvalidInput {
                    return Err(format!("cannot listen on {host}: {e}"));
                }
            }
        }
    }
    Err(format!("cannot listen on {host}: {}", first_err.unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn falls_back_when_taken() {
        let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = busy.local_addr().unwrap().port();
        let (l, note) = bind("127.0.0.1", port).await.unwrap();
        assert_ne!(l.local_addr().unwrap().port(), port);
        assert!(note.unwrap().contains(&port.to_string()));
        let (l2, n2) = bind("127.0.0.1", 0).await.unwrap();
        assert!(l2.local_addr().unwrap().port() > 0 && n2.is_none());
        assert_eq!(split("0.0.0.0:2425", 2420), ("0.0.0.0".into(), 2425));
        assert_eq!(split("[::]:9", 2420), ("[::]".into(), 9));
    }
}
