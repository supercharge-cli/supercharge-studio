//! AI cursor: a transparent native layer stacked above the side browser that shows where
//! the agent points, clicks, types and scrolls. It is a separate webview, so the page
//! under it can never see or script it. It has no IPC (no capability lists it); the
//! user's own mouse is reported by a navigation to a sentinel host that we cancel here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewBuilder, WebviewUrl};

pub const CURSOR: &str = "browser-cursor";
pub const TAKEOVER_HOST: &str = "takeover.supercharge.invalid";
const CURSOR_JS: &str = include_str!("cursor.js");

/// Last side browser bounds (logical px), so the layer can be created over it.
static BOUNDS: Mutex<(f64, f64, f64, f64)> = Mutex::new((0.0, 0.0, 1.0, 1.0));
/// The agent is acting: the layer should be shown (when the browser is).
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn remember(x: f64, y: f64, w: f64, h: f64) {
    *BOUNDS.lock().unwrap() = (x, y, w, h);
}

/// True when a navigation is the layer reporting that the user took over.
pub fn is_takeover(url: &tauri::Url) -> bool {
    url.host_str() == Some(TAKEOVER_HOST)
}

/// Put the layer over the browser, shown only while the agent acts and the browser shows.
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let Some(wv) = app.get_webview(CURSOR) else { return };
    let (x, y, w, h) = *BOUNDS.lock().unwrap();
    let show = ACTIVE.load(Ordering::SeqCst) && !crate::browser_hidden() && app.get_webview(crate::BROWSER).is_some();
    #[cfg(target_os = "linux")]
    {
        crate::linux_layout::place(&wv, x, y, w, h, show);
        return;
    }
    #[allow(unreachable_code)]
    {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(w, h));
        let _ = if show { wv.show() } else { wv.hide() };
    }
}

/// Drop the layer (the browser closed, or a new browser view is about to be stacked).
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Some(wv) = app.get_webview(CURSOR) {
        let _ = wv.close();
    }
}

fn took_over<R: Runtime>(app: &AppHandle<R>) {
    ACTIVE.store(false, Ordering::SeqCst);
    sync(app);
    let _ = app.emit("browser-takeover", ());
}

/// Show the AI cursor action `op` (move, click, type, key, scroll, hover) at view
/// coordinates `x`,`y` (logical px inside the browser), or hide the layer (`hide`).
#[tauri::command]
pub async fn browser_cursor(app: AppHandle, op: String, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    if op == "hide" {
        ACTIVE.store(false, Ordering::SeqCst);
        sync(&app);
        return Ok(());
    }
    if app.get_webview(crate::BROWSER).is_none() {
        return Ok(());
    }
    let msg = serde_json::json!({ "op": op, "x": x, "y": y });
    ACTIVE.store(true, Ordering::SeqCst);
    if let Some(wv) = app.get_webview(CURSOR) {
        sync(&app);
        return wv.eval(format!("window.__cur&&window.__cur({msg})")).map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let (bx, by, bw, bh) = *BOUNDS.lock().unwrap();
    let handle = app.clone();
    window
        .add_child(
            WebviewBuilder::new(CURSOR, WebviewUrl::App("cursor.html".into()))
                .transparent(true)
                .focused(false)
                .initialization_script(format!("window.__init={msg};\n{CURSOR_JS}"))
                .on_navigation(move |url| {
                    if is_takeover(url) {
                        let a = handle.clone();
                        tauri::async_runtime::spawn(async move { took_over(&a) });
                        return false;
                    }
                    // Only the layer's own page may load here.
                    url.path().ends_with("cursor.html")
                }),
            LogicalPosition::new(bx, by),
            LogicalSize::new(bw, bh),
        )
        .map_err(|e| e.to_string())?;
    sync(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_is_only_the_sentinel_host() {
        assert!(is_takeover(&"https://takeover.supercharge.invalid/".parse().unwrap()));
        assert!(!is_takeover(&"https://example.com/takeover.supercharge.invalid".parse().unwrap()));
        assert!(!is_takeover(&"tauri://localhost/cursor.html".parse().unwrap()));
    }

    #[test]
    fn layer_script_has_no_ipc_and_reports_by_navigation() {
        assert!(!CURSOR_JS.contains("__TAURI"));
        assert!(CURSOR_JS.contains(TAKEOVER_HOST));
        assert!(CURSOR_JS.contains("prefers-reduced-motion"));
        assert!(CURSOR_JS.contains("Supercharge is browsing"));
    }
}
