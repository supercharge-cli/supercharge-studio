//! In-app updates: download, install, then relaunch on the user's click.
//!
//! - Windows (NSIS/MSI), macOS (.app) and Linux AppImage use the signed updater bundles
//!   (`latest.json` on the release). macOS and AppImage are installed right after the
//!   download; Windows runs its installer on Restart (it has to close the app to replace
//!   files) and the installer starts the new version.
//! - Linux rpm/deb installs: the package is downloaded over HTTPS to a temp dir, checked
//!   against the sha256 that the same release's `latest.json` lists for it, and only then
//!   installed with `pkexec` (the system asks for the password). No entry, no install.
//!   Restart starts the new binary once this process has exited.
//!
//! Progress is emitted as `update://progress` `{ done, total }`.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime};

/// Only release assets of this repository are ever downloaded and installed.
pub const RELEASE_PREFIX: &str = "https://github.com/supercharge-cli/supercharge-studio/releases/download/";

#[derive(Deserialize, Clone, Debug)]
pub struct PkgRequest {
    /// Package URL (a release asset).
    pub url: String,
    /// Asset name as listed in the release's `latest.json` (`packages`).
    pub name: String,
    /// "rpm" or "deb".
    pub format: String,
}

#[derive(Serialize, Clone, Copy)]
struct Progress {
    done: u64,
    total: u64,
}

enum Ready {
    /// Windows: the signed installer, run on Restart.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Installer(Box<tauri_plugin_updater::Update>, Vec<u8>),
    /// Installed in place (macOS, AppImage); Restart relaunches through the process plugin.
    Installed,
    /// rpm/deb upgraded by the package manager; Restart starts the new binary.
    Package,
}

static READY: Mutex<Option<Ready>> = Mutex::new(None);
/// One download at a time (a re-shown banner waits for the running one).
static BUSY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The `latest.json` of the release a package URL belongs to (same tag).
pub fn manifest_url(pkg_url: &str, name: &str) -> Result<String, String> {
    check_url(pkg_url)?;
    let rest = &pkg_url[RELEASE_PREFIX.len()..];
    match rest.split_once('/') {
        Some((tag, n)) if !tag.is_empty() && n == name && !n.contains('/') => Ok(format!("{RELEASE_PREFIX}{tag}/latest.json")),
        _ => Err(format!("not a release asset URL: {pkg_url}")),
    }
}

/// Lowercase hex sha256 that `latest.json` lists for `name`, only if its URL is `url`.
pub fn expected_sha(manifest: &serde_json::Value, name: &str, url: &str) -> Result<String, String> {
    let p = manifest.get("packages").and_then(|p| p.get(name)).ok_or_else(|| format!("{name} is not listed in latest.json; refusing to install"))?;
    if p.get("url").and_then(|u| u.as_str()) != Some(url) {
        return Err(format!("latest.json lists another URL for {name}; refusing to install"));
    }
    let h = p.get("sha256").and_then(|h| h.as_str()).unwrap_or_default();
    if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(h.to_ascii_lowercase())
    } else {
        Err(format!("latest.json has no valid sha256 for {name}; refusing to install"))
    }
}

/// SHA256 of a file, lowercase hex.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Ok when the file's SHA256 matches what `latest.json` lists for `name` at `url`.
pub fn verify(path: &Path, manifest: &serde_json::Value, name: &str, url: &str) -> Result<(), String> {
    let want = expected_sha(manifest, name, url)?;
    let got = sha256_file(path).map_err(|e| e.to_string())?;
    if got == want {
        Ok(())
    } else {
        Err(format!("checksum mismatch for {name}: expected {want}, got {got}; refusing to install"))
    }
}

/// The install command for a downloaded package (run through pkexec).
pub fn install_cmd(format: &str, path: &Path, has: impl Fn(&str) -> bool) -> Result<Vec<String>, String> {
    let p = path.to_string_lossy().to_string();
    let args: Vec<&str> = match format {
        "rpm" if has("dnf") => vec!["dnf", "install", "-y", &p],
        "rpm" if has("zypper") => vec!["zypper", "--non-interactive", "install", "--allow-unsigned-rpm", &p],
        "rpm" => vec!["rpm", "-U", &p],
        "deb" if has("apt") => vec!["apt", "install", "-y", &p],
        "deb" => vec!["dpkg", "-i", &p],
        _ => return Err(format!("unsupported package type: {format}")),
    };
    Ok(args.into_iter().map(String::from).collect())
}

fn on_path(bin: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
}

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(20))
        .timeout_read(std::time::Duration::from_secs(60))
        .user_agent("supercharge-studio")
        // Redirects to the release download host stay on HTTPS.
        .https_only(true)
        .build()
}

fn check_url(u: &str) -> Result<(), String> {
    if u.starts_with(RELEASE_PREFIX) && !u.contains("..") {
        Ok(())
    } else {
        Err(format!("refusing to download from {u}"))
    }
}

/// Download `url` into `dir/name`, reporting progress. Returns the file path.
fn download_to(url: &str, dir: &Path, name: &str, mut progress: impl FnMut(u64, u64)) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(format!("bad asset name: {name}"));
    }
    let res = http().get(url).call().map_err(|e| format!("download failed: {e}"))?;
    let total = res.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let path = dir.join(name);
    let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut r = res.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let (mut done, mut last) = (0u64, 0u64);
    loop {
        let n = r.read(&mut buf).map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last >= 256 * 1024 {
            last = done;
            progress(done, total);
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    progress(done, total.max(done));
    Ok(path)
}

/// rpm/deb: download, verify against the release's latest.json, install with pkexec.
fn pkg_update<R: Runtime>(app: &AppHandle<R>, req: &PkgRequest) -> Result<(), String> {
    let murl = manifest_url(&req.url, &req.name)?;
    let text = http().get(&murl).call().map_err(|e| format!("latest.json: {e}; refusing to install"))?.into_string().map_err(|e| e.to_string())?;
    let manifest: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("latest.json: {e}; refusing to install"))?;
    expected_sha(&manifest, &req.name, &req.url)?;
    let dir = std::env::temp_dir().join(format!("supercharge-studio-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = download_to(&req.url, &dir, &req.name, |done, total| {
        let _ = app.emit("update://progress", Progress { done, total });
    })?;
    verify(&path, &manifest, &req.name, &req.url)?;
    let args = install_cmd(&req.format, &path, on_path)?;
    let st = crate::hidden::std_cmd("pkexec").args(&args).status().map_err(|e| format!("pkexec: {e}"))?;
    let _ = std::fs::remove_dir_all(&dir);
    match st.code() {
        Some(0) => Ok(()),
        Some(126) | Some(127) => Err("the password prompt was cancelled".into()),
        c => Err(format!("{} exited with {}", args[0], c.map_or("a signal".into(), |c| c.to_string()))),
    }
}

/// Download (and, where the OS allows, install) the update. Returns how to restart:
/// "process" (relaunch through the process plugin) or "native" (call `update_restart`).
#[tauri::command]
pub async fn update_download<R: Runtime>(app: AppHandle<R>, pkg: Option<PkgRequest>) -> Result<String, String> {
    let _busy = BUSY.lock().await;
    if let Some(r) = READY.lock().unwrap().as_ref() {
        return Ok(match r {
            Ready::Installed => "process",
            _ => "native",
        }
        .into());
    }
    if let Some(req) = pkg {
        let a = app.clone();
        tauri::async_runtime::spawn_blocking(move || pkg_update(&a, &req)).await.map_err(|e| e.to_string())??;
        *READY.lock().unwrap() = Some(Ready::Package);
        return Ok("native".into());
    }
    signed_update(app).await
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn signed_update<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no signed update for this platform".to_string())?;
    let (mut done, mut last) = (0u64, 0u64);
    let a = app.clone();
    let bytes = update
        .download(
            move |n, total| {
                done += n as u64;
                if done - last >= 256 * 1024 || Some(done) == total {
                    last = done;
                    let _ = a.emit("update://progress", Progress { done, total: total.unwrap_or(0) });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    if cfg!(windows) {
        *READY.lock().unwrap() = Some(Ready::Installer(Box::new(update), bytes));
        return Ok("native".into());
    }
    update.install(&bytes).map_err(|e| e.to_string())?;
    *READY.lock().unwrap() = Some(Ready::Installed);
    Ok("process".into())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
async fn signed_update<R: Runtime>(_app: AppHandle<R>) -> Result<String, String> {
    Err("not supported on this platform".into())
}

/// The binary to start after a package upgrade (the running one was replaced on disk).
fn relaunch_path() -> PathBuf {
    let p = std::env::current_exe().unwrap_or_else(|_| "/usr/bin/supercharge-studio".into());
    let s = p.to_string_lossy();
    match s.strip_suffix(" (deleted)") {
        Some(x) => PathBuf::from(x),
        None => p,
    }
}

/// Finish the update and start the new version.
#[tauri::command]
pub fn update_restart<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    match READY.lock().unwrap().take() {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        Some(Ready::Installer(update, bytes)) => {
            // Windows: launches the installer (which restarts the app) and exits.
            update.install(&bytes).map_err(|e| e.to_string())?;
            Ok(())
        }
        Some(Ready::Package) => {
            // Wait for this process to exit (single instance), then start the new binary.
            let bin = relaunch_path();
            crate::hidden::std_cmd("sh")
                .arg("-c")
                .arg(r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$0""#)
                .arg(&bin)
                .arg(std::process::id().to_string())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            app.exit(0);
            Ok(())
        }
        _ => app.restart(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RPM: &str = "https://github.com/supercharge-cli/supercharge-studio/releases/download/v1.0.18/supercharge-studio-linux-x86_64.rpm";

    fn manifest(name: &str, url: &str, sha: &str) -> serde_json::Value {
        serde_json::json!({ "version": "1.0.18", "packages": { name: { "url": url, "sha256": sha } } })
    }

    #[test]
    fn takes_the_hash_from_latest_json_only_for_the_same_url() {
        let h = "0F343B0931126A20F133D67C2B018A3B5BD1C1D8A0A4F2D9F2D6C3D7A1E1F0A9";
        let name = "supercharge-studio-linux-x86_64.rpm";
        assert_eq!(expected_sha(&manifest(name, RPM, h), name, RPM).unwrap(), h.to_ascii_lowercase());
        // Not listed, another URL, a bad hash, or no packages at all: refuse.
        assert!(expected_sha(&manifest("other.rpm", RPM, h), name, RPM).unwrap_err().contains("refusing"));
        assert!(expected_sha(&manifest(name, "https://example.com/x.rpm", h), name, RPM).unwrap_err().contains("another URL"));
        assert!(expected_sha(&manifest(name, RPM, "nothex"), name, RPM).unwrap_err().contains("no valid sha256"));
        assert!(expected_sha(&serde_json::json!({ "platforms": {} }), name, RPM).is_err());
    }

    #[test]
    fn finds_the_manifest_of_the_same_release() {
        let name = "supercharge-studio-linux-x86_64.rpm";
        assert_eq!(manifest_url(RPM, name).unwrap(), "https://github.com/supercharge-cli/supercharge-studio/releases/download/v1.0.18/latest.json");
        assert!(manifest_url(RPM, "other.rpm").is_err());
        assert!(manifest_url("https://example.com/releases/download/v1/x.rpm", "x.rpm").is_err());
        assert!(manifest_url("http://github.com/supercharge-cli/supercharge-studio/releases/download/v1/x.rpm", "x.rpm").is_err());
        assert!(manifest_url("https://github.com/supercharge-cli/supercharge-studio/releases/download/x.rpm", "x.rpm").is_err());
    }

    #[test]
    fn verifies_downloads_against_latest_json() {
        let dir = std::env::temp_dir().join(format!("sc-upd-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("pkg.rpm");
        std::fs::write(&f, b"hello").unwrap();
        let good = manifest("pkg.rpm", RPM, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert!(verify(&f, &good, "pkg.rpm", RPM).is_ok());
        let bad = manifest("pkg.rpm", RPM, "00004dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert!(verify(&f, &bad, "pkg.rpm", RPM).unwrap_err().contains("mismatch"));
        assert!(verify(&f, &good, "other.rpm", RPM).unwrap_err().contains("not listed"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn picks_the_install_command() {
        let p = Path::new("/tmp/u/x.rpm");
        assert_eq!(install_cmd("rpm", p, |b| b == "dnf").unwrap(), ["dnf", "install", "-y", "/tmp/u/x.rpm"]);
        assert_eq!(install_cmd("rpm", p, |_| false).unwrap(), ["rpm", "-U", "/tmp/u/x.rpm"]);
        let d = Path::new("/tmp/u/x.deb");
        assert_eq!(install_cmd("deb", d, |b| b == "apt").unwrap(), ["apt", "install", "-y", "/tmp/u/x.deb"]);
        assert_eq!(install_cmd("deb", d, |_| false).unwrap(), ["dpkg", "-i", "/tmp/u/x.deb"]);
        assert!(install_cmd("exe", p, |_| true).is_err());
    }

    #[test]
    fn only_downloads_release_assets() {
        assert!(check_url("https://github.com/supercharge-cli/supercharge-studio/releases/download/v1.0.18/latest.json").is_ok());
        assert!(check_url("http://github.com/supercharge-cli/supercharge-studio/releases/download/v1.0.18/latest.json").is_err());
        assert!(check_url("https://example.com/x.rpm").is_err());
        assert!(check_url("https://github.com/supercharge-cli/supercharge-studio/releases/download/../../evil").is_err());
        assert!(download_to("https://x", Path::new("/tmp"), "../x", |_, _| {}).is_err());
    }

    /// Network check against a real release: `cargo test -- --ignored live_release`.
    #[test]
    #[ignore]
    fn live_release_package_verifies() {
        let name = "supercharge-studio-linux-x86_64.rpm";
        let url = format!("{RELEASE_PREFIX}v1.0.18/{name}");
        let manifest: serde_json::Value = serde_json::from_str(&http().get(&manifest_url(&url, name).unwrap()).call().unwrap().into_string().unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("sc-upd-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut last = (0, 0);
        let path = download_to(&url, &dir, name, |d, t| last = (d, t)).unwrap();
        assert!(last.0 > 1_000_000 && last.0 == last.1, "progress {last:?}");
        verify(&path, &manifest, name, &url).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
