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
    let target = json!({
        "ref": { "type": "integer", "description": "Element ref from browser_snapshot" },
        "selector": { "type": "string", "description": "CSS selector (alternative to ref)" }
    });
    let mut type_props = target.clone();
    type_props["text"] = json!({ "type": "string" });
    type_props["submit"] = json!({ "type": "boolean", "description": "Submit the form / press Enter after typing" });
    json!([
        { "name": "browser_navigate", "description": "Open a URL in the Supercharge Studio side browser the user can see.",
          "inputSchema": obj(json!({ "url": { "type": "string" } }), &["url"]) },
        { "name": "browser_snapshot", "description": "Read the current page: URL, title, visible text and interactive elements with numeric refs.",
          "inputSchema": obj(json!({}), &[]) },
        { "name": "browser_screenshot", "description": "Screenshot (image) of the visible side browser, max 1280px. Use it to check visual details such as colors, layout and images.",
          "inputSchema": obj(json!({}), &[]) },
        { "name": "browser_click", "description": "Click an element by ref (from browser_snapshot) or CSS selector.",
          "inputSchema": obj(target.clone(), &[]) },
        { "name": "browser_type", "description": "Type text into an input by ref or CSS selector.",
          "inputSchema": obj(type_props, &["text"]) },
        { "name": "browser_scroll", "description": "Scroll the page vertically by dy pixels.",
          "inputSchema": obj(json!({ "dy": { "type": "number" } }), &[]) },
        { "name": "browser_back", "description": "Go back in history.", "inputSchema": obj(json!({}), &[]) },
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
            "instructions": "Tools that see and control the side browser panel in Supercharge Studio."
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

/// Bind on 127.0.0.1 with a random port and an unguessable path.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::bind("127.0.0.1:0").await else { return };
        let Ok(addr) = listener.local_addr() else { return };
        let mut b = [0u8; 16];
        if getrandom::fill(&mut b).is_err() {
            return;
        }
        let token: String = b.iter().map(|x| format!("{x:02x}")).collect();
        let path = format!("/mcp/{token}");
        let _ = URL.set(format!("http://{addr}{path}"));
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            tauri::async_runtime::spawn(serve_conn(app.clone(), sock, path.clone()));
        }
    });
}
