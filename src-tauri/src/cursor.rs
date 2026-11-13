//! AI cursor: a transparent native layer stacked above the side browser that shows where
//! the agent points, clicks, types and scrolls. It is a separate webview, so the page
//! under it can never see or script it. It has no IPC (no capability lists it); the
//! user's own mouse is reported by a navigation to a sentinel host that we cancel here.
//!
//! macOS and Linux: a transparent child webview of the main window, over the browser.
//! Windows: a transparent, borderless, non-activating window owned by the main window and
//! kept over the browser slot in screen pixels. Two child webviews in one window are
//! sibling native windows there, and one drawn transparently over another is not reliably
//! composited: the browser paints over (or shows through) the layer. That is why the
//! cursor vanished once the browser sat exactly in the pane (1.0.41); before, the two
//! only partly overlapped. Top-level windows are composited with per-pixel alpha, and an
//! owned window always stays above its owner (and hides with it when minimized).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl};

pub const CURSOR: &str = "browser-cursor";
pub const TAKEOVER_HOST: &str = "takeover.supercharge.invalid";
const CURSOR_JS: &str = include_str!("cursor.js");

/// The agent is acting: the layer should be shown (when the browser is).
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// True when a navigation is the layer reporting that the user took over.
pub fn is_takeover(url: &tauri::Url) -> bool {
    url.host_str() == Some(TAKEOVER_HOST)
}

fn wanted<R: Runtime>(app: &AppHandle<R>, main_showing: bool) -> bool {
    crate::place::layer_shown(ACTIVE.load(Ordering::SeqCst), app.get_webview(crate::BROWSER).is_some(), crate::browser_hidden(), main_showing)
}

/// Put the layer over the browser, shown only while the agent acts and the browser shows.
#[cfg(target_os = "linux")]
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let Some(wv) = app.get_webview(CURSOR) else { return };
    let (x, y, w, h) = crate::place::logical();
    crate::linux_layout::place(&wv, x, y, w, h, wanted(app, true));
}

/// Put the layer over the browser, shown only while the agent acts and the browser shows.
#[cfg(not(any(target_os = "linux", windows)))]
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let Some(wv) = app.get_webview(CURSOR) else { return };
    // Same rect as the browser (one call: no half-applied move), so the cursor lines up.
    let _ = wv.set_bounds(crate::place::rect(app));
    let _ = if wanted(app, true) { wv.show() } else { wv.hide() };
}

/// Put the layer window over the browser slot on screen, shown only while the agent acts,
/// the browser shows and the main window is on screen. Never takes focus.
#[cfg(windows)]
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let Some(layer) = app.get_webview_window(CURSOR) else { return };
    let Some(main) = app.get_window("main") else { return };
    let main_showing = main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(false);
    let at = match (wanted(app, main_showing), crate::place::physical(app), main.inner_position()) {
        (true, Some(slot), Ok(o)) => Some(crate::place::on_screen((o.x, o.y), slot)),
        _ => None,
    };
    let Ok(hwnd) = layer.hwnd() else { return };
    // Raw handle as an integer: it crosses to the main thread, which owns the window.
    let raw = hwnd.0 as isize;
    let _ = app.run_on_main_thread(move || win::place(raw, at));
}

#[cfg(windows)]
mod win {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE,
    };

    /// Move and show the layer without activating it, or hide it (`None`).
    pub fn place(raw: isize, at: Option<(i32, i32, u32, u32)>) {
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        unsafe {
            match at {
                Some((x, y, w, h)) => {
                    let flags = SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER;
                    // Twice: moving onto a monitor with another scale makes the window resize
                    // itself for the new DPI during the first call; the second restores the rect.
                    let _ = SetWindowPos(hwnd, None, x, y, w as i32, h as i32, flags);
                    let _ = SetWindowPos(hwnd, None, x, y, w as i32, h as i32, flags);
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                }
                None => {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                }
            }
        }
    }
}

/// Drop the layer (the browser closed, or a new browser view is about to be stacked).
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    ACTIVE.store(false, Ordering::SeqCst);
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window(CURSOR) {
        let _ = w.destroy();
    }
    #[cfg(not(windows))]
    if let Some(wv) = app.get_webview(CURSOR) {
        let _ = wv.close();
    }
}

fn took_over<R: Runtime>(app: &AppHandle<R>) {
    ACTIVE.store(false, Ordering::SeqCst);
    sync(app);
    let _ = app.emit("browser-takeover", ());
}

/// The layer may only load its own page; the sentinel host reports the user taking over.
fn navigation<R: Runtime>(app: &AppHandle<R>) -> impl Fn(&tauri::Url) -> bool + Send + 'static {
    let handle = app.clone();
    move |url| {
        if is_takeover(url) {
            let a = handle.clone();
            tauri::async_runtime::spawn(async move { took_over(&a) });
            return false;
        }
        url.path().ends_with("cursor.html")
    }
}

#[cfg(not(windows))]
fn create(app: &AppHandle, init: String) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    let at = crate::place::rect(app);
    window
        .add_child(
            tauri::WebviewBuilder::new(CURSOR, WebviewUrl::App("cursor.html".into()))
                .transparent(true)
                .focused(false)
                .initialization_script(init)
                .on_navigation(navigation(app)),
            at.position,
            at.size,
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn create(app: &AppHandle, init: String) -> Result<(), String> {
    let main = app.get_window("main").ok_or("no main window")?;
    let owner = main.hwnd().map_err(|e| e.to_string())?;
    tauri::WebviewWindowBuilder::new(app, CURSOR, WebviewUrl::App("cursor.html".into()))
        .title("Supercharge cursor")
        .owner_raw(owner)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .initialization_script(init)
        .on_navigation(navigation(app))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
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
    create(&app, format!("window.__init={msg};\n{CURSOR_JS}"))?;
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

    #[test]
    fn layer_page_is_see_through_so_only_the_cursor_and_label_draw() {
        // Windows draws the layer as its own window composited with per-pixel alpha, so the
        // page must have no opaque background or it would cover the browser.
        let html = include_str!("../../public/cursor.html");
        assert!(html.contains("background:transparent"));
        assert!(!html.contains("<script"), "behaviour comes only from the init script (no IPC)");
    }
}
