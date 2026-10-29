//! Model providers managed by the app and applied to the Supercharge agent config
//! (~/.supercharge/config.toml). Each provider's models become `[model.studio-<id>-<hash>]`
//! tables and the active provider's first model becomes `[models] default`. Nothing else:
//! no `allowed_models`, no role or fork models, so every other configured model stays usable.
//! API keys are read from secure storage here, never sent through the UI.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use toml_edit::{value, DocumentMut, Item, Table};

use crate::secrets;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// "responses" | "chat_completions" | "messages"
    pub format: String,
    pub models: Vec<String>,
}

const MAX_MODELS_RESPONSE: usize = 1024 * 1024;
const PREFIX: &str = "studio-";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
}

fn string_field<'a>(item: &'a Value, fields: &[&str]) -> Option<&'a str> {
    fields.iter().find_map(|field| item.get(*field).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()))
}

fn model_field<'a>(item: &'a Value, fields: &[&str]) -> Option<&'a Value> {
    fields.iter().find_map(|field| item.get(*field))
        .or_else(|| item.get("metadata").and_then(|meta| fields.iter().find_map(|field| meta.get(*field))))
}

fn parse_models(body: Value) -> Result<Vec<DiscoveredModel>, String> {
    let list = body.as_array()
        .or_else(|| body.get("data").and_then(Value::as_array))
        .or_else(|| body.get("models").and_then(Value::as_array))
        .ok_or("invalid models response")?;
    if list.len() > 10_000 {
        return Err("too many models".into());
    }
    let mut result = Vec::<DiscoveredModel>::new();
    for item in list {
        let Some(id) = string_field(item, &["id", "model", "model_id"]) else { continue };
        let name = string_field(item, &["name", "display_name"]).map(str::to_owned);
        let context = model_field(item, &["context_length", "context_window", "context_size", "max_context_tokens"])
            .and_then(Value::as_u64).filter(|n| *n > 0);
        let reasoning = model_field(item, &["reasoning", "supports_reasoning"])
            .and_then(Value::as_bool);
        merge_model(&mut result, DiscoveredModel { id: id.into(), name, context, reasoning });
    }
    Ok(result)
}

fn merge_model(result: &mut Vec<DiscoveredModel>, model: DiscoveredModel) {
    if let Some(existing) = result.iter_mut().find(|m| m.id == model.id) {
        if existing.name.is_none() { existing.name = model.name; }
        if existing.context.is_none() { existing.context = model.context; }
        if existing.reasoning.is_none() { existing.reasoning = model.reasoning; }
    } else {
        result.push(model);
    }
}

fn discover_models(base_url: &str, key: Option<&str>) -> Result<Vec<DiscoveredModel>, String> {
    let base = tauri::Url::parse(base_url).map_err(|_| "invalid provider URL")?;
    if !matches!(base.scheme(), "http" | "https") || base.host_str().is_none()
        || !base.username().is_empty() || base.password().is_some()
        || base.query().is_some() || base.fragment().is_some()
    {
        return Err("invalid provider URL".into());
    }
    let url = format!("{}/models", base.as_str().trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(6))
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(3))
        .redirects(0)
        .build();
    let mut result = Vec::new();
    let mut succeeded = false;
    let mut authentication_failed = false;
    let mut endpoint_failed = false;
    let key = key.filter(|k| !k.is_empty());
    let local = base.host_str().is_some_and(|host| {
        host == "localhost" || host.trim_matches(|c| c == '[' || c == ']')
            .parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
    });
    let safe_key = key.filter(|_| base.scheme() == "https" || local);
    for credential in [safe_key, None].into_iter().take(if safe_key.is_some() { 2 } else { 1 }) {
        let mut request = agent.get(&url);
        if let Some(secret) = credential {
            request = request.set("Authorization", &format!("Bearer {secret}"));
        }
        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(code, _)) => {
                if code == 401 || code == 403 { authentication_failed = true; }
                else { endpoint_failed = true; }
                continue;
            }
            Err(_) => continue,
        };
        if response.header("Content-Length").and_then(|s| s.parse::<usize>().ok()).is_some_and(|n| n > MAX_MODELS_RESPONSE) {
            continue;
        }
        let mut bytes = Vec::new();
        if response.into_reader().take((MAX_MODELS_RESPONSE + 1) as u64).read_to_end(&mut bytes).is_err()
            || bytes.len() > MAX_MODELS_RESPONSE { continue; }
        let Ok(body) = serde_json::from_slice(&bytes) else { continue };
        let Ok(models) = parse_models(body) else { continue };
        succeeded = true;
        for model in models { merge_model(&mut result, model); }
    }
    if succeeded { Ok(result) }
    else if authentication_failed { Err("Model discovery authentication failed. Check the saved API key or provider access.".into()) }
    else if endpoint_failed { Err("The provider /models endpoint returned an error.".into()) }
    else { Err("Could not read the provider /models endpoint. Check its URL, network, and response format.".into()) }
}

/// Discover provider models without exposing the stored credential.
#[tauri::command]
pub async fn provider_discover_models(id: String, base_url: String) -> Result<Vec<DiscoveredModel>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = secrets::get(&key_account(&id)).0;
        discover_models(&base_url, key.as_deref())
    }).await.map_err(|_| "model discovery failed".to_string())?
}
/// Role and background models older builds pointed at the Studio default. Never written now.
const ROLE_KEYS: &[&str] = &["web_search", "session_summary", "prompt_suggestion", "image_description"];

/// An id the Studio provider list generated: `studio-<slug>-<16 hex>` (or the first
/// releases' `studio-<slug>-<n>`). Anything else is the user's and is left alone.
pub fn is_studio_id(s: &str) -> bool {
    let Some((slug, tail)) = s.strip_prefix(PREFIX).and_then(|r| r.rsplit_once('-')) else { return false };
    let lower_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    !slug.is_empty() && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && ((tail.len() == 16 && tail.bytes().all(lower_hex)) || (!tail.is_empty() && tail.len() <= 4 && tail.bytes().all(|b| b.is_ascii_digit())))
}

/// Undo what older Studio builds wrote that locked the agent to one model: Studio ids in
/// `[models] allowed_models` (the key goes when nothing else is left), role models
/// (`web_search`, `session_summary`, `prompt_suggestion`, `image_description`),
/// `[ui] fork_secondary_model`, and a `[models] default` naming a Studio model that no longer
/// exists. Values the user wrote (any id that is not a Studio id) stay. True when it changed.
pub fn clean_studio_locks(doc: &mut DocumentMut) -> bool {
    let mut changed = false;
    let live: Vec<String> = doc.get("model").and_then(Item::as_table)
        .map(|t| t.iter().map(|(k, _)| k.to_string()).filter(|k| is_studio_id(k)).collect()).unwrap_or_default();
    if let Some(m) = doc.get_mut("models").and_then(Item::as_table_mut) {
        let mut empty = false;
        if let Some(arr) = m.get_mut("allowed_models").and_then(Item::as_array_mut) {
            let before = arr.len();
            arr.retain(|v| !v.as_str().is_some_and(is_studio_id));
            if arr.len() != before { changed = true; empty = arr.is_empty(); }
        }
        if empty { m.remove("allowed_models"); }
        for k in ROLE_KEYS {
            if m.get(k).and_then(Item::as_str).is_some_and(is_studio_id) { m.remove(k); changed = true; }
        }
        if m.get("default").and_then(Item::as_str).is_some_and(|d| is_studio_id(d) && !live.iter().any(|l| l == d)) {
            m.remove("default");
            changed = true;
        }
    }
    if let Some(ui) = doc.get_mut("ui").and_then(Item::as_table_mut) {
        if ui.get("fork_secondary_model").and_then(Item::as_str).is_some_and(is_studio_id) { ui.remove("fork_secondary_model"); changed = true; }
    }
    changed
}

/// Read the agent config, clean old Studio lock-ins, apply `edit`, and write it back. When the
/// cleanup changed anything, the file as it was is copied to `config.toml.bak` first (an
/// existing backup is kept; the new one then gets a timestamped name).
pub fn edit_config<T>(path: &std::path::Path, edit: impl FnOnce(&mut DocumentMut) -> Result<T, String>) -> Result<T, String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut doc: DocumentMut = text.parse().map_err(|e| format!("config.toml: {e}"))?;
    let cleaned = clean_studio_locks(&mut doc);
    let out = edit(&mut doc)?;
    if cleaned { backup(path, &text)?; }
    write_atomic(path, &doc.to_string())?;
    Ok(out)
}

fn backup(path: &std::path::Path, text: &str) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("config.toml");
    let mut bak = path.with_file_name(format!("{name}.bak"));
    if bak.exists() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        bak = path.with_file_name(format!("{name}.{stamp}.bak"));
    }
    write_atomic(&bak, text)
}

/// Startup pass: rewrite the config only when old Studio lock-ins are present (backed up first).
/// A missing or unparsable config is left untouched.
pub fn clean_config_file(path: &std::path::Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let Ok(mut doc) = text.parse::<DocumentMut>() else { return false };
    if !clean_studio_locks(&mut doc) { return false; }
    backup(path, &text).and_then(|_| write_atomic(path, &doc.to_string())).is_ok()
}

pub fn key_account(id: &str) -> String {
    format!("provider:{id}")
}

pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("SUPERCHARGE_STUDIO_AGENT_CONFIG") {
        return PathBuf::from(p);
    }
    dirs::home_dir().unwrap_or_default().join(".supercharge").join("config.toml")
}

fn slug(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect()
}

pub fn catalog_key(p: &Provider, i: usize) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in p.models[i].as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{PREFIX}{}-{hash:016x}", slug(&p.id))
}

/// Pure transform: apply `active` and its optional key to a config document.
pub fn apply_to_doc(doc: &mut DocumentMut, active: &Provider, api_key: Option<&str>) -> Vec<String> {
    // Drop previously managed model tables.
    if let Some(models) = doc.get_mut("model").and_then(Item::as_table_mut) {
        let stale: Vec<String> = models.iter().map(|(k, _)| k.to_string()).filter(|k| k.starts_with(PREFIX)).collect();
        for k in stale {
            models.remove(&k);
        }
    }
    if doc.get("model").is_none() {
        let mut t = Table::new();
        t.set_implicit(true);
        doc.insert("model", Item::Table(t));
    }
    let mut keys = Vec::new();
    {
        let model_tbl = doc["model"].as_table_mut().unwrap();
        model_tbl.set_implicit(true);
        for (i, m) in active.models.iter().enumerate() {
            let key = catalog_key(active, i);
            let mut t = Table::new();
            t.insert("model", value(m.as_str()));
            t.insert("base_url", value(active.base_url.trim_end_matches('/')));
            t.insert("name", value(format!("{} · {}", active.name, m)));
            if let Some(key) = api_key.filter(|key| !key.is_empty()) {
                t.insert("api_key", value(key));
            }
            t.insert("api_backend", value(active.format.as_str()));
            model_tbl.insert(&key, Item::Table(t));
            keys.push(key);
        }
    }
    if let Some(first) = keys.first() {
        if !doc.contains_table("models") {
            doc.insert("models", Item::Table(Table::new()));
        }
        doc["models"]["default"] = value(first.as_str());
    }
    keys
}

#[tauri::command]
pub async fn provider_set_key(id: String, key: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || secrets::set(&key_account(&id), &key).map(String::from))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn provider_has_key(id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || secrets::get(&key_account(&id)).0.is_some()).await.unwrap_or(false)
}

/// Optional test provider from the environment (never stored in the repo):
/// SUPERCHARGE_TEST_BASE_URL, SUPERCHARGE_TEST_MODEL, SUPERCHARGE_TEST_FORMAT, SUPERCHARGE_TEST_API_KEY.
/// Stores the key for provider `id` and returns the provider definition.
#[tauri::command]
pub async fn provider_seed_from_env(id: String) -> Option<Provider> {
    let key = std::env::var("SUPERCHARGE_TEST_API_KEY").ok().filter(|k| !k.is_empty())?;
    let base = std::env::var("SUPERCHARGE_TEST_BASE_URL").ok().filter(|k| !k.is_empty())?;
    let model = std::env::var("SUPERCHARGE_TEST_MODEL").ok().filter(|k| !k.is_empty())?;
    let format = std::env::var("SUPERCHARGE_TEST_FORMAT").unwrap_or_else(|_| "responses".into());
    let acct = key_account(&id);
    tauri::async_runtime::spawn_blocking(move || secrets::set(&acct, &key)).await.ok()?.ok()?;
    Some(Provider { id, name: "Test".into(), base_url: base, format, models: vec![model] })
}

/// Write the active provider into the agent config. Returns the catalog keys written.
#[tauri::command]
pub async fn provider_apply(provider: Provider) -> Result<Vec<String>, String> {
    crate::telemetry::feature("provider_setup");
    if provider.models.is_empty() {
        return Err("provider has no models".into());
    }
    if !["responses", "chat_completions", "messages"].contains(&provider.format.as_str()) {
        return Err(format!("unsupported API format: {}", provider.format));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = secrets::get(&key_account(&provider.id)).0;
        let keys = edit_config(&config_path(), |doc| Ok(apply_to_doc(doc, &provider, key.as_deref())))?;
        Ok(keys)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Atomic 0600 write (temp file + rename), shared with `/setup`-style saves.
pub fn write_atomic(path: &std::path::Path, text: &str) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
    let tmp = path.with_extension(format!("{ext}.tmp.{}.{}", std::process::id(), stamp));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
    let result = file.write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
        .and_then(|_| std::fs::rename(&tmp, path));
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, models: &[&str]) -> Provider {
        Provider { id: id.into(), name: "Test".into(), base_url: "https://api.example.com/".into(), format: "responses".into(), models: models.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn catalog_keys_do_not_change_when_shortlist_order_changes() {
        let first = p("a", &["one", "two"]);
        let revised = p("a", &["two"]);
        assert_eq!(catalog_key(&first, 1), catalog_key(&revised, 0));
        assert_ne!(catalog_key(&first, 0), catalog_key(&first, 1));
    }

    #[test]
    fn keyless_models_do_not_write_an_api_key() {
        let mut doc: DocumentMut = "".parse().unwrap();
        apply_to_doc(&mut doc, &p("local", &["one"]), None);
        assert!(doc["model"][&catalog_key(&p("local", &["one"]), 0)].get("api_key").is_none());
    }

    #[test]
    fn normalizes_model_lists_without_guessing_metadata() {
        let body = serde_json::json!({"data": [
            {"id": "a", "name": "Alpha", "context_length": 8192, "supports_reasoning": true},
            {"model": "b", "display_name": "Beta", "metadata": {"context_window": 4096, "reasoning": false}},
            {"id": "c"}, {"id": " "}, {"name": "missing id"}
        ]});
        let models = parse_models(body).unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "a");
        assert_eq!(models[0].name.as_deref(), Some("Alpha"));
        assert_eq!(models[0].context, Some(8192));
        assert_eq!(models[0].reasoning, Some(true));
        assert_eq!(models[1].id, "b");
        assert_eq!(models[1].context, Some(4096));
        assert_eq!(models[1].reasoning, Some(false));
        assert_eq!(models[2].id, "c");
        assert_eq!(models[2].name, None);
        assert_eq!(models[2].context, None);
        assert_eq!(models[2].reasoning, None);
        assert_eq!(parse_models(serde_json::json!({"models": [{"model_id": "d"}]})).unwrap()[0].id, "d");
        assert!(parse_models(serde_json::json!({"data": {}})).is_err());
    }

    #[test]
    fn discovery_merges_authenticated_and_keyless_results() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                assert!(req.starts_with("GET /v1/models HTTP/1.1"));
                let body = if req.to_ascii_lowercase().contains("authorization: bearer test-secret") {
                    r#"{"data":[{"id":"shared","name":"Named"},{"id":"private"}]}"#
                } else {
                    r#"{"models":[{"id":"shared","context_window":2048},{"id":"public"}]}"#
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let models = discover_models(&base, Some("test-secret")).unwrap();
        server.join().unwrap();
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["shared", "private", "public"]);
        assert_eq!(models[0].name.as_deref(), Some("Named"));
        assert_eq!(models[0].context, Some(2048));
    }

    #[test]
    fn discovery_keeps_keyless_results_when_authenticated_request_fails() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                if attempt == 0 {
                    assert!(req.contains("authorization: bearer test-secret"));
                    write!(stream, "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                } else {
                    assert!(!req.contains("authorization:"));
                    let body = r#"[{"id":"public"}]"#;
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                }
            }
        });
        let models = discover_models(&base, Some("test-secret")).unwrap();
        server.join().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "public");
        assert!(!serde_json::to_string(&models).unwrap().contains("test-secret"));
    }

    #[test]
    fn discovery_reports_authentication_failure() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0; 1024];
                stream.read(&mut buf).unwrap();
                write!(stream, "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
        });
        let result = discover_models(&base, Some("wrong-key"));
        server.join().unwrap();
        assert!(result.unwrap_err().contains("authentication"));
    }

    #[test]
    fn discovery_rejects_invalid_urls_and_excessive_responses() {
        assert!(discover_models("file:///etc/", None).is_err());
        assert!(discover_models("https://user:pass@example.com", Some("secret")).is_err());
        assert!(discover_models("http://example.com", Some("secret")).is_err());
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0; 1024];
            stream.read(&mut buf).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_MODELS_RESPONSE + 1).unwrap();
        });
        assert!(discover_models(&base, None).is_err());
        server.join().unwrap();
    }

    #[test]
    fn applies_and_replaces_managed_models() {
        let mut doc: DocumentMut = "[ui]\nyolo = false\n\n[model.mine]\nmodel = \"keep\"\n".parse().unwrap();
        let keys = apply_to_doc(&mut doc, &p("a", &["m1", "m2"]), Some("k1"));
        assert_eq!(keys, vec![catalog_key(&p("a", &["m1", "m2"]), 0), catalog_key(&p("a", &["m1", "m2"]), 1)]);
        let keys = apply_to_doc(&mut doc, &p("b", &["x"]), Some("k2"));
        assert_eq!(keys, vec![catalog_key(&p("b", &["x"]), 0)]);
        let s = doc.to_string();
        assert!(s.contains("[model.mine]"));
        assert!(!s.contains("studio-a-"));
        assert!(s.contains("base_url = \"https://api.example.com\""));
        assert_eq!(doc["models"]["default"].as_str(), Some(keys[0].as_str()));
        for k in ROLE_KEYS { assert!(doc["models"].get(k).is_none(), "{k}"); }
        assert!(doc["models"].get("allowed_models").is_none());
        assert!(doc["ui"].get("fork_secondary_model").is_none());
        assert_eq!(doc["ui"]["yolo"].as_bool(), Some(false));
        assert_eq!(doc["model"][&keys[0]]["api_backend"].as_str(), Some("responses"));
    }

    #[test]
    fn recognizes_only_generated_studio_ids() {
        let key = catalog_key(&p("my-prov", &["m"]), 0);
        assert!(is_studio_id(&key) && is_studio_id("studio-a-1") && is_studio_id("studio-open-router-12"));
        for s in ["studio-", "studio-a", "studio-a-", "studio-mine", "studio-A-1", "studio-a-0123456789ABCDEF", "studio-a-12345", "mine", "model-5"] {
            assert!(!is_studio_id(s), "{s}");
        }
    }

    #[test]
    fn never_writes_allowed_models_or_role_models() {
        let mut doc: DocumentMut = "[models]\nweb_search = \"mine\"\n\n[model.mine]\nmodel = \"keep\"\n".parse().unwrap();
        let keys = apply_to_doc(&mut doc, &p("a", &["m1", "m2"]), Some("k"));
        let s = doc.to_string();
        assert!(!s.contains("allowed_models") && !s.contains("session_summary") && !s.contains("prompt_suggestion")
            && !s.contains("image_description") && !s.contains("fork_secondary_model"), "{s}");
        assert_eq!(doc["models"]["web_search"].as_str(), Some("mine"));
        assert_eq!(doc["models"]["default"].as_str(), Some(keys[0].as_str()));
        assert!(doc["model"].get("mine").is_some());
    }

    #[test]
    fn cleanup_removes_only_what_studio_wrote() {
        let k = catalog_key(&p("a", &["m1"]), 0);
        let gone = "studio-old-0123456789abcdef";
        let text = format!("[models]\ndefault = \"{k}\"\nweb_search = \"{k}\"\nsession_summary = \"{gone}\"\nprompt_suggestion = \"mine\"\nimage_description = \"{k}\"\nallowed_models = [\"{k}\", \"studio-a-2\"]\n\n[model.{k}]\nmodel = \"m1\"\n\n[model.mine]\nmodel = \"x\"\n\n[ui]\nfork_secondary_model = \"{k}\"\nyolo = true\n");
        let mut doc: DocumentMut = text.parse().unwrap();
        assert!(clean_studio_locks(&mut doc));
        let m = &doc["models"];
        assert!(m.get("allowed_models").is_none() && m.get("web_search").is_none() && m.get("session_summary").is_none() && m.get("image_description").is_none());
        assert_eq!(m["prompt_suggestion"].as_str(), Some("mine"));
        assert_eq!(m["default"].as_str(), Some(k.as_str()), "a live Studio default stays");
        assert!(doc["ui"].get("fork_secondary_model").is_none());
        assert_eq!(doc["ui"]["yolo"].as_bool(), Some(true));
        assert!(doc["model"].get(&k).is_some() && doc["model"].get("mine").is_some());
        assert!(!clean_studio_locks(&mut doc), "second pass is a no-op");
        // A hand-written list keeps its own entries; a dangling Studio default goes.
        let mut doc: DocumentMut = format!("[models]\ndefault = \"{gone}\"\nallowed_models = [\"mine\", \"{gone}\"]\n\n[ui]\nfork_secondary_model = \"mine\"\n").parse().unwrap();
        assert!(clean_studio_locks(&mut doc));
        assert!(doc["models"].get("default").is_none());
        assert_eq!(doc["models"]["allowed_models"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect::<Vec<_>>(), ["mine"]);
        assert_eq!(doc["ui"]["fork_secondary_model"].as_str(), Some("mine"));
        let mut user: DocumentMut = "[models]\ndefault = \"mine\"\nallowed_models = [\"mine\"]\nweb_search = \"studio-mine\"\n".parse().unwrap();
        assert!(!clean_studio_locks(&mut user));
    }

    #[test]
    fn cleanup_file_backs_up_first_and_runs_once() {
        let dir = std::env::temp_dir().join(format!("scs-clean-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        let k = catalog_key(&p("a", &["m1"]), 0);
        let text = format!("# mine\n[models]\ndefault = \"{k}\"\nweb_search = \"{k}\"\nallowed_models = [\"{k}\"]\n\n[model.{k}]\nmodel = \"m1\"\n\n[ui]\nfork_secondary_model = \"{k}\"\n");
        std::fs::write(&path, &text).unwrap();
        assert!(clean_config_file(&path));
        assert_eq!(std::fs::read_to_string(dir.join("config.toml.bak")).unwrap(), text);
        let now = std::fs::read_to_string(&path).unwrap();
        assert!(now.contains("# mine") && now.contains(&format!("default = \"{k}\"")));
        assert!(!now.contains("allowed_models") && !now.contains("web_search") && !now.contains("fork_secondary_model"));
        assert!(!clean_config_file(&path), "nothing left to clean");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "no second backup");
        // Saving through edit_config cleans too, and keeps the first backup.
        std::fs::write(&path, &text).unwrap();
        edit_config(&path, |doc| Ok(apply_to_doc(doc, &p("b", &["x"]), None))).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("config.toml.bak")).unwrap(), text);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3, "a timestamped second backup");
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("allowed_models") && !saved.contains("web_search") && !saved.contains("fork_secondary_model") && !saved.contains(&k));
        assert!(!clean_config_file(dir.join("missing.toml").as_path()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
