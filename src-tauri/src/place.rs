//! Where the side browser and the AI cursor layer sit in the main window (see place_math.rs).
//! Windows and macOS: one physical-pixel `set_bounds` from the UI's CSS rect × devicePixelRatio.
//! Linux keeps its GTK overlay margins (logical px; see `linux_layout`).

use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect, Runtime};

#[path = "place_math.rs"]
#[allow(dead_code)] // `on_screen` is only used on Windows
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

/// Last slot in the main window's physical client pixels, `None` before the UI has sent one
/// (or when the window scale cannot be read and the UI sent no ratio).
pub fn physical<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32, u32, u32)> {
    let (b, then) = (*LAST.lock().unwrap())?;
    let now = window_scale(app);
    match b.scale {
        Some(_) => math::physical_rect(b.x, b.y, b.width, b.height, b.scale, then, now),
        // An older UI without the ratio: logical px times the window scale.
        None => math::physical_rect(b.x, b.y, b.width, b.height, Some(now), now, now),
    }
}

/// Last slot as a native rect for the current window scale.
pub fn rect<R: Runtime>(app: &AppHandle<R>) -> Rect {
    if let Some((x, y, w, h)) = physical(app) {
        return Rect { position: PhysicalPosition::new(x, y).into(), size: PhysicalSize::new(w, h).into() };
    }
    let (x, y, w, h) = logical();
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
}

pub use math::layer_shown;
#[cfg(windows)]
pub use math::on_screen;

/// The window's DPI changed (another monitor, or the display scale): re-place both views
/// now instead of waiting for the UI to measure again.
pub fn reapply<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(not(target_os = "linux"))]
    if let Some(wv) = app.get_webview(crate::BROWSER) {
        let _ = wv.set_bounds(rect(app));
    }
    crate::cursor::sync(app);
}
