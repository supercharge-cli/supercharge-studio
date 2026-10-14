//! Supercharge Studio Server — the mobile gateway without a desktop UI, for VMs and servers.
//!
//! Attaches to (or starts) `supercharge agent serve`, accepts paired phones over the same
//! end-to-end encrypted protocol as the desktop app (docs/MOBILE-PLAN.md), optionally
//! through an outbound relay, and bridges each phone to the agent over ACP.
//! Pairing: `supercharge-studio-server pair` prints a terminal QR + link and asks you to
//! approve the device. See docs/SERVER.md.

#[path = "../../src-tauri/src/gwcrypto.rs"]
mod gwcrypto;
#[path = "../../src-tauri/src/lanaddr.rs"]
mod lanaddr;
#[path = "../../src-tauri/src/portbind.rs"]
mod portbind;
#[path = "../../src-tauri/src/gwrelay.rs"]
mod gwrelay;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use gwcrypto::{ct_eq, device_key, hmac, session_key, Channel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const PAIR_TTL: u64 = 120;
/// Requests a phone may send to the agent. Everything else is refused.
const ALLOWED: &[&str] = &["initialize", "session/list", "session/load", "session/new", "session/prompt", "session/cancel", "session/set_config_option", "session/set_mode"];

// ---------- config ----------

#[derive(Clone, Debug)]
pub struct Config {
    bind: String,
    /// The user chose the address (flag or env); otherwise the last used port is preferred.
    bind_explicit: bool,
    public_url: Option<String>,
    agent: String,
    agent_secret: String,
    spawn_agent: bool,
    relay: Option<String>,
    data: PathBuf,
    name: String,
    control: String,
}

fn usage() -> ! {
    eprintln!(
        "Supercharge Studio Server {}

USAGE:
  supercharge-studio-server [run] [OPTIONS]   start the gateway (default)
  supercharge-studio-server pair [--data-dir D] [--control ADDR] [--yes]
                                              print a pairing QR + link and approve the device
  supercharge-studio-server devices           list paired devices
  supercharge-studio-server revoke <id>       remove a paired device

OPTIONS (env in brackets):
  --bind ADDR          gateway listen address [SCS_BIND] (0.0.0.0:2420)
  --public-url URL     URL phones should use, e.g. behind a tunnel [SCS_PUBLIC_URL]
  --agent URL          agent serve address [SCS_AGENT] (ws://127.0.0.1:2419)
  --agent-secret S     agent serve key [SUPERCHARGE_AGENT_SECRET]
  --spawn-agent        start `supercharge agent serve` if nothing is listening [SCS_SPAWN_AGENT=1]
  --public             Public mode: pair through the built-in relay so phones connect
                       from any network (LAN addresses stay as a fast path) [SCS_REACH=public]
  --local              Local mode: LAN only, no relay (default) [SCS_REACH=local]
  --relay URL          custom relay for Public mode, e.g. wss://relay.example.com [SCS_RELAY]
  --data-dir DIR       keys + devices [SCS_DATA] (~/.config/supercharge-studio-server)
  --name NAME          name shown on the phone [SCS_NAME] (hostname)
  --control ADDR       local control socket [SCS_CONTROL] (127.0.0.1:2422)",
        env!("CARGO_PKG_VERSION")
    );
    std::process::exit(2)
}

fn parse(args: &[String]) -> (String, Config, Vec<String>) {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let mut c = Config {
        bind: env("SCS_BIND").unwrap_or_else(|| "0.0.0.0:2420".into()),
        bind_explicit: env("SCS_BIND").is_some(),
        public_url: env("SCS_PUBLIC_URL"),
        agent: env("SCS_AGENT").unwrap_or_else(|| "ws://127.0.0.1:2419".into()),
        agent_secret: env("SUPERCHARGE_AGENT_SECRET").unwrap_or_default(),
        spawn_agent: env("SCS_SPAWN_AGENT").as_deref() == Some("1"),
        relay: env("SCS_RELAY"),
        data: env("SCS_DATA").map(PathBuf::from).unwrap_or_else(|| dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("supercharge-studio-server")),
        name: env("SCS_NAME").unwrap_or_else(hostname),
        control: env("SCS_CONTROL").unwrap_or_else(|| "127.0.0.1:2422".into()),
    };
    let mut cmd = "run".to_string();
    let mut rest = vec![];
    let mut reach: Option<bool> = env("SCS_REACH").map(|v| v.eq_ignore_ascii_case("public"));
    let mut i = 0;
    let val = |i: &mut usize| -> String {
        *i += 1;
        args.get(*i).cloned().unwrap_or_else(|| usage())
    };
    while i < args.len() {
        match args[i].as_str() {
            "run" | "pair" | "devices" | "revoke" if i == 0 => cmd = args[i].clone(),
            "--bind" => { c.bind = val(&mut i); c.bind_explicit = true; }
            "--public-url" => c.public_url = Some(val(&mut i)),
            "--agent" => c.agent = val(&mut i),
            "--agent-secret" => c.agent_secret = val(&mut i),
            "--spawn-agent" => c.spawn_agent = true,
            "--relay" => c.relay = Some(val(&mut i)),
            "--public" => reach = Some(true),
            "--local" => reach = Some(false),
            "--data-dir" => c.data = PathBuf::from(val(&mut i)),
            "--name" => c.name = val(&mut i),
            "--control" => c.control = val(&mut i),
            "-h" | "--help" => usage(),
            "-V" | "--version" => {
                println!("supercharge-studio-server {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0)
            }
            a => rest.push(a.to_string()),
        }
        i += 1;
    }
    match reach {
        Some(true) if c.relay.is_none() => c.relay = Some(DEFAULT_RELAY.into()),
        Some(false) => c.relay = None,
        _ => {}
    }
    (cmd, c, rest)
}

/// Built-in public relay used by `--public` (same as the desktop app's Public mode).
pub const DEFAULT_RELAY: &str = "wss://relay.superchargeai.in";

fn hostname() -> String {
    std::env::var("HOSTNAME").ok().or_else(|| std::fs::read_to_string("/etc/hostname").ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Supercharge Server".into())
}

// ---------- storage ----------

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    key: String,
    paired_at: u64,
    #[serde(default)]
    last_seen: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    devices: Vec<Device>,
    #[serde(default)]
    host_id: String,
    #[serde(default)]
    relay_token: String,
    #[serde(default)]
    control_token: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}
fn rand<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("rng");
    b
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn store_path(c: &Config) -> PathBuf {
    c.data.join("state.json")
}
fn load(c: &Config) -> Store {
    let mut s: Store = std::fs::read(store_path(c)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut dirty = false;
    for (f, n) in [(&mut s.host_id, 12usize), (&mut s.relay_token, 32), (&mut s.control_token, 24)] {
        if f.is_empty() {
            *f = hex(&rand::<32>()[..n]);
            dirty = true;
        }
    }
    if dirty {
        save(c, &s);
    }
    s
}
fn save(c: &Config, s: &Store) {
    let _ = std::fs::create_dir_all(&c.data);
    let p = store_path(c);
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap()).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::rename(tmp, p);
    }
}

// ---------- shared state ----------

struct Pairing {
    secret: [u8; 32],
    expires: u64,
    approve: Option<mpsc::UnboundedSender<(String, oneshot::Sender<bool>)>>,
}

struct Shared {
    cfg: Config,
    store: Mutex<Store>,
    pairings: Mutex<HashMap<String, Pairing>>,
    relay_status: Mutex<String>,
}

fn lan_ip() -> String {
    lan_ips().into_iter().next().unwrap_or_else(|| "127.0.0.1".into())
}

use lanaddr::lan_ips;

/// Plain `GET /` (a phone browser) answers "reachable", so users can test the network path.
async fn http_probe(stream: &mut TcpStream) -> bool {
    let mut buf = [0u8; 2048];
    let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(5), stream.peek(&mut buf)).await else { return false };
    let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
    if !head.starts_with("get ") || head.contains("upgrade: websocket") || !head.contains("\r\n\r\n") { return false; }
    let body = "Supercharge Studio gateway is reachable. Pair from the Supercharge Studio app.\n";
    let mut sink = [0u8; 2048];
    let _ = tokio::io::AsyncReadExt::read(stream, &mut sink).await;
    let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
    let _ = stream.shutdown().await;
    true
}

/// Other direct URLs a phone can try when the first one is unreachable.
fn alt_urls(c: &Config) -> Vec<String> {
    if c.public_url.is_some() { return vec![]; }
    let (host, port) = c.bind.rsplit_once(':').unwrap_or((&c.bind, "2420"));
    if host != "0.0.0.0" && host != "[::]" { return vec![]; }
    lan_ips().into_iter().skip(1).map(|h| format!("ws://{h}:{port}/gw")).collect()
}

fn direct_url(c: &Config) -> String {
    if let Some(u) = &c.public_url {
        return u.clone();
    }
    let (host, port) = c.bind.rsplit_once(':').unwrap_or((&c.bind, "2420"));
    let host = if host == "0.0.0.0" || host == "[::]" { lan_ip() } else { host.to_string() };
    format!("ws://{host}:{port}/gw")
}

pub fn pct(s: &str) -> String {
    gwrelay::pct(s)
}

fn pair_uri(sh: &Shared, id: &str, secret: &[u8; 32]) -> String {
    let st = sh.store.lock().unwrap();
    let mut u = format!("scstudio://pair?u={}&i={id}&k={}&n={}", pct(&direct_url(&sh.cfg)), B64URL.encode(secret), pct(&sh.cfg.name));
    let alts = alt_urls(&sh.cfg);
    if !alts.is_empty() {
        u.push_str("&a=");
        u.push_str(&alts.iter().map(|a| pct(a)).collect::<Vec<_>>().join(","));
    }
    if let Some(r) = &sh.cfg.relay {
        u.push_str("&r=");
        u.push_str(&pct(&gwrelay::connect_url(r, &st.host_id)));
    }
    u
}

/// Terminal QR (two rows per character) for the pairing link.
pub fn qr_text(data: &str) -> String {
    let code = match qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::L) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    code.render::<qrcode::render::unicode::Dense1x2>().dark_color(qrcode::render::unicode::Dense1x2::Light).light_color(qrcode::render::unicode::Dense1x2::Dark).quiet_zone(true).build()
}

// ---------- gateway connection ----------

async fn handle<S: AsyncRead + AsyncWrite + Unpin>(sh: Arc<Shared>, mut ws: WebSocketStream<S>) -> Result<(), String> {
    let next_json = |m: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>| -> Result<Value, String> {
        match m {
            Some(Ok(Message::Text(t))) => serde_json::from_str(&t).map_err(|e| e.to_string()),
            _ => Err("expected handshake".into()),
        }
    };
    let t = Duration::from_secs(15);
    let hello = next_json(tokio::time::timeout(t, ws.next()).await.map_err(|_| "timeout")?)?;
    if hello["t"] != "hello" {
        return Err("bad hello".into());
    }
    let id = hello["id"].as_str().unwrap_or("").to_string();
    let name: String = hello["name"].as_str().unwrap_or("Device").chars().take(60).collect();
    let nc = B64.decode(hello["nc"].as_str().unwrap_or("")).map_err(|_| "bad nonce")?;
    if nc.len() != 16 {
        return Err("bad nonce".into());
    }
    let pairing = sh.pairings.lock().unwrap().remove(&id).filter(|p| p.expires >= now());
    let known = sh.store.lock().unwrap().devices.iter().find(|d| d.id == id).and_then(|d| B64.decode(&d.key).ok());
    let key: [u8; 32] = match (&pairing, known) {
        (Some(p), _) => device_key(&p.secret),
        (None, Some(k)) if k.len() == 32 => k.try_into().unwrap(),
        _ => {
            let _ = ws.send(Message::Text(json!({"t":"denied","reason":"unknown device or expired pairing"}).to_string().into())).await;
            return Err("unknown device".into());
        }
    };
    let ns: [u8; 16] = rand();
    ws.send(Message::Text(json!({"t":"challenge","ns":B64.encode(ns)}).to_string().into())).await.map_err(|e| e.to_string())?;
    let auth = next_json(tokio::time::timeout(t, ws.next()).await.map_err(|_| "timeout")?)?;
    let sk = session_key(&key, &nc, &ns);
    let mac = B64.decode(auth["mac"].as_str().unwrap_or("")).unwrap_or_default();
    if auth["t"] != "auth" || !ct_eq(&mac, &hmac(&sk, &[b"client", &nc, &ns])) {
        let _ = ws.send(Message::Text(json!({"t":"denied","reason":"authentication failed"}).to_string().into())).await;
        return Err("auth failed".into());
    }
    let device_id = if let Some(p) = pairing {
        let ok = match p.approve {
            Some(tx) => {
                let (otx, orx) = oneshot::channel();
                let _ = tx.send((name.clone(), otx));
                tokio::time::timeout(Duration::from_secs(PAIR_TTL), orx).await.ok().and_then(|r| r.ok()).unwrap_or(false)
            }
            None => false,
        };
        if !ok {
            let _ = ws.send(Message::Text(json!({"t":"denied","reason":"pairing rejected on the server"}).to_string().into())).await;
            return Err("rejected".into());
        }
        let did = hex(&rand::<8>());
        let mut st = sh.store.lock().unwrap();
        st.devices.push(Device { id: did.clone(), name: name.clone(), key: B64.encode(key), paired_at: now(), last_seen: now() });
        save(&sh.cfg, &st);
        eprintln!("paired device {name} ({did})");
        did
    } else {
        id
    };
    ws.send(Message::Text(json!({"t":"ok","mac":B64.encode(hmac(&sk, &[b"server", &nc, &ns])),"deviceId":device_id}).to_string().into())).await.map_err(|e| e.to_string())?;
    {
        let mut st = sh.store.lock().unwrap();
        if let Some(d) = st.devices.iter_mut().find(|d| d.id == device_id) {
            d.last_seen = now();
        }
        save(&sh.cfg, &st);
    }
    bridge(sh, ws, Channel::new(&sk, true)).await
}

/// Is this phone→agent message allowed? Returns an error reply for refused requests.
pub fn filter(v: &Value) -> Result<(), Value> {
    let Some(method) = v.get("method").and_then(|m| m.as_str()) else { return Ok(()) }; // responses (e.g. permission answers)
    if ALLOWED.contains(&method) {
        return Ok(());
    }
    match v.get("id") {
        Some(id) if method == "_supercharge/focus" => Err(json!({"jsonrpc":"2.0","id":id,"result":null})),
        Some(id) => Err(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("{method} is not available to paired devices")}})),
        None => Err(Value::Null), // drop notifications
    }
}

/// Pipe one authenticated device to its own ACP connection to the agent.
async fn bridge<S: AsyncRead + AsyncWrite + Unpin>(sh: Arc<Shared>, ws: WebSocketStream<S>, mut ch: Channel) -> Result<(), String> {
    let url = format!("{}/ws?server-key={}", sh.cfg.agent.trim_end_matches('/'), pct(&sh.cfg.agent_secret));
    let (agent, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| format!("agent: {e}"))?;
    let (mut asink, mut astream) = agent.split();
    let (mut dsink, mut dstream) = ws.split();
    loop {
        tokio::select! {
            m = dstream.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    let Some(v) = ch.open(&b).ok().and_then(|p| serde_json::from_slice::<Value>(&p).ok()) else { return Err("bad frame".into()) };
                    match filter(&v) {
                        Ok(()) => { asink.send(Message::Text(v.to_string().into())).await.map_err(|e| e.to_string())?; }
                        Err(Value::Null) => {}
                        Err(reply) => { dsink.send(Message::Binary(ch.seal(reply.to_string().as_bytes()).into())).await.map_err(|e| e.to_string())?; }
                    }
                }
                Some(Ok(Message::Ping(p))) => { let _ = dsink.send(Message::Pong(p)).await; }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Ok(()),
                _ => {}
            },
            m = astream.next() => match m {
                Some(Ok(Message::Text(t))) => { dsink.send(Message::Binary(ch.seal(t.as_bytes()).into())).await.map_err(|e| e.to_string())?; }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err("agent closed".into()),
                _ => {}
            },
        }
    }
}

// ---------- control socket (pairing from the CLI) ----------

async fn control(sh: Arc<Shared>) {
    let Ok(l) = TcpListener::bind(&sh.cfg.control).await else {
        eprintln!("control socket {} unavailable; `pair` will not work", sh.cfg.control);
        return;
    };
    while let Ok((sock, _)) = l.accept().await {
        let sh = sh.clone();
        tokio::spawn(async move { let _ = control_conn(sh, sock).await; });
    }
}

async fn control_conn(sh: Arc<Shared>, sock: TcpStream) -> std::io::Result<()> {
    let (r, mut w) = sock.into_split();
    let mut lines = BufReader::new(r).lines();
    let token = sh.store.lock().unwrap().control_token.clone();
    let first = lines.next_line().await?.unwrap_or_default();
    if !ct_eq(first.trim().as_bytes(), format!("AUTH {token}").as_bytes()) {
        w.write_all(b"ERR auth\n").await?;
        return Ok(());
    }
    match lines.next_line().await?.unwrap_or_default().trim() {
        "PAIR" => {
            let id = format!("p-{}", hex(&rand::<8>()));
            let secret: [u8; 32] = rand();
            let (tx, mut rx) = mpsc::unbounded_channel();
            sh.pairings.lock().unwrap().insert(id.clone(), Pairing { secret, expires: now() + PAIR_TTL, approve: Some(tx) });
            w.write_all(format!("URI {}\n", pair_uri(&sh, &id, &secret)).as_bytes()).await?;
            match tokio::time::timeout(Duration::from_secs(PAIR_TTL), rx.recv()).await {
                Ok(Some((name, answer))) => {
                    w.write_all(format!("REQUEST {name}\n").as_bytes()).await?;
                    let a = lines.next_line().await?.unwrap_or_default();
                    let ok = a.trim() == "ALLOW";
                    let _ = answer.send(ok);
                    w.write_all(if ok { b"PAIRED\n" } else { b"REJECTED\n" }).await?;
                }
                _ => {
                    sh.pairings.lock().unwrap().remove(&id);
                    w.write_all(b"EXPIRED\n").await?;
                }
            }
        }
        _ => w.write_all(b"ERR unknown command\n").await?,
    }
    Ok(())
}

async fn cli_pair(c: &Config, yes: bool) -> Result<(), String> {
    let token = load(c).control_token;
    let sock = TcpStream::connect(&c.control).await.map_err(|e| format!("cannot reach the server on {} ({e}); is it running?", c.control))?;
    let (r, mut w) = sock.into_split();
    let mut lines = BufReader::new(r).lines();
    w.write_all(format!("AUTH {token}\nPAIR\n").as_bytes()).await.map_err(|e| e.to_string())?;
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        if let Some(uri) = l.strip_prefix("URI ") {
            println!("{}\nScan with Supercharge Studio on the phone, or open/paste this link there:\n\n  {uri}\n\nExpires in {PAIR_TTL}s, single use. Waiting for the device…", qr_text(uri));
        } else if let Some(name) = l.strip_prefix("REQUEST ") {
            let ok = if yes {
                true
            } else {
                print!("Pair \"{name}\"? It will see your sessions, send prompts and answer permission requests. [y/N] ");
                use std::io::Write;
                let _ = std::io::stdout().flush();
                matches!(stdin.next_line().await.ok().flatten().as_deref().map(str::trim), Some("y" | "Y" | "yes"))
            };
            w.write_all(if ok { b"ALLOW\n" } else { b"DENY\n" }).await.map_err(|e| e.to_string())?;
        } else if l == "PAIRED" {
            println!("Paired.");
            return Ok(());
        } else if l == "REJECTED" || l == "EXPIRED" || l.starts_with("ERR") {
            return Err(l.to_lowercase());
        }
    }
    Err("server closed the connection".into())
}

// ---------- agent ----------

async fn ensure_agent(c: &mut Config) -> Option<tokio::process::Child> {
    let addr = c.agent.trim_start_matches("ws://").trim_start_matches("wss://").trim_end_matches('/').to_string();
    if TcpStream::connect(&addr).await.is_ok() || !c.spawn_agent {
        return None;
    }
    if c.agent_secret.is_empty() {
        c.agent_secret = hex(&rand::<16>());
    }
    let bin = std::env::var("SUPERCHARGE_BIN").unwrap_or_else(|_| "supercharge".into());
    eprintln!("starting `{bin} agent serve --bind {addr}`");
    let child = tokio::process::Command::new(bin).args(["agent", "serve", "--bind", &addr, "--secret", &c.agent_secret]).kill_on_drop(true).spawn().map_err(|e| eprintln!("could not start the agent: {e}")).ok();
    for _ in 0..50 {
        if TcpStream::connect(&addr).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    child
}

async fn run(mut c: Config) -> Result<(), String> {
    let _agent = ensure_agent(&mut c).await;
    let store = load(&c);
    // Prefer the port this server used last time (paired phones remember it), then the configured
    // one; if it is taken (e.g. by another Supercharge process) use the next free port instead of failing.
    let port_file = c.data.join("gateway-port");
    let (host, cfg_port) = portbind::split(&c.bind, 2420);
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let last: Option<u16> = std::fs::read_to_string(&port_file).ok().and_then(|s| s.trim().parse().ok());
    let preferred = if c.bind_explicit { cfg_port } else { last.unwrap_or(cfg_port) };
    let (listener, note) = portbind::bind(&host, preferred).await.map_err(|e| format!("gateway: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    if let Some(n) = &note {
        eprintln!("gateway: {n}");
    }
    let _ = std::fs::create_dir_all(&c.data);
    let _ = std::fs::write(&port_file, port.to_string());
    c.bind = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let sh = Arc::new(Shared { cfg: c.clone(), store: Mutex::new(store), pairings: Mutex::new(HashMap::new()), relay_status: Mutex::new("off".into()) });
    eprintln!("Supercharge Studio Server {} — gateway {} → agent {}", env!("CARGO_PKG_VERSION"), direct_url(&c), c.agent);
    eprintln!("pair a phone with: supercharge-studio-server pair{}", if c.data != parse(&[]).1.data { format!(" --data-dir {}", c.data.display()) } else { String::new() });
    tokio::spawn(control(sh.clone()));
    let (_relay_stop, relay_rx) = oneshot::channel::<()>();
    if let Some(r) = c.relay.clone() {
        let (host, token) = {
            let s = sh.store.lock().unwrap();
            (s.host_id.clone(), s.relay_token.clone())
        };
        let shs = sh.clone();
        let status: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |s: String| {
            eprintln!("relay: {s}");
            *shs.relay_status.lock().unwrap() = s;
        });
        let shl = sh.clone();
        let on_lane: Arc<dyn Fn(gwrelay::Lane) + Send + Sync> = Arc::new(move |lane| {
            let sh = shl.clone();
            tokio::spawn(async move { let _ = handle(sh, lane).await; });
        });
        tokio::spawn(gwrelay::run(r, host, token, status, on_lane, relay_rx));
    }
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => { eprintln!("shutting down"); return Ok(()); }
            acc = listener.accept() => if let Ok((sock, _)) = acc {
                let sh = sh.clone();
                tokio::spawn(async move {
                    let mut sock = sock;
                    if http_probe(&mut sock).await { return; }
                    if let Ok(ws) = tokio_tungstenite::accept_async(sock).await { let _ = handle(sh, ws).await; }
                });
            }
        }
    }
}

#[tokio::main]
async fn main() {
    gwrelay::install_tls();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, c, rest) = parse(&args);
    let r = match cmd.as_str() {
        "pair" => cli_pair(&c, rest.iter().any(|a| a == "--yes")).await,
        "devices" => {
            for d in load(&c).devices {
                println!("{}  {}  paired {}  last seen {}", d.id, d.name, d.paired_at, d.last_seen);
            }
            Ok(())
        }
        "revoke" => {
            let id = rest.first().cloned().unwrap_or_else(|| usage());
            let mut s = load(&c);
            let n = s.devices.len();
            s.devices.retain(|d| d.id != id);
            save(&c, &s);
            if s.devices.len() < n { println!("revoked {id} (restart the server to drop live connections)"); Ok(()) } else { Err(format!("no device {id}")) }
        }
        _ => run(c).await,
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_device_requests() {
        assert!(filter(&json!({"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{}})).is_ok());
        assert!(filter(&json!({"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"cancelled"}}})).is_ok());
        let e = filter(&json!({"jsonrpc":"2.0","id":2,"method":"fs/write_text_file"})).unwrap_err();
        assert_eq!(e["error"]["code"], -32601);
        assert_eq!(filter(&json!({"jsonrpc":"2.0","id":3,"method":"_supercharge/focus"})).unwrap_err()["result"], Value::Null);
        assert_eq!(filter(&json!({"jsonrpc":"2.0","method":"x/notify"})).unwrap_err(), Value::Null);
    }

    #[test]
    fn qr_renders_and_parses_args() {
        assert!(qr_text("scstudio://pair?u=x").lines().count() > 10);
        let (cmd, c, _) = parse(&["pair".into(), "--bind".into(), "127.0.0.1:9".into(), "--relay".into(), "wss://r.example".into()]);
        assert_eq!(cmd, "pair");
        assert_eq!(c.bind, "127.0.0.1:9");
        assert_eq!(direct_url(&c), "ws://127.0.0.1:9/gw");
    }

    #[test]
    fn public_and_local_modes() {
        let (_, c, _) = parse(&["run".into(), "--public".into()]);
        assert_eq!(c.relay.as_deref(), Some(DEFAULT_RELAY));
        let (_, c, _) = parse(&["--relay".into(), "wss://mine.example".into(), "--public".into()]);
        assert_eq!(c.relay.as_deref(), Some("wss://mine.example"));
        let (_, c, _) = parse(&["--relay".into(), "wss://mine.example".into(), "--local".into()]);
        assert_eq!(c.relay, None);
    }

    #[test]
    fn crypto_matches_ts_vectors() {
        let k = device_key(&[7u8; 32]);
        assert_eq!(hex(&k), "a8d2257bae4eb22c5b7c61b326406960c30a2bec5351a33062fb54d24bdca610");
    }
}
