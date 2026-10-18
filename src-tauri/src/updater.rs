//! In-app updates: download, install, then relaunch on the user's click.
//!
//! - Windows (NSIS/MSI), macOS (.app) and Linux AppImage use the signed updater bundles
//!   (`latest.json` on the release). macOS and AppImage are installed right after the
//!   download; Windows runs its installer on Restart (it has to close the app to replace
//!   files) and the installer starts the new version.
//! - Linux rpm/deb installs: the package is downloaded to a temp dir, checked against the
//!   release's SHA256SUMS and installed with `pkexec` (the system asks for the password).
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
    /// Asset name as listed in SHA256SUMS.
    pub name: String,
    /// The release's SHA256SUMS URL.
    pub sums: String,
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

/// Hex SHA256 for `name` in a `sha256sum` listing (`<hash>  <name>` or `<hash> *<name>`).
pub fn expected_sha(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let (h, n) = (it.next()?, it.next()?);
        (n.trim_start_matches('*') == name && h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())).then(|| h.to_ascii_lowercase())
    })
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

/// Ok when the file's SHA256 matches the SHA256SUMS line for `name`.
pub fn verify(path: &Path, sums: &str, name: &str) -> Result<(), String> {
    let want = expected_sha(sums, name).ok_or_else(|| format!("{name} is not listed in SHA256SUMS"))?;
    let got = sha256_file(path).map_err(|e| e.to_string())?;
    if got == want {
        Ok(())
    } else {
        Err(format!("checksum mismatch for {name}: expected {want}, got {got}"))
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

/// rpm/deb: download, verify against SHA256SUMS, install with pkexec.
fn pkg_update<R: Runtime>(app: &AppHandle<R>, req: &PkgRequest) -> Result<(), String> {
    check_url(&req.url)?;
    check_url(&req.sums)?;
    let sums = http().get(&req.sums).call().map_err(|e| format!("SHA256SUMS: {e}"))?.into_string().map_err(|e| e.to_string())?;
    expected_sha(&sums, &req.name).ok_or_else(|| format!("{} is not listed in SHA256SUMS", req.name))?;
    let dir = std::env::temp_dir().join(format!("supercharge-studio-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = download_to(&req.url, &dir, &req.name, |done, total| {
        let _ = app.emit("update://progress", Progress { done, total });
    })?;
    verify(&path, &sums, &req.name)?;
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

    const SUMS: &str = "0f343b0931126a20f133d67c2b018a3b5bd1c1d8a0a4f2d9f2d6c3d7a1e1f0a9  supercharge-studio-linux-x86_64.rpm\n\
        ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789 *supercharge-studio-linux-amd64.deb\n\
        nothex  SHA256SUMS\n";

    #[test]
    fn finds_the_hash_for_an_asset() {
        assert_eq!(expected_sha(SUMS, "supercharge-studio-linux-x86_64.rpm").unwrap(), "0f343b0931126a20f133d67c2b018a3b5bd1c1d8a0a4f2d9f2d6c3d7a1e1f0a9");
        // Binary-mode marker and upper case are accepted.
        assert_eq!(expected_sha(SUMS, "supercharge-studio-linux-amd64.deb").unwrap(), "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
        assert!(expected_sha(SUMS, "SHA256SUMS").is_none());
        assert!(expected_sha(SUMS, "x86_64.rpm").is_none());
    }

    #[test]
    fn verifies_downloads_against_sha256sums() {
        let dir = std::env::temp_dir().join(format!("sc-upd-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("pkg.rpm");
        std::fs::write(&f, b"hello").unwrap();
        let good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  pkg.rpm\n";
        assert!(verify(&f, good, "pkg.rpm").is_ok());
        let bad = good.replace("2cf2", "0000");
        assert!(verify(&f, &bad, "pkg.rpm").unwrap_err().contains("mismatch"));
        assert!(verify(&f, good, "other.rpm").unwrap_err().contains("not listed"));
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
        assert!(check_url("https://github.com/supercharge-cli/supercharge-studio/releases/download/v1.0.18/SHA256SUMS").is_ok());
        assert!(check_url("https://example.com/x.rpm").is_err());
        assert!(check_url("https://github.com/supercharge-cli/supercharge-studio/releases/download/../../evil").is_err());
        assert!(download_to("https://x", Path::new("/tmp"), "../x", |_, _| {}).is_err());
    }

    /// Network check against a real release: `cargo test -- --ignored live_release`.
    #[test]
    #[ignore]
    fn live_release_package_verifies() {
        let base = format!("{RELEASE_PREFIX}v1.0.17/");
        let sums = http().get(&format!("{base}SHA256SUMS")).call().unwrap().into_string().unwrap();
        let dir = std::env::temp_dir().join(format!("sc-upd-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = "supercharge-studio-linux-x86_64.rpm";
        let mut last = (0, 0);
        let path = download_to(&format!("{base}{name}"), &dir, name, |d, t| last = (d, t)).unwrap();
        assert!(last.0 > 1_000_000 && last.0 == last.1, "progress {last:?}");
        verify(&path, &sums, name).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
