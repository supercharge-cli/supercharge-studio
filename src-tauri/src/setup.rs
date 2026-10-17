//! Provider setup that matches the Supercharge CLI's `/setup` step for step: the same
//! base-URL rules, `/models` listing and `config.toml` layout (`[endpoints]`,
//! `[models] default`, `[model_providers.setup]`, `[model."<id>"]`), so the CLI and the
//! app read each other's setup. Nous Research signs in with the RFC 8628 device-code
//! flow; tokens go to `~/.supercharge/nous_oauth.json` in the CLI's format.
//! Keys travel UI → here → config.toml only; nothing here returns a stored secret.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use toml_edit::{value, DocumentMut, Item, Table};

use crate::providers::{clean_studio_locks, config_path, edit_config, is_studio_id, write_atomic};

const MAX_MODELS: usize = 500;
const MAX_KEY: usize = 8192;
const MAX_BODY: u64 = 4 * 1024 * 1024;
const SETUP_ID: &str = "setup";
const PORTAL: &str = "https://portal.nousresearch.com";
const NOUS_INFERENCE: &str = "https://inference-api.nousresearch.com/v1";
const NOUS_SCOPE: &str = "inference:invoke";
const NOUS_CLIENT: &str = "hermes-cli";

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(8)).timeout(Duration::from_secs(20)).user_agent("supercharge-cli").build()
}

fn loopback(host: &str) -> bool {
    let h = host.trim_matches(['[', ']']);
    h.eq_ignore_ascii_case("localhost") || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Same rules as `/setup`: trim, add https, http only for loopback, drop a trailing `/models`.
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() { return Err("provider base URL is empty".into()) }
    if t.len() > 500 { return Err("provider base URL is too long".into()) }
    let with = if t.contains("://") { t.to_owned() } else { format!("https://{t}") };
    let u = tauri::Url::parse(&with).map_err(|_| "provider base URL is invalid")?;
    match u.scheme() {
        "https" => {}
        "http" if loopback(u.host_str().unwrap_or_default()) => {}
        "http" => return Err("plain HTTP is only allowed for localhost development endpoints".into()),
        _ => return Err("provider base URL must use http or https".into()),
    }
    if u.host_str().is_none() { return Err("provider base URL is invalid".into()) }
    let mut n = with.trim_end_matches('/').to_owned();
    if let Some(s) = n.strip_suffix("/models") { n = s.trim_end_matches('/').to_owned() }
    if n.ends_with("://") { return Err("provider base URL is invalid".into()) }
    Ok(n)
}

pub fn models_list_url(base: &str) -> String {
    let b = base.trim_end_matches('/');
    let l = b.to_ascii_lowercase();
    if l.ends_with("/v1") || l.ends_with("/anthropic") || l.ends_with("paas/v4") || l.contains("/openai") || l.contains("compatible-mode") || l.contains("/v1/") {
        format!("{b}/models")
    } else {
        format!("{b}/v1/models")
    }
}

/// "chat_completions" | "messages" | "responses" (the CLI's `api_backend` values).
fn backend(format: &str) -> &'static str {
    match format { "messages" | "anthropic" => "messages", "responses" => "responses", _ => "chat_completions" }
}

fn looks_messages(base: &str, format: &str) -> bool {
    let l = base.to_ascii_lowercase();
    backend(format) == "messages" || l.contains("api.anthropic.com") || l.ends_with("/anthropic") || l.contains("/anthropic/")
}

fn non_chat(id: &str) -> bool {
    let l = id.to_ascii_lowercase();
    ["embed", "whisper", "tts", "dall-e", "dalle", "moderation", "image", "audio", "speech", "transcri"].iter().any(|w| l.contains(w))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetupModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<u64>,
}

pub fn parse_models(body: &Value) -> Vec<SetupModel> {
    let list = body.get("data").or_else(|| body.get("models")).and_then(Value::as_array).or_else(|| body.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for e in &list {
        let (id, name) = if let Some(s) = e.as_str() { (s.trim(), s.trim()) } else {
            let Some(o) = e.as_object() else { continue };
            let Some(id) = ["id", "model", "modelId", "name"].iter().find_map(|k| o.get(*k).and_then(Value::as_str)).map(str::trim) else { continue };
            let name = ["display_name", "name"].iter().filter_map(|k| o.get(*k).and_then(Value::as_str)).map(str::trim).find(|n| !n.is_empty()).unwrap_or(id);
            (id, name)
        };
        if id.is_empty() || id.len() > 200 || non_chat(id) { continue }
        let context = ["context_window", "context_length", "max_context_length", "contextWindow", "max_input_tokens", "inputTokenLimit"].iter()
            .find_map(|k| e.get(*k).and_then(Value::as_u64))
            .or_else(|| e.get("top_provider").and_then(|t| t.get("context_length")).and_then(Value::as_u64))
            .filter(|n| *n > 0);
        out.push(SetupModel { id: id.into(), name: name.into(), context });
        if out.len() >= MAX_MODELS { break }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

fn fetch_models(base: &str, key: &str, format: &str) -> Result<Vec<SetupModel>, String> {
    let base = normalize_base_url(base)?;
    if key.len() > MAX_KEY { return Err("provider API key is too long".into()) }
    let mut req = http().get(&models_list_url(&base));
    let key = key.trim();
    if !key.is_empty() {
        if looks_messages(&base, format) {
            req = if key.starts_with("sk-ant-oat") || key.starts_with("eyJ") { req.set("Authorization", &format!("Bearer {key}")) } else { req.set("x-api-key", key) };
            req = req.set("anthropic-version", "2023-06-01");
        } else {
            req = req.set("Authorization", &format!("Bearer {key}"));
            if base.contains("openrouter.ai") { req = req.set("X-Title", "Supercharge AI") }
        }
    }
    let (status, body) = match req.call() {
        Ok(r) => (r.status(), read_body(r)),
        Err(ureq::Error::Status(code, r)) => (code, read_body(r)),
        Err(e) => return Err(e.to_string()),
    };
    if !(200..300).contains(&status) {
        let snip: String = body.trim().chars().take(240).collect();
        return Err(if snip.is_empty() { format!("provider returned HTTP {status}") } else { format!("provider returned HTTP {status}: {snip}") });
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("invalid models JSON: {e}"))?;
    let models = parse_models(&v);
    if models.is_empty() { return Err("provider returned no models".into()) }
    Ok(models)
}

fn read_body(r: ureq::Response) -> String {
    let mut s = String::new();
    let _ = r.into_reader().take(MAX_BODY).read_to_string(&mut s);
    s
}

fn plausible_key(raw: &str) -> bool {
    let l = raw.trim().to_ascii_lowercase();
    raw.trim().len() <= MAX_KEY
        && !["authentication required", "credentials were rejected", "run /login", "run `/login`", "re-authenticate", "session has expired"].iter().any(|w| l.contains(w))
}

fn table<'a>(t: &'a mut Table, name: &str) -> Result<&'a mut Table, String> {
    t.entry(name).or_insert_with(|| Item::Table(Table::new())).as_table_mut().ok_or_else(|| format!("[{name}] is not a table"))
}

/// Saving a `/setup` provider retires the older Studio provider list: its `[model.studio-*]`
/// tables and a `[models] default` naming one go, plus the lock-ins `clean_studio_locks` removes.
/// User-written models and lists are left alone.
fn drop_studio(doc: &mut DocumentMut) {
    clean_studio_locks(doc);
    if let Some(m) = doc.get_mut("model").and_then(Item::as_table_mut) {
        let stale: Vec<String> = m.iter().map(|(k, _)| k.to_string()).filter(|k| is_studio_id(k)).collect();
        for k in stale { m.remove(&k); }
    }
    if let Some(m) = doc.get_mut("models").and_then(Item::as_table_mut) {
        if m.get("default").and_then(Item::as_str).is_some_and(is_studio_id) { m.remove("default"); }
    }
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaveReq {
    pub provider_id: String,
    pub base_url: String,
    /// None = keep the saved key when the base URL matches (or use the Nous login token).
    pub api_key: Option<String>,
    pub format: String,
    pub model_id: String,
    #[serde(default)]
    pub model_name: String,
}

/// The CLI's `apply_provider_setup_to_document`, plus the Studio cleanup above.
pub fn apply(doc: &mut DocumentMut, r: &SaveReq, key: &str) -> Result<(), String> {
    let base = normalize_base_url(&r.base_url)?;
    let key = key.trim();
    if !key.is_empty() && !plausible_key(key) { return Err("provider API key looks like an error message, not a credential".into()) }
    let mid = r.model_id.trim();
    if mid.is_empty() || mid.len() > 200 { return Err("model identifier is empty or too long".into()) }
    let name = if r.model_name.trim().is_empty() { mid } else { r.model_name.trim() };
    let be = backend(&r.format);
    drop_studio(doc);
    let root = doc.as_table_mut();
    {
        let e = table(root, "endpoints")?;
        e.insert("api_base_url", value(&base));
        e.insert("models_base_url", value(&base));
        e.insert("models_list_url", value(models_list_url(&base)));
    }
    table(root, "models")?.insert("default", value(mid));
    {
        let p = table(table(root, "model_providers")?, SETUP_ID)?;
        p.insert("base_url", value(&base));
        p.insert("api_backend", value(be));
        p.insert("id", value(if r.provider_id.trim().is_empty() { "custom" } else { r.provider_id.trim() }));
        if key.is_empty() { p.remove("api_key"); } else { p.insert("api_key", value(key)); }
    }
    let m = table(table(root, "model")?, mid)?;
    m.insert("model", value(mid));
    m.insert("base_url", value(&base));
    m.insert("name", value(name));
    m.insert("api_backend", value(be));
    m.insert("auth_scheme", value(if be == "messages" { "x_api_key" } else { "bearer" }));
    m.insert("model_provider", value(SETUP_ID));
    if be == "messages" {
        let h = m.entry("extra_headers").or_insert_with(|| Item::Table(Table::new())).as_table_like_mut().ok_or("extra_headers is not a table")?;
        h.insert("anthropic-version", value("2023-06-01"));
    } else if let Some(h) = m.get_mut("extra_headers").and_then(Item::as_table_like_mut) {
        let stale: Vec<String> = h.iter().filter(|(k, _)| k.eq_ignore_ascii_case("anthropic-version")).map(|(k, _)| k.to_owned()).collect();
        for k in stale { h.remove(&k); }
    }
    if key.is_empty() { m.remove("api_key"); } else { m.insert("api_key", value(key)); }
    Ok(())
}

fn load() -> DocumentMut {
    std::fs::read_to_string(config_path()).unwrap_or_default().parse().unwrap_or_default()
}

fn saved_provider(doc: &DocumentMut) -> Option<&Table> {
    doc.get("model_providers")?.get(SETUP_ID)?.as_table()
}

/// The saved `/setup` key, only when the saved provider has the same base URL (as the CLI
/// does since 1.3.42): a key saved for one provider is never sent to another.
fn saved_key(doc: &DocumentMut, base_url: &str) -> String {
    let Some(p) = saved_provider(doc) else { return String::new() };
    let Ok(want) = normalize_base_url(base_url) else { return String::new() };
    let same = p.get("base_url").and_then(Item::as_str).and_then(|b| normalize_base_url(b).ok()).is_some_and(|b| b.eq_ignore_ascii_case(&want));
    if !same { return String::new() }
    p.get("api_key").and_then(Item::as_str).filter(|k| plausible_key(k)).unwrap_or_default().to_owned()
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub provider_id: Option<String>,
    pub base_url: Option<String>,
    pub format: Option<String>,
    pub model: Option<String>,
    pub has_key: bool,
    pub nous_signed_in: bool,
}

pub fn status_of(doc: &DocumentMut) -> Status {
    let p = saved_provider(doc);
    let s = |t: Option<&Table>, k: &str| t.and_then(|t| t.get(k)).and_then(Item::as_str).map(str::to_owned);
    Status {
        provider_id: s(p, "id"),
        base_url: s(p, "base_url").or_else(|| doc.get("endpoints").and_then(|e| e.get("api_base_url")).and_then(Item::as_str).map(str::to_owned)),
        format: s(p, "api_backend"),
        model: doc.get("models").and_then(|m| m.get("default")).and_then(Item::as_str).map(str::to_owned),
        has_key: p.and_then(|p| p.get("api_key")).and_then(Item::as_str).is_some_and(|k| !k.trim().is_empty()),
        nous_signed_in: nous_load().is_some_and(|s| !s.access_token.is_empty()),
    }
}

// ---- Nous Portal device-code login (same endpoints and file as the CLI) ----

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct NousState {
    pub access_token: String,
    #[serde(default)] pub refresh_token: String,
    #[serde(default)] pub token_type: String,
    #[serde(default)] pub scope: String,
    #[serde(default)] pub client_id: String,
    #[serde(default)] pub portal_base_url: String,
    #[serde(default)] pub inference_base_url: String,
    #[serde(default)] pub expires_at: Option<u64>,
}

fn nous_path() -> std::path::PathBuf {
    config_path().parent().map(|p| p.join("nous_oauth.json")).unwrap_or_else(|| "nous_oauth.json".into())
}
fn nous_client() -> String {
    std::env::var("SUPERCHARGE_NOUS_OAUTH_CLIENT_ID").ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).unwrap_or_else(|| NOUS_CLIENT.into())
}
fn nous_load() -> Option<NousState> { serde_json::from_str(&std::fs::read_to_string(nous_path()).ok()?).ok() }

fn jwt_exp(token: &str) -> Option<u64> {
    use base64::Engine;
    let p = token.split('.').nth(1)?;
    let b = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<Value>(&b).ok()?.get("exp")?.as_u64()
}

pub fn nous_state_from(v: &Value, cid: &str) -> Result<NousState, String> {
    let access = v.get("access_token").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("Nous token response missing access_token")?;
    let str_or = |k: &str, d: &str| v.get(k).and_then(Value::as_str).unwrap_or(d).to_owned();
    Ok(NousState {
        access_token: access.into(),
        refresh_token: str_or("refresh_token", ""),
        token_type: str_or("token_type", "Bearer"),
        scope: str_or("scope", NOUS_SCOPE),
        client_id: cid.into(),
        portal_base_url: PORTAL.into(),
        inference_base_url: NOUS_INFERENCE.into(),
        expires_at: jwt_exp(access).or_else(|| v.get("expires_in").and_then(Value::as_u64).map(|s| now() + s)),
    })
}

fn nous_save(s: &NousState) -> Result<(), String> {
    write_atomic(&nous_path(), &serde_json::to_string_pretty(s).map_err(|e| e.to_string())?)
}

fn post_form(url: &str, form: &[(&str, &str)]) -> Result<(u16, Value, String), String> {
    let (status, body) = match http().post(url).set("Accept", "application/json").send_form(form) {
        Ok(r) => (r.status(), read_body(r)),
        Err(ureq::Error::Status(c, r)) => (c, read_body(r)),
        Err(e) => return Err(e.to_string()),
    };
    Ok((status, serde_json::from_str(&body).unwrap_or(Value::Null), body.trim().chars().take(240).collect()))
}

/// Current access token, refreshed when it expires within two minutes.
fn nous_token() -> Result<String, String> {
    let mut s = nous_load().ok_or("Nous Portal is not signed in. Sign in with Nous Research first.")?;
    let exp = s.expires_at.or_else(|| jwt_exp(&s.access_token));
    if exp.is_some_and(|e| now() + 120 >= e) {
        if s.refresh_token.trim().is_empty() { return Err("Nous refresh token missing; sign in with Nous Research again".into()) }
        let cid = if s.client_id.is_empty() { nous_client() } else { s.client_id.clone() };
        let portal = if s.portal_base_url.is_empty() { PORTAL.to_owned() } else { s.portal_base_url.trim_end_matches('/').to_owned() };
        let (code, v, snip) = post_form(&format!("{portal}/api/oauth/token"), &[("grant_type", "refresh_token"), ("client_id", &cid), ("refresh_token", &s.refresh_token)])?;
        if !(200..300).contains(&code) {
            let err = v.get("error").and_then(Value::as_str).unwrap_or_default();
            if err == "invalid_grant" || err == "refresh_token_reused" {
                let _ = std::fs::remove_file(nous_path());
                return Err("Nous login expired; sign in with Nous Research again".into());
            }
            return Err(format!("Nous refresh HTTP {code}: {snip}"));
        }
        let mut next = nous_state_from(&v, &cid)?;
        if next.refresh_token.is_empty() { next.refresh_token = s.refresh_token.clone() }
        nous_save(&next)?;
        s = next;
    }
    if s.access_token.is_empty() { return Err("Nous access token empty; sign in with Nous Research again".into()) }
    Ok(s.access_token)
}

struct Pending { device_code: String, deadline: u64 }
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart { pub user_code: String, pub verification_uri: String, pub expires_in: u64, pub interval: u64 }

fn device_start() -> Result<DeviceStart, String> {
    let cid = nous_client();
    let (code, v, snip) = post_form(&format!("{PORTAL}/api/oauth/device/code"), &[("client_id", &cid), ("scope", NOUS_SCOPE)])?;
    if !(200..300).contains(&code) { return Err(format!("Nous device-code HTTP {code}: {snip}")) }
    let get = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let device_code = get("device_code").ok_or("Nous device-code missing device_code")?;
    let user_code = get("user_code").ok_or("Nous device-code missing user_code")?;
    let uri = get("verification_uri_complete").or_else(|| get("verification_uri")).unwrap_or_else(|| format!("{PORTAL}/oauth/device"));
    let expires_in = v.get("expires_in").and_then(Value::as_u64).unwrap_or(900);
    let interval = v.get("interval").and_then(Value::as_u64).unwrap_or(5).clamp(1, 5);
    *PENDING.lock().unwrap() = Some(Pending { device_code, deadline: now() + expires_in.max(30) });
    Ok(DeviceStart { user_code, verification_uri: uri, expires_in, interval })
}

/// One token request: "pending", "slow_down" or "done" (tokens saved).
fn device_poll() -> Result<&'static str, String> {
    let (dc, deadline) = match PENDING.lock().unwrap().as_ref() { Some(p) => (p.device_code.clone(), p.deadline), None => return Err("No Nous login in progress".into()) };
    if now() >= deadline { *PENDING.lock().unwrap() = None; return Err("Timed out waiting for Nous Portal approval".into()) }
    let cid = nous_client();
    let (code, v, snip) = post_form(&format!("{PORTAL}/api/oauth/token"), &[("grant_type", "urn:ietf:params:oauth:grant-type:device_code"), ("client_id", &cid), ("device_code", &dc)])?;
    if (200..300).contains(&code) {
        nous_save(&nous_state_from(&v, &cid)?)?;
        *PENDING.lock().unwrap() = None;
        return Ok("done");
    }
    match v.get("error").and_then(Value::as_str).unwrap_or("") {
        "authorization_pending" => Ok("pending"),
        "slow_down" => Ok("slow_down"),
        e @ ("expired_token" | "access_denied") => { *PENDING.lock().unwrap() = None; Err(format!("Nous login {e}")) }
        _ => Err(format!("Nous token HTTP {code}: {snip}")),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn setup_status() -> Result<Status, String> { blocking(|| Ok(status_of(&load()))).await }

/// List models like `/setup`. `api_key: None` reuses the saved key (or the Nous token).
#[tauri::command]
pub async fn setup_models(provider_id: String, base_url: String, api_key: Option<String>, format: String) -> Result<Vec<SetupModel>, String> {
    blocking(move || {
        let fallback = api_key_or(&base_url, api_key);
        let key = if provider_id == "nous" {
            nous_token().or_else(|e| if fallback.trim().is_empty() { Err(e) } else { Ok(fallback) })?
        } else { fallback };
        fetch_models(&base_url, &key, &format)
    }).await
}

fn api_key_or(base_url: &str, key: Option<String>) -> String {
    key.unwrap_or_else(|| saved_key(&load(), base_url))
}

#[tauri::command]
pub async fn setup_save(req: SaveReq) -> Result<Status, String> {
    blocking(move || {
        let key = if req.provider_id == "nous" && req.api_key.is_none() { nous_token()? } else { api_key_or(&req.base_url, req.api_key.clone()) };
        edit_config(&config_path(), |doc| { apply(doc, &req, &key)?; Ok(status_of(doc)) })
    }).await
}

#[tauri::command]
pub async fn setup_device_start() -> Result<DeviceStart, String> { blocking(device_start).await }

#[tauri::command]
pub async fn setup_device_poll() -> Result<String, String> { blocking(|| device_poll().map(String::from)).await }

#[tauri::command]
pub fn setup_device_cancel() { *PENDING.lock().unwrap() = None; }

/// Open the sign-in page in the default browser (https only).
#[tauri::command]
pub fn setup_open(url: String) -> Result<(), String> {
    let u = tauri::Url::parse(&url).map_err(|_| "invalid URL")?;
    if u.scheme() != "https" { return Err("only https links can be opened".into()) }
    crate::git::open_url(u.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: &str, url: &str, format: &str, model: &str) -> SaveReq {
        SaveReq { provider_id: id.into(), base_url: url.into(), api_key: None, format: format.into(), model_id: model.into(), model_name: String::new() }
    }

    #[test]
    fn base_url_rules_match_the_cli() {
        assert_eq!(normalize_base_url(" api.example.com/v1/ ").unwrap(), "https://api.example.com/v1");
        assert_eq!(normalize_base_url("http://127.0.0.1:11434/v1/models").unwrap(), "http://127.0.0.1:11434/v1");
        assert!(normalize_base_url("http://example.com/v1").unwrap_err().contains("localhost"));
        assert!(normalize_base_url("ftp://x").is_err());
        assert!(normalize_base_url("").is_err());
    }

    #[test]
    fn models_url_follows_the_cli() {
        assert_eq!(models_list_url("https://api.z.ai/api/paas/v4"), "https://api.z.ai/api/paas/v4/models");
        assert_eq!(models_list_url("https://api.moonshot.ai/anthropic"), "https://api.moonshot.ai/anthropic/models");
        assert_eq!(models_list_url("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"), "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models");
        assert_eq!(models_list_url("https://example.com"), "https://example.com/v1/models");
    }

    #[test]
    fn parses_sorts_and_filters_models() {
        let v = serde_json::json!({"data": [{"id": "b", "context_length": 8192}, {"id": "text-embedding-3"}, {"id": "a", "display_name": "Alpha"}, "c", {"id": "a"}]});
        let m = parse_models(&v);
        assert_eq!(m.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(m[0].name, "Alpha");
        assert_eq!(m[1].context, Some(8192));
    }

    #[test]
    fn writes_the_cli_setup_layout_and_drops_studio_entries() {
        let mut doc: DocumentMut = "[models]\ndefault = \"studio-a-1\"\nweb_search = \"studio-a-1\"\nallowed_models = [\"studio-a-1\"]\n\n[model.studio-a-1]\nmodel = \"x\"\n\n[model.mine]\nmodel = \"keep\"\n\n[ui]\nfork_secondary_model = \"studio-a-1\"\nyolo = true\n".parse().unwrap();
        apply(&mut doc, &req("anthropic", "https://api.anthropic.com/v1", "messages", "m1"), "sk-test").unwrap();
        assert_eq!(doc["endpoints"]["api_base_url"].as_str(), Some("https://api.anthropic.com/v1"));
        assert_eq!(doc["endpoints"]["models_list_url"].as_str(), Some("https://api.anthropic.com/v1/models"));
        assert_eq!(doc["models"]["default"].as_str(), Some("m1"));
        assert!(doc["models"].get("web_search").is_none() && doc["models"].get("allowed_models").is_none());
        let p = &doc["model_providers"]["setup"];
        assert_eq!((p["id"].as_str(), p["api_backend"].as_str(), p["api_key"].as_str()), (Some("anthropic"), Some("messages"), Some("sk-test")));
        let m = &doc["model"]["m1"];
        assert_eq!(m["auth_scheme"].as_str(), Some("x_api_key"));
        assert_eq!(m["model_provider"].as_str(), Some("setup"));
        assert_eq!(m["extra_headers"]["anthropic-version"].as_str(), Some("2023-06-01"));
        assert!(doc["model"].get("studio-a-1").is_none() && doc["model"].get("mine").is_some());
        assert!(doc["ui"].get("fork_secondary_model").is_none());
        assert_eq!(doc["ui"]["yolo"].as_bool(), Some(true));
        // Switching to a keyless local Chat Completions endpoint drops the key and the header.
        let mut r = req("ollama", "http://127.0.0.1:11434/v1", "chat_completions", "m1");
        r.model_name = "Local".into();
        apply(&mut doc, &r, "").unwrap();
        let m = &doc["model"]["m1"];
        assert!(m.get("api_key").is_none() && doc["model_providers"]["setup"].get("api_key").is_none());
        assert_eq!((m["auth_scheme"].as_str(), m["name"].as_str()), (Some("bearer"), Some("Local")));
        assert!(m["extra_headers"].get("anthropic-version").is_none());
        let s = status_of(&doc);
        assert_eq!((s.provider_id.as_deref(), s.model.as_deref(), s.has_key), (Some("ollama"), Some("m1"), false));
    }

    #[test]
    fn rejects_error_text_as_a_key_and_empty_models() {
        let mut doc = DocumentMut::new();
        assert!(apply(&mut doc, &req("openai", "https://api.openai.com/v1", "chat_completions", "gpt"), "Authentication required: run /login").is_err());
        assert!(apply(&mut doc, &req("openai", "https://api.openai.com/v1", "chat_completions", " "), "k").is_err());
    }

    #[test]
    fn saved_key_only_for_the_same_base_url() {
        let mut doc = DocumentMut::new();
        apply(&mut doc, &req("one", "https://api.one.example/v1", "chat_completions", "m"), "gk").unwrap();
        assert_eq!(saved_key(&doc, "https://api.one.example/v1"), "gk");
        assert_eq!(saved_key(&doc, "api.one.example/v1/"), "gk");
        assert_eq!(saved_key(&doc, "https://api.two.example/v1"), "");
        assert_eq!(saved_key(&doc, "https://api.one.example/other/v1"), "");
        assert_eq!(saved_key(&DocumentMut::new(), "https://api.one.example/v1"), "");
    }

    #[test]
    fn setup_save_never_writes_allowed_or_role_models_and_keeps_user_lists() {
        let mut doc: DocumentMut = "[models]\nallowed_models = [\"mine\", \"studio-a-1\"]\nweb_search = \"mine\"\n\n[model.mine]\nmodel = \"x\"\n".parse().unwrap();
        apply(&mut doc, &req("two", "https://api.two.example/v1", "chat_completions", "m2"), "k").unwrap();
        let s = doc.to_string();
        for k in ["session_summary", "prompt_suggestion", "image_description", "fork_secondary_model", "studio-a-1"] { assert!(!s.contains(k), "{k}: {s}"); }
        assert_eq!(doc["models"]["web_search"].as_str(), Some("mine"));
        assert_eq!(doc["models"]["allowed_models"].as_array().unwrap().len(), 1);
        let mut fresh = DocumentMut::new();
        apply(&mut fresh, &req("two", "https://api.two.example/v1", "chat_completions", "m2"), "k").unwrap();
        assert!(!fresh.to_string().contains("allowed_models"));
    }

    #[test]
    fn nous_tokens_use_the_cli_file_format() {
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":1700000000}"#);
        let s = nous_state_from(&serde_json::json!({"access_token": format!("h.{payload}.s"), "refresh_token": "r"}), "cid").unwrap();
        assert_eq!(s.expires_at, Some(1_700_000_000));
        let j: Value = serde_json::to_value(&s).unwrap();
        for k in ["access_token", "refresh_token", "token_type", "scope", "client_id", "portal_base_url", "inference_base_url", "expires_at"] { assert!(j.get(k).is_some(), "{k}") }
        assert_eq!(j["inference_base_url"], NOUS_INFERENCE);
        assert!(nous_state_from(&serde_json::json!({}), "cid").is_err());
    }

    fn serve_once(body: &'static str, status: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", l.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0; 4096];
            let n = s.read(&mut buf).unwrap();
            write!(s, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase()
        });
        (base, h)
    }

    #[test]
    fn lists_models_with_the_cli_auth_headers() {
        let (base, h) = serve_once(r#"{"data":[{"id":"m1"}]}"#, "200 OK");
        assert_eq!(fetch_models(&base, "k1", "messages").unwrap()[0].id, "m1");
        let req = h.join().unwrap();
        assert!(req.starts_with("get /v1/models "));
        assert!(req.contains("x-api-key: k1") && req.contains("anthropic-version: 2023-06-01") && !req.contains("authorization"));
        let (base, h) = serve_once(r#"[{"id":"m2"}]"#, "200 OK");
        fetch_models(&base, "k2", "chat_completions").unwrap();
        assert!(h.join().unwrap().contains("authorization: bearer k2"));
        let (base, h) = serve_once("nope", "401 Unauthorized");
        assert_eq!(fetch_models(&base, "bad", "responses").unwrap_err(), "provider returned HTTP 401: nope");
        h.join().unwrap();
        let (base, h) = serve_once(r#"{"data":[]}"#, "200 OK");
        assert_eq!(fetch_models(&base, "", "chat_completions").unwrap_err(), "provider returned no models");
        h.join().unwrap();
    }
}
