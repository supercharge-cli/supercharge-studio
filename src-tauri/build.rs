const COMMANDS: &[&str] = &[
    "app_config", "agent_probe", "agent_start", "agent_stop",
    "stdio_start", "stdio_send", "stdio_stop",
    "browser_open", "browser_navigate", "browser_set_bounds", "browser_eval", "browser_close", "browser_set_visible", "browser_screenshot", "secret_get", "secret_set", "mcp_result", "mcp_info", "provider_set_key", "provider_has_key", "provider_seed_from_env", "provider_apply", "agent_restart",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build");
}
