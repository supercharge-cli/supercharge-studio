//! Supercharge Studio mobile companion. All logic lives in the shared web UI
//! (src/mobile); the native side only adds QR scanning and the pairing deep link.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_deep_link::init());
    builder.run(tauri::generate_context!()).expect("error while running Supercharge Studio mobile");
}
