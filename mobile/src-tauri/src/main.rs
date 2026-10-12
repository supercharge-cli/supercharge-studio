// Desktop entry, only used for quick local runs of the mobile UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    supercharge_studio_mobile_lib::run()
}
