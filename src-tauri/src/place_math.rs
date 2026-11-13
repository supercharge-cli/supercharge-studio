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

#[cfg(test)]
mod tests {
    use super::physical_rect as p;

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
}
