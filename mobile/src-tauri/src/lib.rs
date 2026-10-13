//! Supercharge Studio mobile companion. All logic lives in the shared web UI
//! (src/mobile); the native side only adds QR scanning, the pairing deep link and
//! the phone's own address (to explain "different network" connection failures).

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
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![local_ipv4]);
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_deep_link::init());
    builder.run(tauri::generate_context!()).expect("error while running Supercharge Studio mobile");
}
