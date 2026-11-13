//! Where the side browser and the AI cursor layer sit in the main window (see place_math.rs).
//! Windows and macOS: one physical-pixel `set_bounds` from the UI's CSS rect × devicePixelRatio.
//! Linux keeps its GTK overlay margins (logical px; see `linux_layout`).

use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect, Runtime};

#[path = "place_math.rs"]
mod math;

/// The browser slot as the UI measured it: CSS px, plus its devicePixelRatio (`scale`;
/// older UIs omit it and get logical placement).
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub scale: Option<f64>,
}

/// Last slot and the window scale factor when it arrived.
static LAST: Mutex<Option<(Bounds, f64)>> = Mutex::new(None);

fn window_scale<R: Runtime>(app: &AppHandle<R>) -> f64 {
    app.get_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(0.0)
}

pub fn remember<R: Runtime>(app: &AppHandle<R>, b: Bounds) {
    *LAST.lock().unwrap() = Some((b, window_scale(app)));
}

/// Last slot in logical px (Linux overlay margins and the cursor layer's fallback).
pub fn logical() -> (f64, f64, f64, f64) {
    LAST.lock().unwrap().map(|(b, _)| (b.x, b.y, b.width, b.height)).unwrap_or((0.0, 0.0, 1.0, 1.0))
}

/// Last slot as a native rect for the current window scale.
pub fn rect<R: Runtime>(app: &AppHandle<R>) -> Rect {
    let last = *LAST.lock().unwrap();
    let Some((b, then)) = last else {
        return Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(1.0, 1.0).into() };
    };
    match math::physical_rect(b.x, b.y, b.width, b.height, b.scale, then, window_scale(app)) {
        Some((x, y, w, h)) => Rect { position: PhysicalPosition::new(x, y).into(), size: PhysicalSize::new(w, h).into() },
        None => Rect { position: LogicalPosition::new(b.x, b.y).into(), size: LogicalSize::new(b.width.max(1.0), b.height.max(1.0)).into() },
    }
}

/// The window's DPI changed (another monitor, or the display scale): re-place both views
/// now instead of waiting for the UI to measure again.
pub fn reapply<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(not(target_os = "linux"))]
    if let Some(wv) = app.get_webview(crate::BROWSER) {
        let _ = wv.set_bounds(rect(app));
    }
    crate::cursor::sync(app);
}
