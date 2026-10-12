const COMMANDS: &[&str] = &[
    "app_config", "agent_probe", "agent_start", "agent_stop",
    "stdio_start", "stdio_send", "stdio_stop",
    "browser_open", "browser_navigate", "browser_set_bounds", "browser_eval", "browser_close", "browser_set_visible", "browser_screenshot", "secret_get", "secret_set", "mcp_result", "mcp_info", "provider_set_key", "provider_has_key", "provider_seed_from_env", "provider_apply", "agent_restart", "agent_info", "agent_log", "agent_install",
    "gateway_status", "gateway_start", "gateway_stop", "gateway_pair_begin", "gateway_pair_answer", "gateway_revoke", "gateway_send", "gateway_relay_set",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build");
}
