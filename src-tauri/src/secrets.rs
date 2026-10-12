//! Secret storage: OS keychain first (macOS Keychain, Windows Credential Manager,
//! Linux Secret Service). If no keychain is reachable (e.g. a headless Linux box with
//! no Secret Service), falls back to a 0600 file in the app config dir and reports it.

use std::collections::BTreeMap;
use std::path::PathBuf;

const SERVICE: &str = "in.superchargeai.studio";

fn fallback_path() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("supercharge-studio").join("secrets.json")
}

fn read_fallback() -> BTreeMap<String, String> {
    std::fs::read(fallback_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_fallback(map: &BTreeMap<String, String>) -> Result<(), String> {
    let p = fallback_path();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_vec(map).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Returns (value, backend).
pub fn get(account: &str) -> (Option<String>, &'static str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, account) {
        match e.get_password() {
            Ok(v) => return (Some(v), "keychain"),
            Err(keyring::Error::NoEntry) => {
                if let Some(v) = read_fallback().get(account).cloned() {
                    return (Some(v), "file");
                }
                return (None, "keychain");
            }
            Err(_) => {}
        }
    }
    (read_fallback().get(account).cloned(), "file")
}

/// Store (empty value deletes). Returns the backend used.
pub fn set(account: &str, value: &str) -> Result<&'static str, String> {
    let mut fb = read_fallback();
    if let Ok(e) = keyring::Entry::new(SERVICE, account) {
        let r = if value.is_empty() {
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err),
            }
        } else {
            e.set_password(value)
        };
        if r.is_ok() {
            if fb.remove(account).is_some() {
                write_fallback(&fb)?;
            }
            return Ok("keychain");
        }
    }
    if value.is_empty() {
        fb.remove(account);
    } else {
        fb.insert(account.to_string(), value.to_string());
    }
    write_fallback(&fb)?;
    Ok("file")
}

#[tauri::command]
pub async fn secret_get(account: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || get(&account).0).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn secret_set(account: String, value: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || set(&account, &value).map(String::from))
        .await
        .map_err(|e| e.to_string())?
}
