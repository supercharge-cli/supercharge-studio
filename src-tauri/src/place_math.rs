//! Pure math for placing the side browser (and the AI cursor layer above it) over the app
//! UI's browser slot. No Tauri types, so it is tested on its own (`rustc --test`).
//!
//! The UI measures the slot in CSS px together with its `devicePixelRatio`. CSS px times
//! devicePixelRatio is the slot in the window's physical pixels, whatever the monitor scale
//! or the UI's page zoom. Placing by that physical rect avoids two Windows failure modes:
//! a child view converting logical px with a stale or default (100%) DPI, and a size update
//! re-reading a position that an asynchronous move has not applied yet.

/// Physical rect `(x, y, width, height)` for a slot measured at `x, y, w, h` CSS px with
/// devicePixelRatio `css_scale`, when the window scale factor was `win_then` and is now
/// `win_now`. The UI's page zoom (`css_scale / win_then`) is kept; the monitor part follows
/// the window, so a DPI change re-places the view before the UI measures again. Edges are
/// rounded (not the size), so the view never drifts by a pixel from the slot.
/// `None` when `css_scale` is missing or invalid (place in logical px instead).
pub fn physical_rect(x: f64, y: f64, w: f64, h: f64, css_scale: Option<f64>, win_then: f64, win_now: f64) -> Option<(i32, i32, u32, u32)> {
    let ok = |v: f64| v.is_finite() && v > 0.0;
    let s = css_scale.filter(|s| ok(*s))?;
    if ![x, y, w, h].iter().all(|v| v.is_finite()) {
        return None;
    }
    let k = if ok(win_then) && ok(win_now) { s / win_then * win_now } else { s };
    let (x0, y0) = ((x * k).round(), (y * k).round());
    let (x1, y1) = (((x + w.max(0.0)) * k).round(), ((y + h.max(0.0)) * k).round());
    Some((x0 as i32, y0 as i32, (x1 - x0).max(1.0) as u32, (y1 - y0).max(1.0) as u32))
}

/// Windows: the AI cursor layer is its own top-level window (child views cannot be stacked
/// with transparency there), so its rect is in screen pixels: the main window's client
/// origin on screen plus the slot's physical rect inside the client area.
pub fn on_screen(client_origin: (i32, i32), slot: (i32, i32, u32, u32)) -> (i32, i32, u32, u32) {
    (client_origin.0.saturating_add(slot.0), client_origin.1.saturating_add(slot.1), slot.2, slot.3)
}

/// Whether the AI cursor layer should be on screen: the agent is acting, the side browser
/// exists and is not hidden by the app, and the main window itself is showing (Windows: the
/// layer is a separate window, so it must not linger over the desktop when the app is in
/// the tray or minimized).
pub fn layer_shown(agent_acting: bool, browser_open: bool, browser_hidden: bool, main_showing: bool) -> bool {
    agent_acting && browser_open && !browser_hidden && main_showing
}

#[cfg(test)]
mod tests {
    use super::physical_rect as p;
    use super::{layer_shown, on_screen, physical_rect};

    #[test]
    fn css_px_times_device_pixel_ratio() {
        assert_eq!(p(637.0, 135.0, 387.0, 410.0, Some(1.0), 1.0, 1.0), Some((637, 135, 387, 410)));
        // Windows at 125%: a slot at CSS x=637 is at physical x≈796, never at 637 or 510.
        assert_eq!(p(637.0, 135.0, 387.0, 410.0, Some(1.25), 1.25, 1.25), Some((796, 169, 484, 512)));
        assert_eq!(p(10.0, 20.0, 300.0, 200.0, Some(1.5), 1.5, 1.5), Some((15, 30, 450, 300)));
        assert_eq!(p(10.0, 20.0, 300.0, 200.0, Some(2.0), 2.0, 2.0), Some((20, 40, 600, 400)));
    }

    #[test]
    fn page_zoom_of_the_ui_is_honoured() {
        // UI zoomed to 125% on a 100% monitor: CSS px are 1.25 physical px.
        assert_eq!(p(100.0, 50.0, 200.0, 100.0, Some(1.25), 1.0, 1.0), Some((125, 63, 250, 125)));
    }

    #[test]
    fn dpi_change_before_the_ui_measures_again() {
        // Measured at 100%, the window moved to a 150% monitor: follow the new monitor scale.
        assert_eq!(p(100.0, 50.0, 200.0, 100.0, Some(1.0), 1.0, 1.5), Some((150, 75, 300, 150)));
        // Measured at 150% with no zoom, back to 100%.
        assert_eq!(p(100.0, 50.0, 200.0, 100.0, Some(1.5), 1.5, 1.0), Some((100, 50, 200, 100)));
        // Unknown window scale: trust the UI's ratio.
        assert_eq!(p(100.0, 50.0, 200.0, 100.0, Some(1.5), 0.0, f64::NAN), Some((150, 75, 300, 150)));
    }

    #[test]
    fn edges_are_rounded_so_adjacent_slots_do_not_gap() {
        // 1.25 × 10.5 = 13.125 → 13; right edge 1.25 × 110.9 = 138.625 → 139: width 126.
        assert_eq!(p(10.5, 0.0, 100.4, 10.0, Some(1.25), 1.25, 1.25), Some((13, 0, 126, 13)));
    }

    #[test]
    fn degenerate_or_missing_input() {
        assert_eq!(p(0.0, 0.0, 300.0, 200.0, None, 1.0, 1.0), None);
        assert_eq!(p(0.0, 0.0, 300.0, 200.0, Some(0.0), 1.0, 1.0), None);
        assert_eq!(p(0.0, 0.0, 300.0, 200.0, Some(f64::NAN), 1.0, 1.0), None);
        assert_eq!(p(f64::INFINITY, 0.0, 300.0, 200.0, Some(1.0), 1.0, 1.0), None);
        // A collapsed slot still gets a 1×1 view (the native API rejects 0).
        assert_eq!(p(5.0, 5.0, 0.0, -3.0, Some(1.25), 1.25, 1.25), Some((6, 6, 1, 1)));
    }

    #[test]
    fn cursor_layer_window_sits_exactly_over_the_browser_slot_on_screen() {
        // Main window client area at (200, 100) on screen, 125% display, slot 637,135 387x410 CSS px.
        let slot = physical_rect(637.0, 135.0, 387.0, 410.0, Some(1.25), 1.25, 1.25).unwrap();
        assert_eq!(slot, (796, 169, 484, 512));
        assert_eq!(on_screen((200, 100), slot), (996, 269, 484, 512));
        // Second monitor to the left (negative screen coordinates).
        assert_eq!(on_screen((-1920, 0), slot), (-1124, 169, 484, 512));
        // Size is the browser's size: never zero, never scaled twice.
        let (_, _, w, h) = on_screen((0, 0), slot);
        assert_eq!((w, h), (slot.2, slot.3));
    }

    #[test]
    fn cursor_layer_shows_only_while_the_agent_acts_over_a_visible_browser() {
        assert!(layer_shown(true, true, false, true));
        assert!(!layer_shown(false, true, false, true), "user took over (Hand back) or agent idle");
        assert!(!layer_shown(true, false, false, true), "no side browser");
        assert!(!layer_shown(true, true, true, true), "app hid the browser (modal over it)");
        assert!(!layer_shown(true, true, false, false), "main window minimized or in the tray");
    }
}
