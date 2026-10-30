//! "Start at login and keep running in the background".
//!
//! * Autostart at OS login through the autostart plugin (Linux XDG autostart entry, macOS
//!   LaunchAgent, Windows Run key). Login launches pass `--background` and start hidden.
//! * A tray icon with Open / Quit. While "keep running" is on, closing the window hides it,
//!   so the mobile gateway and relay connection stay reachable from a phone.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

pub const BACKGROUND_ARG: &str = "--background";
static KEEP_RUNNING: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default)]
    pub keep_running: bool,
}

fn prefs_path() -> std::path::PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("supercharge-studio").join("background.json")
}
pub fn parse_prefs(b: &[u8]) -> Prefs {
    serde_json::from_slice(b).unwrap_or_default()
}
fn load() -> Prefs {
    std::fs::read(prefs_path()).map(|b| parse_prefs(&b)).unwrap_or_default()
}
fn save(p: Prefs) -> Result<(), String> {
    let path = prefs_path();
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_vec(&p).unwrap()).map_err(|e| e.to_string())
}

/// True when this process was started by the OS at login.
pub fn launched_in_background(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|a| a == BACKGROUND_ARG)
}

/// Whether closing the main window should hide it instead of quitting.
pub fn hide_on_close() -> bool {
    KEEP_RUNNING.load(Ordering::SeqCst) && !QUITTING.load(Ordering::SeqCst)
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Install the tray (best effort: some Linux desktops have no tray) and load the saved choice.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    KEEP_RUNNING.store(load().keep_running, Ordering::SeqCst);
    refresh_autostart(app);
    let open = MenuItem::with_id(app, "open", "Open Supercharge Studio", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main").tooltip("Supercharge Studio").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    let built = tray
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "open" => show_main(app),
            "quit" => {
                QUITTING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        })
        .build(app);
    if let Err(e) = built {
        eprintln!("tray unavailable: {e}");
    }
    Ok(())
}

/// An enabled login entry is rewritten so it starts the binary running now. Otherwise an
/// entry left by an older install at another path keeps starting that old build at login,
/// and single-instance then hands every later launch of the new one to it.
fn refresh_autostart<R: Runtime>(app: &AppHandle<R>) {
    if in_flatpak() {
        return;
    }
    let al = app.autolaunch();
    if al.is_enabled().unwrap_or(false) {
        if let Err(e) = al.enable() {
            eprintln!("autostart refresh failed: {e}");
        }
    }
}

fn in_flatpak() -> bool {
    std::env::var_os("FLATPAK_ID").is_some() || std::path::Path::new("/.flatpak-info").exists()
}

#[derive(Serialize)]
pub struct Status {
    autostart: bool,
    keep_running: bool,
}

#[tauri::command]
pub fn background_get(app: AppHandle) -> Status {
    let autostart = !in_flatpak() && app.autolaunch().is_enabled().unwrap_or(false);
    Status { autostart, keep_running: KEEP_RUNNING.load(Ordering::SeqCst) }
}

/// One switch in the UI: start at login + keep running when the window closes.
#[tauri::command]
pub fn background_set(app: AppHandle, enabled: bool) -> Result<Status, String> {
    let al = app.autolaunch();
    // Inside a Flatpak sandbox a host autostart entry would point at a path that only exists
    // in the sandbox, so start-at-login is skipped there; keep-running still applies.
    let r = if in_flatpak() { Ok(()) } else if enabled { al.enable() } else { al.disable() };
    save(Prefs { keep_running: enabled })?;
    KEEP_RUNNING.store(enabled, Ordering::SeqCst);
    r.map_err(|e| format!("start at login: {e}"))?;
    Ok(background_get(app))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefs_and_args() {
        assert_eq!(parse_prefs(b"{\"keep_running\":true}"), Prefs { keep_running: true });
        assert_eq!(parse_prefs(b"garbage"), Prefs::default());
        assert!(launched_in_background(["app".to_string(), BACKGROUND_ARG.to_string()]));
        assert!(!launched_in_background(["app".to_string()]));
    }
    #[test]
    fn close_hides_only_when_keep_running_and_not_quitting() {
        KEEP_RUNNING.store(true, Ordering::SeqCst);
        assert!(hide_on_close());
        QUITTING.store(true, Ordering::SeqCst);
        assert!(!hide_on_close());
        QUITTING.store(false, Ordering::SeqCst);
        KEEP_RUNNING.store(false, Ordering::SeqCst);
        assert!(!hide_on_close());
    }
}
