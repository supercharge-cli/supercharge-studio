//! Agent server key storage in the OS keychain (macOS Keychain, Windows Credential
//! Manager, Linux Secret Service).

const SERVICE: &str = "in.superchargeai.studio";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn secret_get(account: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match entry(&account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_set(account: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let e = entry(&account)?;
        if value.is_empty() {
            match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            }
        } else {
            e.set_password(&value).map_err(|err| err.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
