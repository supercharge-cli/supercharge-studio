//! Local MCP server (streamable HTTP, JSON responses) that exposes the side browser
//! as tools. The app passes its URL to the agent in `session/new.mcpServers`, so any
//! ACP agent with MCP-over-HTTP support can see and drive the browser.
//!
//! Tool calls are forwarded to the UI (`mcp://call` event), which runs them through
//! the same browser controller used for ACP extension methods and answers with
//! the `mcp_result` command.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

static URL: OnceLock<String> = OnceLock::new();
static PENDING: OnceLock<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static Mutex<HashMap<u64, oneshot::Sender<Value>>> {
    PENDING.get_or_init(Default::default)
}

pub fn tools() -> Value {
    let obj = |props: Value, req: &[&str]| json!({ "type": "object", "properties": props, "required": req });
    let target = || {
        json!({
            "ref": { "type": "integer", "description": "Element ref from the latest browser_snapshot (preferred)" },
            "selector": { "type": "string", "description": "CSS selector (alternative to ref)" },
            "element_text": { "type": "string", "description": "Visible text or label of the element (alternative to ref)" }
        })
    };
    let with = |extra: Value| {
        let mut t = target();
        for (k, v) in extra.as_object().unwrap() {
            t[k] = v.clone();
        }
        t
    };
    json!([
        { "name": "browser_navigate", "description": "Open a URL in the side browser the user sees in Supercharge Studio (opens the panel if needed). Waits for the page to load and returns its URL and title.",
          "inputSchema": obj(json!({ "url": { "type": "string" } }), &["url"]) },
        { "name": "browser_snapshot", "description": "Accessibility snapshot of the current page: a role/name tree where every interactive element has [ref=N], plus URL, title and scroll position. Call it before clicking or typing and after the page changes; refs from older snapshots stop working.",
          "inputSchema": obj(json!({}), &[]) },
        { "name": "browser_screenshot", "description": "Screenshot (image) of the visible side browser, max 1280px. Use it to check visual details such as colors, layout and images; use browser_snapshot to find elements.",
          "inputSchema": obj(json!({}), &[]) },
        { "name": "browser_click", "description": "Click an element (by ref from browser_snapshot, CSS selector or visible text). Waits for any navigation and returns the resulting URL and title.",
          "inputSchema": obj(target(), &[]) },
        { "name": "browser_type", "description": "Type text into an input, textarea or editable element (replaces its value unless append is true).",
          "inputSchema": obj(with(json!({ "text": { "type": "string" }, "submit": { "type": "boolean", "description": "Press Enter afterwards (submits the form)" }, "append": { "type": "boolean" } })), &["text"]) },
        { "name": "browser_press_key", "description": "Press a key (e.g. Enter, Escape, Tab, ArrowDown, a) on the focused element, or on the given element.",
          "inputSchema": obj(with(json!({ "key": { "type": "string" } })), &["key"]) },
        { "name": "browser_select_option", "description": "Choose option(s) in a <select> by value or visible text.",
          "inputSchema": obj(with(json!({ "values": { "type": "array", "items": { "type": "string" } } })), &["values"]) },
        { "name": "browser_hover", "description": "Hover over an element (shows menus/tooltips).", "inputSchema": obj(target(), &[]) },
        { "name": "browser_scroll", "description": "Scroll the page by dy pixels (negative = up), or scroll an element (ref/selector/element_text) into view.",
          "inputSchema": obj(with(json!({ "dy": { "type": "number" } })), &[]) },
        { "name": "browser_wait_for", "description": "Wait until text appears, text disappears or a CSS selector matches (timeout_ms, default 10000, max 30000), or just wait `time` seconds.",
          "inputSchema": obj(json!({ "text": { "type": "string" }, "text_gone": { "type": "string" }, "selector": { "type": "string" }, "time": { "type": "number" }, "timeout_ms": { "type": "number" } }), &[]) },
        { "name": "browser_tabs", "description": "List, open (with optional url), select or close tabs of the side browser. action: list | new | select | close; index for select/close.",
          "inputSchema": obj(json!({ "action": { "type": "string", "enum": ["list", "new", "select", "close"] }, "url": { "type": "string" }, "index": { "type": "integer" } }), &[]) },
        { "name": "browser_back", "description": "Go back in history.", "inputSchema": obj(json!({}), &[]) },
        { "name": "browser_forward", "description": "Go forward in history.", "inputSchema": obj(json!({}), &[]) },
        { "name": "browser_reload", "description": "Reload the page.", "inputSchema": obj(json!({}), &[]) },
        { "name": "browser_eval", "description": "Evaluate a JavaScript expression in the page and return its JSON value.",
          "inputSchema": obj(json!({ "expression": { "type": "string" } }), &["expression"]) }
    ])
}

/// Answer for a forwarded tool call (from the UI).
#[tauri::command]
pub fn mcp_result(id: u64, result: Value) {
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

#[tauri::command]
pub fn mcp_info() -> Option<String> {
    URL.get().cloned()
}

async fn call_tool(app: &AppHandle, name: &str, args: Value) -> Value {
    let id = SEQ.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    pending().lock().unwrap().insert(id, tx);
    if app.emit("mcp://call", json!({ "id": id, "name": name, "arguments": args })).is_err() {
        pending().lock().unwrap().remove(&id);
        return json!({ "isError": true, "content": [{ "type": "text", "text": "app UI unavailable" }] });
    }
    match tokio::time::timeout(Duration::from_secs(60), rx).await {
        Ok(Ok(v)) => v,
        _ => {
            pending().lock().unwrap().remove(&id);
            json!({ "isError": true, "content": [{ "type": "text", "text": "browser tool timed out" }] })
        }
    }
}

async fn handle_rpc(app: &AppHandle, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?; // notifications get no response
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "supercharge-studio-browser", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Tools that see and control the side browser panel the user sees in Supercharge Studio. Typical loop: browser_navigate, browser_snapshot (find [ref=N]), browser_click / browser_type with that ref, then browser_snapshot or browser_screenshot to check the result."
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
            let args = msg["params"].get("arguments").cloned().unwrap_or(json!({}));
            call_tool(app, &name, args).await
        }
        _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, body: Option<String>) {
    let body = body.unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(body.as_bytes()).await;
}

async fn serve_conn(app: AppHandle, mut sock: tokio::net::TcpStream, path: String) {
    let mut reader = BufReader::new(&mut sock);
    let mut line = String::new();
    if reader.read_line(&mut line).await.is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).await.unwrap_or(0) == 0 || h == "\r\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    if target != path {
        return respond(&mut sock, "404 Not Found", None).await;
    }
    if method != "POST" {
        return respond(&mut sock, "405 Method Not Allowed", None).await;
    }
    let mut body = vec![0u8; len.min(4 << 20)];
    if reader.read_exact(&mut body).await.is_err() {
        return;
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return respond(&mut sock, "400 Bad Request", None).await;
    };
    let out = if let Some(batch) = msg.as_array() {
        let mut v = Vec::new();
        for m in batch {
            if let Some(r) = handle_rpc(&app, m).await {
                v.push(r);
            }
        }
        if v.is_empty() { None } else { Some(Value::Array(v)) }
    } else {
        handle_rpc(&app, &msg).await
    };
    match out {
        Some(v) => respond(&mut sock, "200 OK", Some(v.to_string())).await,
        None => respond(&mut sock, "202 Accepted", None).await,
    }
}

/// Bind on 127.0.0.1 with an unguessable path. The port and path are kept in the app's config
/// directory and reused on the next launch, so sessions the agent saved with this URL (and
/// reattaches on load/resume) still reach the browser after the app restarts.
pub fn start(app: AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let file = app.path().app_config_dir().ok().map(|d| d.join("browser-mcp.json"));
        let saved: Option<(u16, String)> = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| Some((v["port"].as_u64()? as u16, v["token"].as_str()?.to_string())))
            .filter(|(_, t)| t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit()));
        let listener = match saved.as_ref() {
            Some((p, _)) => match TcpListener::bind(("127.0.0.1", *p)).await {
                Ok(l) => Some(l),
                Err(_) => None,
            },
            None => None,
        };
        let listener = match listener {
            Some(l) => l,
            None => match TcpListener::bind("127.0.0.1:0").await {
                Ok(l) => l,
                Err(_) => return,
            },
        };
        let Ok(addr) = listener.local_addr() else { return };
        let token = match saved {
            Some((_, t)) => t,
            None => {
                let mut b = [0u8; 16];
                if getrandom::fill(&mut b).is_err() {
                    return;
                }
                b.iter().map(|x| format!("{x:02x}")).collect()
            }
        };
        if let Some(f) = &file {
            let _ = std::fs::create_dir_all(f.parent().unwrap());
            let _ = std::fs::write(f, json!({ "port": addr.port(), "token": token }).to_string());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o600));
            }
        }
        let path = format!("/mcp/{token}");
        let _ = URL.set(format!("http://{addr}{path}"));
        crate::agent::log_line(&format!("browser tools (MCP) listening on 127.0.0.1:{}", addr.port()));
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            tauri::async_runtime::spawn(serve_conn(app.clone(), sock, path.clone()));
        }
    });
}
