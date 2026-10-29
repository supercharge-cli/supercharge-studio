//! Settings and web UI hooks for [`crate::telemetry`] (desktop and phone app).

use crate::telemetry::{self, Status};
use serde_json::{json, Value};

/// The Settings switches for what this build can send (none in builds without telemetry).
/// Labels live here so the web bundles stay small.
fn ui(s: Status) -> Value {
    let mut rows = vec![];
    if s.crash_available {
        rows.push(json!(["crash", "Send crash reports", s.crash]));
    }
    if s.usage_available {
        rows.push(json!(["usage", "Send anonymous usage stats", s.usage]));
    }
    json!({ "rows": rows, "note": "Helps fix bugs. Never includes your prompts, code, file paths or keys." })
}

#[tauri::command]
pub fn telemetry_get() -> Value {
    ui(telemetry::get().map(|t| t.status()).unwrap_or_default())
}

/// Save one Settings switch.
#[tauri::command]
pub fn telemetry_set(crash: Option<bool>, usage: Option<bool>) -> Value {
    ui(telemetry::get().map(|t| t.set(crash, usage)).unwrap_or_default())
}

/// An uncaught error or unhandled rejection in the web UI (from `telemetry::JS_HOOK`).
#[tauri::command]
pub fn telemetry_js_error(message: String, stack: Option<String>) {
    if let Some(t) = telemetry::get() {
        t.js_error(&message, stack.as_deref().unwrap_or(""));
    }
}

/// Usage events the web UI may report itself (only the start of an agent session).
#[tauri::command]
pub fn telemetry_event(name: String) {
    if let Some(t) = telemetry::get() {
        if name == "session_start" {
            t.send_event("session_start");
        }
    }
}
