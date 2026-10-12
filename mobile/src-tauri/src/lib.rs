//! Supercharge Studio mobile companion. All logic lives in the shared web UI
//! (src/mobile); the native side is a plain webview shell.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Supercharge Studio mobile");
}
