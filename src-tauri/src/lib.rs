//! Supercharge Studio desktop shell.
//! - Attaches to (or starts) a local `supercharge agent serve` for the ACP WebSocket.
//! - Optional ACP stdio transport (`supercharge agent stdio`) bridged over Tauri events.
//! - Side browser webview the agent can see (DOM snapshot) and control (navigate/click/type).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewBuilder, WebviewUrl,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

const BROWSER: &str = "browser";

#[derive(Default)]
struct AppState {
    serve: Mutex<Option<Child>>,
    stdio_child: Mutex<Option<Child>>,
    stdio_in: tokio::sync::Mutex<Option<ChildStdin>>,
    evals: Mutex<HashMap<u64, oneshot::Sender<String>>>,
    eval_seq: AtomicU64,
}

fn agent_bin() -> String {
    std::env::var("SUPERCHARGE_BIN").unwrap_or_else(|_| "supercharge".into())
}

/// True if something is listening on the agent address.
#[tauri::command]
async fn agent_probe(addr: String) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_millis(800), tokio::net::TcpStream::connect(&addr)).await,
        Ok(Ok(_))
    )
}

/// Attach if already running; otherwise spawn `supercharge agent serve`.
/// Returns "attached" or "started".
#[tauri::command]
async fn agent_start(state: State<'_, AppState>, bind: String, secret: String, always_approve: bool) -> Result<String, String> {
    if agent_probe(bind.clone()).await {
        return Ok("attached".into());
    }
    let mut cmd = Command::new(agent_bin());
    cmd.arg("agent");
    if always_approve {
        cmd.arg("--always-approve");
    }
    cmd.args(["serve", "--bind", &bind, "--secret", &secret])
        .env("SUPERCHARGE_AGENT_SECRET", &secret)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| format!("failed to start `{}`: {e}", agent_bin()))?;
    *state.serve.lock().unwrap() = Some(child);
    for _ in 0..50 {
        if agent_probe(bind.clone()).await {
            return Ok("started".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("agent did not start listening within 10s".into())
}

#[tauri::command]
async fn agent_stop(state: State<'_, AppState>) -> Result<(), String> {
    let child = state.serve.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill().await;
    }
    Ok(())
}

/// Start ACP over stdio. Each stdout line is emitted as `acp-stdio://line`.
#[tauri::command]
async fn stdio_start(app: AppHandle, state: State<'_, AppState>, always_approve: bool) -> Result<(), String> {
    let mut cmd = Command::new(agent_bin());
    cmd.arg("agent");
    if always_approve {
        cmd.arg("--always-approve");
    }
    cmd.arg("stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    *state.stdio_in.lock().await = child.stdin.take();
    *state.stdio_child.lock().unwrap() = Some(child);
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit("acp-stdio://line", line);
        }
        let _ = app.emit("acp-stdio://closed", ());
    });
    Ok(())
}

#[tauri::command]
async fn stdio_send(state: State<'_, AppState>, line: String) -> Result<(), String> {
    let mut guard = state.stdio_in.lock().await;
    let stdin = guard.as_mut().ok_or("stdio not started")?;
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn stdio_stop(state: State<'_, AppState>) -> Result<(), String> {
    *state.stdio_in.lock().await = None;
    let child = state.stdio_child.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill().await;
    }
    Ok(())
}

#[derive(Deserialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Create (or move) the side browser as a child webview of the main window.
#[tauri::command]
async fn browser_open(app: AppHandle, url: String, bounds: Bounds) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e: url_err::E| e.to_string())?;
    if let Some(wv) = app.get_webview(BROWSER) {
        wv.navigate(parsed).map_err(|e| e.to_string())?;
        return browser_set_bounds(app, bounds).await;
    }
    let window = app.get_window("main").ok_or("no main window")?;
    window
        .add_child(
            WebviewBuilder::new(BROWSER, WebviewUrl::External(parsed)),
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

mod url_err {
    pub type E = <tauri::Url as std::str::FromStr>::Err;
}

#[tauri::command]
async fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let wv = app.get_webview(BROWSER).ok_or("browser not open")?;
    let parsed: Url = url.parse().map_err(|e: url_err::E| e.to_string())?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
async fn browser_set_bounds(app: AppHandle, bounds: Bounds) -> Result<(), String> {
    let wv = app.get_webview(BROWSER).ok_or("browser not open")?;
    wv.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn browser_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(BROWSER) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Run a script expression in the side browser and return its JSON result.
/// The page reports back through `browser_result` (the only command it may call).
#[tauri::command]
async fn browser_eval(app: AppHandle, state: State<'_, AppState>, script: String, timeout_ms: Option<u64>) -> Result<String, String> {
    let wv = app.get_webview(BROWSER).ok_or("browser not open")?;
    let id = state.eval_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    state.evals.lock().unwrap().insert(id, tx);
    let wrapped = format!(
        r#"(async () => {{
  let out;
  try {{ out = {{ ok: true, value: await (async () => ({script}))() }}; }}
  catch (e) {{ out = {{ ok: false, error: String(e && e.message || e) }}; }}
  window.__TAURI_INTERNALS__.invoke("browser_result", {{ id: {id}, payload: JSON.stringify(out) }});
}})();"#
    );
    wv.eval(&wrapped).map_err(|e| e.to_string())?;
    match tokio::time::timeout(Duration::from_millis(timeout_ms.unwrap_or(10_000)), rx).await {
        Ok(Ok(v)) => Ok(v),
        _ => {
            state.evals.lock().unwrap().remove(&id);
            Err("browser script timed out".into())
        }
    }
}

#[tauri::command]
fn browser_result(state: State<'_, AppState>, id: u64, payload: String) {
    if let Some(tx) = state.evals.lock().unwrap().remove(&id) {
        let _ = tx.send(payload);
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            agent_probe, agent_start, agent_stop,
            stdio_start, stdio_send, stdio_stop,
            browser_open, browser_navigate, browser_set_bounds, browser_eval, browser_close,
            browser_result
        ])
        .run(tauri::generate_context!())
        .expect("error while running Supercharge Studio");
}
