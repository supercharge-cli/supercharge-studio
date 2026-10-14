//! First-run setup of the Supercharge CLI: detect it (and its version), and install or update it
//! from the official release assets with SHA-256 verification, into a user-local directory
//! (no sudo/admin). Progress goes to the UI as `cli://progress` events and to the agent log.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const REPO: &str = "https://github.com/supercharge-cli/supercharge-releases";
/// Oldest CLI the app runs with.
pub const MIN_VERSION: &str = "1.3.30";

pub fn fallback_command() -> &'static str {
    if cfg!(windows) {
        "irm https://raw.githubusercontent.com/supercharge-cli/supercharge-releases/main/scripts/install.ps1 | iex"
    } else {
        "curl -fsSL https://raw.githubusercontent.com/supercharge-cli/supercharge-releases/main/scripts/install.sh | bash"
    }
}

/// "supercharge 1.3.30 (63a040307f39)" -> "1.3.30"
pub fn parse_version(out: &str) -> Option<String> {
    out.split_whitespace().map(|w| w.trim_start_matches('v')).find(|w| {
        let p: Vec<&str> = w.split(['.', '-', '+']).take(3).collect();
        p.len() == 3 && p.iter().all(|x| !x.is_empty() && x.chars().all(|c| c.is_ascii_digit()))
    }).map(|w| w.split(['-', '+']).next().unwrap_or(w).to_string())
}

/// Numeric semver comparison of X.Y.Z (pre-release parts ignored).
pub fn older(a: &str, b: &str) -> bool {
    let n = |s: &str| s.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    n(a) < n(b)
}

pub fn asset_name() -> Result<String, String> {
    let os = match std::env::consts::OS { "linux" => "linux", "macos" => "macos", "windows" => "windows", o => return Err(format!("unsupported OS: {o}")) };
    let arch = match std::env::consts::ARCH { "x86_64" => "x86_64", "aarch64" => "aarch64", a => return Err(format!("unsupported architecture: {a}")) };
    Ok(format!("supercharge-{os}-{arch}{}", if os == "windows" { ".exe" } else { "" }))
}

/// Find `asset` in a SHA256SUMS file ("<hex>  [release/]<name>").
pub fn sum_for(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let (h, f) = (it.next()?, it.next()?);
        let f = f.trim_start_matches('*');
        (f == asset || f.rsplit('/').next() == Some(asset)).then(|| h.to_ascii_lowercase())
    }).filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
}

pub fn bin_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("SUPERCHARGE_BIN_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".local").join("bin")
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(60)).user_agent("supercharge-studio").build()
}

fn get_text(url: &str) -> Result<String, String> {
    agent().get(url).call().map_err(|e| format!("{url}: {e}"))?.into_string().map_err(|e| e.to_string())
}

pub fn latest_version() -> Result<String, String> {
    let v = get_text(&format!("{REPO}/releases/latest/download/version"))?;
    let v = v.trim().trim_start_matches('v').to_string();
    parse_version(&v).ok_or_else(|| format!("unexpected version file: {v:?}"))
}

fn installed_version(bin: &std::path::Path) -> Option<String> {
    let o = std::process::Command::new(bin).arg("--version").stdin(std::process::Stdio::null()).output().ok()?;
    parse_version(&String::from_utf8_lossy(&o.stdout)).or_else(|| parse_version(&String::from_utf8_lossy(&o.stderr)))
}

#[derive(Serialize)]
pub struct CliStatus {
    bin: Option<String>,
    version: Option<String>,
    latest: Option<String>,
    min: &'static str,
    /// Installed but older than MIN_VERSION: must update to run.
    too_old: bool,
    update_available: bool,
    fallback: &'static str,
    install_dir: String,
}

/// Where the CLI is, its version, and the latest release (when reachable).
#[tauri::command]
pub async fn cli_status(check_latest: Option<bool>) -> CliStatus {
    tauri::async_runtime::spawn_blocking(move || {
        *crate::agent::BIN.lock().unwrap() = None;
        let bin = crate::agent::resolve();
        let version = bin.as_deref().and_then(installed_version);
        let latest = if check_latest.unwrap_or(true) { latest_version().ok() } else { None };
        let too_old = version.as_deref().map(|v| older(v, MIN_VERSION)).unwrap_or(false);
        let update_available = matches!((&version, &latest), (Some(v), Some(l)) if older(v, l));
        CliStatus { bin: bin.map(|p| p.display().to_string()), version, latest, min: MIN_VERSION, too_old, update_available, fallback: fallback_command(), install_dir: bin_dir().display().to_string() }
    })
    .await
    .unwrap_or(CliStatus { bin: None, version: None, latest: None, min: MIN_VERSION, too_old: false, update_available: false, fallback: fallback_command(), install_dir: bin_dir().display().to_string() })
}

fn progress(app: &AppHandle, step: &str, pct: Option<f64>, msg: &str) {
    crate::agent::log_line(&format!("cli install: {step}: {msg}"));
    let _ = app.emit("cli://progress", serde_json::json!({ "step": step, "pct": pct, "msg": msg }));
}

/// Download, verify and install the latest (or `version`) CLI. Returns the installed path.
#[tauri::command]
pub async fn cli_install(app: AppHandle, version: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app, version)).await.map_err(|e| e.to_string())?
}

fn install(app: &AppHandle, version: Option<String>) -> Result<String, String> {
    let r = (|| {
        progress(app, "version", None, "checking the latest release");
        let v = match version { Some(v) => v.trim_start_matches('v').to_string(), None => latest_version()? };
        let asset = asset_name()?;
        let base = format!("{REPO}/releases/download/v{v}");
        progress(app, "version", None, &format!("Supercharge CLI {v} ({asset})"));
        let sums = get_text(&format!("{base}/SHA256SUMS"))?;
        let want = sum_for(&sums, &asset).ok_or_else(|| format!("{asset} is not listed in SHA256SUMS"))?;

        let dir = bin_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let exe = if cfg!(windows) { "supercharge.exe" } else { "supercharge" };
        let tmp = dir.join(format!(".{exe}.download"));
        let resp = agent().get(&format!("{base}/{asset}")).call().map_err(|e| format!("download failed: {e}"))?;
        let total: Option<u64> = resp.header("content-length").and_then(|s| s.parse().ok());
        let mut rd = resp.into_reader();
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        let (mut got, mut buf, mut last) = (0u64, vec![0u8; 64 * 1024], 0u64);
        loop {
            let n = rd.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
            if n == 0 { break; }
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            h.update(&buf[..n]);
            got += n as u64;
            if got - last > 512 * 1024 {
                last = got;
                let _ = app.emit("cli://progress", serde_json::json!({ "step": "download", "pct": total.map(|t| got as f64 / t as f64 * 100.0), "msg": format!("{:.1} MB", got as f64 / 1e6) }));
            }
        }
        drop(f);
        progress(app, "download", Some(100.0), &format!("{:.1} MB downloaded", got as f64 / 1e6));
        let have = h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
        if have != want {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("checksum mismatch for {asset}: expected {want}, got {have}"));
        }
        progress(app, "verify", None, &format!("SHA-256 verified ({}…)", &have[..12]));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        let ran = installed_version(&tmp);
        if ran.is_none() {
            let _ = std::fs::remove_file(&tmp);
            return Err("the downloaded CLI did not run (`--version` failed)".into());
        }
        let dest = dir.join(exe);
        // On Windows a running exe can't be replaced but can be renamed out of the way.
        #[cfg(windows)]
        if dest.exists() {
            let _ = std::fs::rename(&dest, dir.join(".supercharge.old.exe"));
        }
        std::fs::rename(&tmp, &dest).map_err(|e| format!("cannot install to {}: {e}", dest.display()))?;
        alias(&dir, &dest);
        add_to_path(&dir);
        *crate::agent::BIN.lock().unwrap() = Some(dest.clone());
        progress(app, "done", Some(100.0), &format!("installed {} at {}", ran.unwrap_or(v), dest.display()));
        Ok(dest.display().to_string())
    })();
    if let Err(e) = &r {
        progress(app, "error", None, e);
    }
    r
}

/// `sc` short alias, never overwriting an unrelated file.
fn alias(dir: &std::path::Path, dest: &std::path::Path) {
    #[cfg(unix)]
    {
        let sc = dir.join("sc");
        if std::fs::symlink_metadata(&sc).is_err() {
            let _ = std::os::unix::fs::symlink("supercharge", &sc);
        }
        let _ = dest;
    }
    #[cfg(windows)]
    {
        let sc = dir.join("sc.exe");
        if !sc.exists() || std::fs::metadata(&sc).ok().map(|m| m.len()) == std::fs::metadata(dest).ok().map(|m| m.len()) {
            let _ = std::fs::copy(dest, sc);
        }
    }
}

/// Make the install dir reachable: this process always; Windows also the user PATH (no admin).
fn add_to_path(dir: &std::path::Path) {
    let cur = std::env::var_os("PATH").unwrap_or_default();
    if !std::env::split_paths(&cur).any(|p| p == dir) {
        let mut v: Vec<PathBuf> = std::env::split_paths(&cur).collect();
        v.insert(0, dir.to_path_buf());
        if let Ok(j) = std::env::join_paths(v) {
            std::env::set_var("PATH", j);
        }
    }
    #[cfg(windows)]
    {
        let d = dir.display().to_string().replace('\'', "''");
        let ps = format!("$d='{d}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if (-not (($p -split ';') -contains $d)) {{ [Environment]::SetEnvironmentVariable('Path', ($(if ($p) {{ $p + ';' }} else {{ '' }}) + $d), 'User') }}");
        let _ = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &ps]).status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_and_sums() {
        assert_eq!(parse_version("supercharge 1.3.30 (63a040307f39)").as_deref(), Some("1.3.30"));
        assert_eq!(parse_version("v1.4.0-beta.1").as_deref(), Some("1.4.0"));
        assert_eq!(parse_version("garbage"), None);
        assert!(older("1.3.9", "1.3.30") && !older("1.3.30", "1.3.30") && older("1.3.30", "1.4.0"));
        let h = "a".repeat(64);
        let sums = format!("{h}  release/supercharge-linux-x86_64\n{}  release/sc-linux-x86_64\n", "b".repeat(64));
        assert_eq!(sum_for(&sums, "supercharge-linux-x86_64"), Some(h));
        assert_eq!(sum_for(&sums, "supercharge-macos-x86_64"), None);
        assert!(asset_name().unwrap().starts_with("supercharge-"));
    }
}
