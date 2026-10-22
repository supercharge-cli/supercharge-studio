//! Supercharge Studio desktop shell.
//! - Attaches to (or starts) a local `supercharge agent serve` for the ACP WebSocket.
//! - Optional ACP stdio transport (`supercharge agent stdio`) bridged over Tauri events.
//! - Side browser webview the agent can see (DOM snapshot) and control (navigate/click/type).

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewBuilder, WebviewUrl,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

pub mod hidden;
mod files;
mod checkpoint;
mod rules;
mod git;
mod portbind;
mod lanaddr;
mod firewall;
mod cliinstall;
mod gateway;
mod gwcrypto;
mod gwrelay;
mod background;
mod uploads;
mod mcp;
mod providers;
mod setup;
mod terminal;
mod pick;
mod screenshot;
mod secrets;
mod agent;
mod updater;

const BROWSER: &str = "browser";

#[derive(Default)]
struct AppState {
    stdio_child: Mutex<Option<Child>>,
    stdio_in: tokio::sync::Mutex<Option<ChildStdin>>,
    eval_seq: AtomicU64,
}

fn agent_bin() -> std::path::PathBuf {
    agent::bin()
}

/// Startup overrides from the environment: SUPERCHARGE_STUDIO_AGENT (host:port) and
/// SUPERCHARGE_AGENT_SECRET. Lets launchers / tests point the app at a specific agent.
#[tauri::command]
fn app_config() -> serde_json::Value {
    serde_json::json!({
        "bind": std::env::var("SUPERCHARGE_STUDIO_AGENT").ok(),
        "secret": std::env::var("SUPERCHARGE_AGENT_SECRET").ok(),
    })
}

/// How this copy was installed, for the updater: appimage, rpm, deb, exe or dmg.
#[tauri::command]
fn host_package() -> String {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            return "appimage".into();
        }
        // Ask the package managers who owns this binary; fall back to the distro family.
        if let Ok(exe) = std::env::current_exe() {
            let owns = |bin: &str, arg: &str| hidden::std_cmd(bin).args([arg]).arg(&exe).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
            if owns("rpm", "-qf") {
                return "rpm".into();
            }
            if owns("dpkg", "-S") {
                return "deb".into();
            }
        }
        let os = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        return if os.contains("fedora") || os.contains("rhel") || os.contains("centos") || os.contains("suse") { "rpm".into() } else { "deb".into() };
    }
    #[cfg(target_os = "windows")]
    { return "exe".into(); }
    #[cfg(target_os = "macos")]
    { return "dmg".into(); }
    #[allow(unreachable_code)]
    "page".into()
}

/// True if something is listening on the agent address.
#[tauri::command]
async fn agent_probe(addr: String) -> bool {
    agent::probe(&addr).await
}

/// Attach if already running; otherwise spawn and supervise `supercharge agent serve`.
/// Returns "attached" or "started"; fails with "AGENT_NOT_FOUND" when the CLI is missing.
#[tauri::command]
async fn agent_start(app: AppHandle, bind: String, secret: String, always_approve: bool) -> Result<String, String> {
    agent::start(app, bind, secret, always_approve).await
}

/// Restart the agent the app started (to pick up provider changes). Returns
/// "restarted", or "external" when the agent was started outside the app.
#[tauri::command]
async fn agent_restart(app: AppHandle, bind: String, secret: String, always_approve: bool) -> Result<String, String> {
    if !agent::managed() {
        return Ok(if agent::probe(&bind).await { "external".into() } else { "stopped".into() });
    }
    agent::stop_now();
    for _ in 0..25 {
        if !agent::probe(&bind).await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    agent::start(app, bind, secret, always_approve).await?;
    Ok("restarted".into())
}

#[tauri::command]
async fn agent_stop() -> Result<(), String> {
    agent::stop_now();
    Ok(())
}

/// Start ACP over stdio. Each stdout line is emitted as `acp-stdio://line`.
#[tauri::command]
async fn stdio_start(app: AppHandle, state: State<'_, AppState>, always_approve: bool) -> Result<(), String> {
    let mut cmd = crate::hidden::cmd(agent_bin());
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

/// Set while the app has hidden the side browser (an overlay covers its area).
/// Moving or reopening the view must not show it again until the app says so.
static BROWSER_HIDDEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn browser_hidden() -> bool { BROWSER_HIDDEN.load(std::sync::atomic::Ordering::SeqCst) }

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
            WebviewBuilder::new(BROWSER, WebviewUrl::External(parsed)).initialization_script(BROWSER_INIT),
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| e.to_string())?;
    if browser_hidden() {
        return browser_apply_visible(&app, false);
    }
    Ok(())
}

/// Linux: GTK packs child webviews into a vertical box, so absolute placement is not
/// available. We wrap the app UI in a gtk::Overlay and place the browser as an overlay
/// child positioned with margins.
#[cfg(target_os = "linux")]
mod linux_layout {
    use gtk::prelude::*;
    use std::cell::RefCell;
    use tauri::Runtime;

    thread_local! {
        static OVERLAY: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
    }

    pub fn wrap_main<R: Runtime>(main: &tauri::Webview<R>) {
        let _ = main.with_webview(|pw| {
            // If the WebKit web process dies, reload instead of leaving a blank window
            // (at most 3 times a minute, so a crash loop does not spin).
            {
                use webkit2gtk::WebViewExt;
                let hits = std::rc::Rc::new(std::cell::RefCell::new(Vec::<std::time::Instant>::new()));
                pw.inner().connect_web_process_terminated(move |v, reason| {
                    eprintln!("supercharge-studio: web process terminated ({reason:?}); reloading");
                    let mut h = hits.borrow_mut();
                    h.retain(|t| t.elapsed() < std::time::Duration::from_secs(60));
                    if h.len() < 3 {
                        h.push(std::time::Instant::now());
                        v.reload();
                    }
                });
            }
            let w: gtk::Widget = pw.inner().upcast();
            let Some(parent) = w.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else { return };
            parent.remove(&w);
            let overlay = gtk::Overlay::new();
            overlay.add(&w);
            parent.pack_start(&overlay, true, true, 0);
            overlay.show_all();
            OVERLAY.with(|o| *o.borrow_mut() = Some(overlay));
        });
    }

    pub fn place<R: Runtime>(browser: &tauri::Webview<R>, x: f64, y: f64, w: f64, h: f64) {
        let _ = browser.with_webview(move |pw| {
            let bw: gtk::Widget = pw.inner().upcast();
            OVERLAY.with(|o| {
                let Some(overlay) = o.borrow().clone() else { return };
                let in_overlay = bw.parent().map(|p| p == overlay.clone().upcast::<gtk::Widget>()).unwrap_or(false);
                if !in_overlay {
                    if let Some(p) = bw.parent().and_then(|p| p.downcast::<gtk::Container>().ok()) {
                        p.remove(&bw);
                    }
                    overlay.add_overlay(&bw);
                }
                bw.set_halign(gtk::Align::Start);
                bw.set_valign(gtk::Align::Start);
                bw.set_margin_start(x.max(0.0) as i32);
                bw.set_margin_top(y.max(0.0) as i32);
                bw.set_size_request(w.max(1.0) as i32, h.max(1.0) as i32);
                if super::browser_hidden() { bw.hide() } else { bw.show() }
            });
        });
    }
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
    #[cfg(target_os = "linux")]
    {
        linux_layout::place(&wv, bounds.x, bounds.y, bounds.width, bounds.height);
        return Ok(());
    }
    #[allow(unreachable_code)]
    wv.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|e| e.to_string())
}

/// Temporarily hide/show the side browser (e.g. while a modal is open: native
/// webviews always draw above the app UI).
#[tauri::command]
async fn browser_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    BROWSER_HIDDEN.store(!visible, std::sync::atomic::Ordering::SeqCst);
    browser_apply_visible(&app, visible)
}

fn browser_apply_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let Some(wv) = app.get_webview(BROWSER) else { return Ok(()) };
    #[cfg(target_os = "linux")]
    {
        let _ = wv.with_webview(move |pw| {
            use gtk::prelude::*;
            let w: gtk::Widget = pw.inner().upcast();
            if visible { w.show() } else { w.hide() }
        });
        return Ok(());
    }
    #[allow(unreachable_code)]
    if visible { wv.show() } else { wv.hide() }.map_err(|e| e.to_string())
}

/// Dev mode capture, injected into every page of the side browser (see browser_init.js).
const BROWSER_INIT: &str = include_str!("browser_init.js");

/// Page zoom of the side browser. Computer mode shows a desktop-size viewport scaled to fit:
/// the view is `width * zoom` wide, so the page lays out at `width` CSS px.
#[tauri::command]
async fn browser_set_zoom(app: AppHandle, zoom: f64) -> Result<(), String> {
    let wv = app.get_webview(BROWSER).ok_or("browser not open")?;
    wv.set_zoom(zoom.clamp(0.1, 4.0)).map_err(|e| e.to_string())
}

/// PNG screenshot of the side browser, base64-encoded.
#[tauri::command]
async fn browser_screenshot(app: AppHandle) -> Result<String, String> {
    use base64::Engine;
    let wv = app.get_webview(BROWSER).ok_or("browser not open")?;
    let png = screenshot::capture(&wv).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

#[tauri::command]
async fn browser_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(BROWSER) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Run a script expression in the side browser and return its JSON result.
/// The script runs asynchronously in the page and stores its outcome on `window`;
/// we poll it with `eval_with_callback`, so pages never get access to app IPC.
#[tauri::command]
async fn browser_eval(app: AppHandle, state: State<'_, AppState>, script: String, timeout_ms: Option<u64>) -> Result<String, String> {
    let wv = app.get_webview(BROWSER).ok_or("browser not open")?;
    let id = state.eval_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let wrapped = format!(
        r#"(async () => {{
  const r = (window.__scResults = window.__scResults || {{}});
  try {{ r[{id}] = JSON.stringify({{ ok: true, value: await (async () => ({script}))() }}); }}
  catch (e) {{ r[{id}] = JSON.stringify({{ ok: false, error: String(e && e.message || e) }}); }}
}})();"#
    );
    wv.eval(&wrapped).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(10_000));
    let probe = format!(
        "(() => {{ const r = window.__scResults || {{}}; const v = r[{id}]; if (v !== undefined) delete r[{id}]; return v === undefined ? null : v; }})()"
    );
    loop {
        let (tx, rx) = oneshot::channel::<String>();
        let tx = Mutex::new(Some(tx));
        wv.eval_with_callback(probe.clone(), move |res| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(res);
            }
        })
        .map_err(|e| e.to_string())?;
        if let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_millis(2000), rx).await {
            // Callback yields the JSON encoding of the JS value: null or a JSON string.
            if let Ok(serde_json::Value::String(payload)) = serde_json::from_str::<serde_json::Value>(&raw) {
                return Ok(payload);
            }
        }
        if std::time::Instant::now() > deadline {
            return Err("browser script timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

static UPLOADS: std::sync::OnceLock<Mutex<uploads::Uploads>> = std::sync::OnceLock::new();
fn uploads_base() -> std::path::PathBuf {
    dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("supercharge-studio")
}

/// One chunk of a file attached on the desktop or uploaded by a paired phone (see uploads.rs).
#[tauri::command]
fn upload_chunk(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut u = UPLOADS.get_or_init(Default::default).lock().unwrap();
    Ok(match u.chunk(&uploads_base(), &params)? {
        Some((id, saved)) => saved.to_json(&id),
        None => serde_json::json!({ "received": params["index"] }),
    })
}

/// Point upload links in a device prompt at the saved files (small images become image blocks).
#[tauri::command]
fn upload_rewrite(mut prompt: serde_json::Value, images: bool) -> serde_json::Value {
    UPLOADS.get_or_init(Default::default).lock().unwrap().rewrite_prompt(&mut prompt, images);
    prompt
}

pub fn run() {
    tauri::Builder::default()
        // A second launch (e.g. from the menu while hidden in the tray) shows the running window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| background::show_main(app)))
        .plugin(tauri_plugin_autostart::Builder::new().args([background::BACKGROUND_ARG]).build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(terminal::Terms::new())
        .setup(|app| {
            // Undo model lock-ins older builds wrote to the agent config (backed up first).
            providers::clean_config_file(&providers::config_path());
            mcp::start(app.handle().clone());
            // One window holding two webviews: the app UI (auto-resized to the window) and,
            // on demand, the side browser placed over the UI's browser slot.
            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("Supercharge Studio")
                .inner_size(1360.0, 860.0)
                .min_inner_size(900.0, 560.0)
                .visible(!background::launched_in_background(std::env::args()))
                .build()?;
            background::setup(app.handle())?;
            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            let _main = window.add_child(
                // HTML5 drag and drop in the UI (file attachments) instead of the native handler.
                WebviewBuilder::new("main-ui", WebviewUrl::App("index.html".into())).auto_resize().disable_drag_drop_handler(),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(size.width, size.height),
            )?;
            #[cfg(target_os = "linux")]
            linux_layout::wrap_main(&_main);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_config, host_package, updater::update_download, updater::update_restart, agent_probe, agent_start, agent_stop, agent::agent_info, agent::agent_log, agent::agent_install, cliinstall::cli_status, cliinstall::cli_install, agent::agent_check, agent::agent_free_port, agent::agent_log_note,
            stdio_start, stdio_send, stdio_stop,
            browser_open, browser_navigate, browser_set_bounds, browser_eval, browser_close, browser_set_visible, browser_screenshot, browser_set_zoom,
            secrets::secret_get, secrets::secret_set, mcp::mcp_result, mcp::mcp_info,
            providers::provider_set_key, providers::provider_has_key, providers::provider_seed_from_env, providers::provider_apply, providers::provider_discover_models, agent_restart,
            setup::setup_status, setup::setup_models, setup::setup_save, setup::setup_device_start, setup::setup_device_poll, setup::setup_device_cancel, setup::setup_open,
            gateway::gateway_status, gateway::gateway_start, gateway::gateway_firewall_allow, gateway::gateway_firewall_check, gateway::gateway_stop, gateway::gateway_pair_begin, gateway::gateway_pair_answer, gateway::gateway_revoke, gateway::gateway_send, gateway::gateway_relay_set,
            files::fs_list,
            checkpoint::checkpoint_create,
            checkpoint::checkpoint_restore,
            rules::rules_list,
            rules::rules_read,
            rules::rules_write, files::fs_read_text, background::background_get, background::background_set, upload_chunk, upload_rewrite,
            terminal::term_open, terminal::term_write, terminal::term_resize, terminal::term_close,
            pick::pick_folder,
            git::git_status, git::git_diff_file, git::git_diff_all, git::git_revert_hunk, git::git_restore_file, git::git_stage, git::git_commit, git::git_branches, git::git_checkout, git::git_push, git::git_open_pr, git::git_worktree_add, git::git_worktree_merge, git::git_worktree_remove
        ])
        .build(tauri::generate_context!())
        .expect("error while running Supercharge Studio")
        .run(|app, ev| match ev {
            // Keep running in the tray: closing the window only hides it.
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" && background::hide_on_close() => {
                api.prevent_close();
                if let Some(w) = app.get_window("main") {
                    let _ = w.hide();
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => background::show_main(app),
            tauri::RunEvent::Exit => agent::stop_now(),
            _ => {}
        });
}
