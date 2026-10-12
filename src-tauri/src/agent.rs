//! Managed `supercharge agent serve`: binary discovery (GUI launches often have a minimal PATH),
//! start + readiness wait, crash restart with backoff, stderr/stdout captured to a log file,
//! shutdown on exit when the app started it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::process::{Child, Command};

static BIN: Mutex<Option<PathBuf>> = Mutex::new(None);
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
/// Bumped on every start/stop so stale supervisors exit.
static GEN: AtomicU64 = AtomicU64::new(0);

const EXE: &str = if cfg!(windows) { "supercharge.exe" } else { "supercharge" };

fn is_exe(p: &Path) -> bool {
    p.is_file()
}

/// Directories checked in addition to PATH.
pub fn candidate_dirs() -> Vec<PathBuf> {
    let mut v = vec![];
    if let Some(h) = dirs::home_dir() {
        v.push(h.join(".local/bin"));
        v.push(h.join(".supercharge/bin"));
        v.push(h.join(".cargo/bin"));
        v.push(h.join("bin"));
    }
    if cfg!(windows) {
        if let Some(d) = dirs::data_local_dir() {
            v.push(d.join("supercharge").join("bin"));
            v.push(d.join("Programs").join("supercharge"));
        }
    } else {
        for d in ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/opt/supercharge/bin", "/snap/bin"] {
            v.push(PathBuf::from(d));
        }
    }
    v
}

/// Look `supercharge` up the way a terminal would, for apps launched from a desktop entry.
#[cfg(unix)]
fn login_shell_lookup() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let mut c = std::process::Command::new(shell)
        .args(["-lic", "command -v supercharge"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = std::time::Instant::now();
    loop {
        match c.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = c.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    use std::io::Read;
    c.stdout.take()?.read_to_string(&mut out).ok()?;
    let p = PathBuf::from(out.lines().map(str::trim).rfind(|l| l.starts_with('/'))?);
    is_exe(&p).then_some(p)
}
#[cfg(not(unix))]
fn login_shell_lookup() -> Option<PathBuf> {
    None
}

pub fn find_in(path_var: Option<&std::ffi::OsStr>, extra: &[PathBuf]) -> Option<PathBuf> {
    path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        .chain(extra.iter().cloned())
        .map(|d| d.join(EXE))
        .find(|p| is_exe(p))
}

/// Resolve the CLI: SUPERCHARGE_BIN, PATH, well-known dirs, then a login-shell lookup. Cached.
pub fn resolve() -> Option<PathBuf> {
    if let Some(p) = BIN.lock().unwrap().clone().filter(|p| is_exe(p)) {
        return Some(p);
    }
    let found = std::env::var_os("SUPERCHARGE_BIN")
        .map(PathBuf::from)
        .filter(|p| is_exe(p))
        .or_else(|| find_in(std::env::var_os("PATH").as_deref(), &candidate_dirs()))
        .or_else(login_shell_lookup);
    *BIN.lock().unwrap() = found.clone();
    found
}

/// Program to run: the resolved path, or the bare name as a last resort.
pub fn bin() -> PathBuf {
    resolve().unwrap_or_else(|| PathBuf::from(EXE))
}

fn log_path() -> PathBuf {
    let d = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("supercharge-studio");
    let _ = std::fs::create_dir_all(&d);
    d.join("agent.log")
}

fn open_log() -> Option<std::fs::File> {
    let p = log_path();
    if std::fs::metadata(&p).map(|m| m.len() > 2 << 20).unwrap_or(false) {
        let _ = std::fs::rename(&p, p.with_extension("log.1"));
    }
    std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
}

pub fn log_line(s: &str) {
    if let Some(mut f) = open_log() {
        use std::io::Write;
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[studio {t}] {s}");
    }
}

pub async fn probe(addr: &str) -> bool {
    matches!(tokio::time::timeout(Duration::from_millis(800), tokio::net::TcpStream::connect(addr)).await, Ok(Ok(_)))
}

fn status(app: &AppHandle, s: &str) {
    let _ = app.emit("agent://status", s);
}

async fn spawn_once(bind: &str, secret: &str, approve: bool) -> Result<(), String> {
    let exe = resolve().ok_or("AGENT_NOT_FOUND")?;
    let mut cmd = Command::new(&exe);
    cmd.arg("agent");
    if approve {
        cmd.arg("--always-approve");
    }
    cmd.args(["serve", "--bind", bind, "--secret", secret])
        .env("SUPERCHARGE_AGENT_SECRET", secret)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    // Linux: the agent dies with the app even if the app is killed (no orphaned agents).
    #[cfg(target_os = "linux")]
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    // The child inherits a PATH that includes the CLI's own directory.
    if let Some(dir) = exe.parent() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&path))).ok();
        if let Some(j) = joined {
            cmd.env("PATH", j);
        }
    }
    match (open_log(), open_log()) {
        (Some(o), Some(e)) => cmd.stdout(Stdio::from(o)).stderr(Stdio::from(e)),
        _ => cmd.stdout(Stdio::null()).stderr(Stdio::null()),
    };
    log_line(&format!("starting {} agent serve --bind {bind}", exe.display()));
    let mut child = cmd.spawn().map_err(|e| format!("failed to start {}: {e}", exe.display()))?;
    for _ in 0..75 {
        if probe(bind).await {
            *CHILD.lock().unwrap() = Some(child);
            return Ok(());
        }
        if let Ok(Some(st)) = child.try_wait() {
            log_line(&format!("agent exited during startup: {st}"));
            return Err(format!("the agent exited during startup ({st}); see Settings → Connection → Agent log"));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = child.kill().await;
    Err("the agent did not start listening within 15s; see Settings → Connection → Agent log".into())
}

/// Attach if something already listens on `bind`; otherwise start and supervise the agent.
pub async fn start(app: AppHandle, bind: String, secret: String, approve: bool) -> Result<String, String> {
    if probe(&bind).await {
        log_line(&format!("attaching to the agent already listening on {bind}"));
        return Ok("attached".into());
    }
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    status(&app, "starting");
    spawn_once(&bind, &secret, approve).await?;
    status(&app, "ready");
    tauri::async_runtime::spawn(async move {
        let mut fails = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            let exited = match CHILD.lock().unwrap().as_mut() {
                Some(c) => c.try_wait().ok().flatten(),
                None => return,
            };
            let Some(st) = exited else { fails = 0; continue };
            log_line(&format!("agent exited: {st}; restarting"));
            *CHILD.lock().unwrap() = None;
            if probe(&bind).await {
                return; // someone else took the port
            }
            fails += 1;
            if fails > 5 {
                status(&app, "crashed");
                return;
            }
            status(&app, "restarting");
            tokio::time::sleep(Duration::from_secs((1u64 << fails).min(30))).await;
            if GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            match spawn_once(&bind, &secret, approve).await {
                Ok(()) => status(&app, "ready"),
                Err(e) => log_line(&format!("restart failed: {e}")),
            }
        }
    });
    Ok("started".into())
}

pub fn managed() -> bool {
    CHILD.lock().unwrap().is_some()
}

pub fn stop_now() {
    GEN.fetch_add(1, Ordering::SeqCst);
    if let Some(mut c) = CHILD.lock().unwrap().take() {
        let _ = c.start_kill();
    }
}

/// Try a WebSocket upgrade with `secret`: "ok" (101), "rejected" (401/403), "unreachable",
/// or "other:<status>". Bounded to 3 s; every attempt is logged.
pub async fn check(bind: &str, secret: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let r = tokio::time::timeout(Duration::from_secs(3), async {
        let mut s = tokio::net::TcpStream::connect(bind).await.map_err(|_| "unreachable".to_string())?;
        let key: String = secret.bytes().map(|b| format!("%{b:02X}")).collect();
        let req = format!("GET /ws?server-key={key} HTTP/1.1\r\nHost: {bind}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
        s.write_all(req.as_bytes()).await.map_err(|_| "unreachable".to_string())?;
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf).await.map_err(|_| "unreachable".to_string())?;
        let line = String::from_utf8_lossy(&buf[..n]).to_string();
        let code = line.split_whitespace().nth(1).unwrap_or("").to_string();
        Ok::<String, String>(match code.as_str() {
            "101" => "ok".into(),
            "401" | "403" => "rejected".into(),
            c => format!("other:{c}"),
        })
    })
    .await;
    let out = match r {
        Ok(Ok(v)) | Ok(Err(v)) => v,
        Err(_) => "unreachable".into(),
    };
    log_line(&format!("attach check ws://{bind}/ws: {out}"));
    out
}

#[tauri::command]
pub async fn agent_check(bind: String, secret: String) -> String {
    check(&bind, &secret).await
}

/// First free loopback port from 2420 upward (then an ephemeral one), as "127.0.0.1:<port>".
#[tauri::command]
pub fn agent_free_port() -> String {
    let ok = |p: u16| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok();
    let p = (2420..2440).find(|&p| ok(p)).unwrap_or_else(|| {
        std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(2420)
    });
    format!("127.0.0.1:{p}")
}

#[tauri::command]
pub fn agent_log_note(line: String) {
    log_line(&line);
}

#[tauri::command]
pub fn agent_info() -> serde_json::Value {
    *BIN.lock().unwrap() = None; // re-resolve (the user may have just installed it)
    serde_json::json!({ "bin": resolve().map(|p| p.display().to_string()), "managed": managed(), "log": log_path().display().to_string() })
}

#[tauri::command]
pub fn agent_log() -> String {
    let s = std::fs::read(log_path()).unwrap_or_default();
    let tail = &s[s.len().saturating_sub(64 * 1024)..];
    String::from_utf8_lossy(tail).into_owned()
}

/// Run the official installer (Linux/macOS), logging to the agent log.
#[tauri::command]
pub async fn agent_install() -> Result<String, String> {
    if cfg!(windows) {
        return Err("Install the Supercharge CLI from https://superchargeai.in, then click Retry.".into());
    }
    log_line("running the Supercharge CLI installer");
    let (Some(o), Some(e)) = (open_log(), open_log()) else { return Err("cannot open the log".into()) };
    let st = Command::new("sh")
        .args(["-c", "curl -fsSL https://superchargeai.in/install.sh | bash"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(o))
        .stderr(Stdio::from(e))
        .status()
        .await
        .map_err(|e| e.to_string())?;
    *BIN.lock().unwrap() = None;
    match (st.success(), resolve()) {
        (true, Some(p)) => Ok(p.display().to_string()),
        (true, None) => Err("installed, but the `supercharge` binary was not found; set SUPERCHARGE_BIN".into()),
        _ => Err(format!("installer failed ({st}); see the agent log")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn check_distinguishes_rejected_ok_unreachable() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let mut b = [0u8; 512];
                let n = s.read(&mut b).await.unwrap();
                let ok = String::from_utf8_lossy(&b[..n]).contains("server-key=%72%69%67%68%74");
                let _ = s.write_all(if ok { b"HTTP/1.1 101 Switching\r\n\r\n" } else { b"HTTP/1.1 401 Unauthorized\r\n\r\n" }).await;
            }
        });
        assert_eq!(check(&addr, "right").await, "ok");
        assert_eq!(check(&addr, "wrong").await, "rejected");
        assert_eq!(check("127.0.0.1:9", "x").await, "unreachable");
    }
    #[test]
    fn finds_in_extra_dirs_when_path_is_minimal() {
        let d = std::env::temp_dir().join(format!("scs-bin-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(EXE), b"").unwrap();
        assert_eq!(find_in(Some(std::ffi::OsStr::new("/nonexistent")), &[d.clone()]), Some(d.join(EXE)));
        assert_eq!(find_in(Some(std::ffi::OsStr::new("/nonexistent")), &[]), None);
        let _ = std::fs::remove_dir_all(d);
    }
}
