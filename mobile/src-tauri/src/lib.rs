//! Supercharge Studio mobile companion. All logic lives in the shared web UI
//! (src/mobile); the native side only adds QR scanning, syntax highlighting, the pairing deep link and
//! the phone's own address (to explain "different network" connection failures), plus crash reports
//! and anonymous usage stats in official builds.

/// Syntax highlighting for chat code blocks, shared with the desktop app.
#[path = "../../../src-tauri/src/highlight.rs"]
mod highlight;

/// Crash reports and anonymous usage stats, shared with the desktop app (off unless compiled in).
#[path = "../../../src-tauri/src/telemetry.rs"]
#[allow(dead_code)]
mod telemetry;
#[path = "../../../src-tauri/src/telemetry_cmds.rs"]
mod telemetry_cmds;

/// This phone's IPv4 address on its default network (no packets are sent).
#[tauri::command]
fn local_ipv4() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v) if !v.is_loopback() && !v.is_unspecified() => Some(v.to_string()),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    let builder = tauri::Builder::default()
        // Uncaught web UI errors go to crash reports (see telemetry::JS_HOOK).
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("telemetry").js_init_script(telemetry::JS_HOOK.to_string()).build())
        .setup(|app| {
            let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("supercharge-studio"));
            telemetry::init("mobile", env!("CARGO_PKG_VERSION"), &dir, true, false);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_ipv4,
            highlight::highlight_code,
            telemetry_cmds::telemetry_get,
            telemetry_cmds::telemetry_set,
            telemetry_cmds::telemetry_js_error,
            telemetry_cmds::telemetry_event
        ]);
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_deep_link::init());
    builder.run(tauri::generate_context!()).expect("error while running Supercharge Studio mobile");
}
