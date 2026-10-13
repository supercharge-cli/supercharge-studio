//! Model providers managed by the app and applied to the Supercharge agent config
//! (~/.supercharge/config.toml). Each provider's models become `[model.studio-<id>-<n>]`
//! tables; the active provider's first model becomes the default for every role.
//! API keys are read from secure storage here, never sent through the UI.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use toml_edit::{value, Array, DocumentMut, Item, Table};

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

const PREFIX: &str = "studio-";
const ROLE_KEYS: &[&str] = &["default", "web_search", "session_summary", "prompt_suggestion", "image_description"];

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
    format!("{PREFIX}{}-{}", slug(&p.id), i + 1)
}

/// Pure transform: apply `active` (with its key) to a config document.
pub fn apply_to_doc(doc: &mut DocumentMut, active: &Provider, api_key: &str) -> Vec<String> {
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
            t.insert("api_key", value(api_key));
            t.insert("api_backend", value(active.format.as_str()));
            model_tbl.insert(&key, Item::Table(t));
            keys.push(key);
        }
    }
    if let Some(first) = keys.first().cloned() {
        if !doc.contains_table("models") {
            doc.insert("models", Item::Table(Table::new()));
        }
        let models = doc["models"].as_table_mut().unwrap();
        for k in ROLE_KEYS {
            models.insert(k, value(first.as_str()));
        }
        let mut allowed = Array::new();
        for k in &keys {
            allowed.push(k.as_str());
        }
        models.insert("allowed_models", value(allowed));
        if !doc.contains_table("ui") {
            doc.insert("ui", Item::Table(Table::new()));
        }
        doc["ui"]["fork_secondary_model"] = value(first.as_str());
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
    if provider.models.is_empty() {
        return Err("provider has no models".into());
    }
    if !["responses", "chat_completions", "messages"].contains(&provider.format.as_str()) {
        return Err(format!("unsupported API format: {}", provider.format));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = secrets::get(&key_account(&provider.id)).0.ok_or("no API key stored for this provider")?;
        let path = config_path();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let mut doc: DocumentMut = text.parse().map_err(|e| format!("config.toml: {e}"))?;
        let keys = apply_to_doc(&mut doc, &provider, &key);
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        // Atomic: write a private temp file next to it, then rename over the old config.
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, doc.to_string()).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(keys)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, models: &[&str]) -> Provider {
        Provider { id: id.into(), name: "Test".into(), base_url: "https://api.example.com/".into(), format: "responses".into(), models: models.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn applies_and_replaces_managed_models() {
        let mut doc: DocumentMut = "[ui]\nyolo = false\n\n[model.mine]\nmodel = \"keep\"\n".parse().unwrap();
        let keys = apply_to_doc(&mut doc, &p("a", &["m1", "m2"]), "k1");
        assert_eq!(keys, vec!["studio-a-1", "studio-a-2"]);
        let keys = apply_to_doc(&mut doc, &p("b", &["x"]), "k2");
        assert_eq!(keys, vec!["studio-b-1"]);
        let s = doc.to_string();
        assert!(s.contains("[model.mine]"));
        assert!(!s.contains("studio-a-"));
        assert!(s.contains("base_url = \"https://api.example.com\""));
        assert_eq!(doc["models"]["default"].as_str(), Some("studio-b-1"));
        assert_eq!(doc["models"]["session_summary"].as_str(), Some("studio-b-1"));
        assert_eq!(doc["ui"]["fork_secondary_model"].as_str(), Some("studio-b-1"));
        assert_eq!(doc["ui"]["yolo"].as_bool(), Some(false));
        assert_eq!(doc["model"]["studio-b-1"]["api_backend"].as_str(), Some("responses"));
    }
}
