//! Project file listing for `@` mentions in the composer, and small text reads to attach them.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Entry {
    /// Path relative to the project root, `/`-separated; folders end with `/`.
    pub path: String,
    pub dir: bool,
}

const SKIP: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".cache", "__pycache__", ".venv", "venv", ".gradle", ".idea", ".turbo", "coverage", ".svelte-kit", "Pods", ".DS_Store"];

/// Simple ignore names from the root `.gitignore` (plain names and `name/` only).
fn root_ignores(root: &Path) -> Vec<String> {
    std::fs::read_to_string(root.join(".gitignore"))
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().trim_start_matches('/').trim_end_matches('/').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('!') && !l.contains('*') && !l.contains('/'))
        .collect()
}

pub fn list(root: &Path, max: usize) -> Vec<Entry> {
    let ign = root_ignores(root);
    let mut out = Vec::new();
    // Breadth-first so shallow paths come first when the cap is hit.
    let mut queue: std::collections::VecDeque<(PathBuf, String, usize)> = std::collections::VecDeque::new();
    queue.push_back((root.to_path_buf(), String::new(), 0));
    while let Some((dir, rel, depth)) = queue.pop_front() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut items: Vec<_> = rd.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            let name = e.file_name().to_string_lossy().to_string();
            if SKIP.contains(&name.as_str()) || ign.iter().any(|i| *i == name) {
                continue;
            }
            // Do not follow symlinked folders (loops, escaping the project).
            let Ok(ft) = e.file_type() else { continue };
            let path = format!("{rel}{name}");
            if ft.is_dir() {
                out.push(Entry { path: format!("{path}/"), dir: true });
                if depth < 16 {
                    queue.push_back((e.path(), format!("{path}/"), depth + 1));
                }
            } else {
                out.push(Entry { path, dir: false });
            }
            if out.len() >= max {
                return out;
            }
        }
    }
    out
}

#[tauri::command]
pub async fn fs_list(root: String, max: Option<usize>) -> Result<Vec<Entry>, String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    let max = max.unwrap_or(20000).min(100000);
    tauri::async_runtime::spawn_blocking(move || list(&p, max)).await.map_err(|e| e.to_string())
}

/// Read a text file inside `root` (for attaching it to a prompt). Refuses paths outside the root,
/// binary files and files over `max` bytes.
#[tauri::command]
pub async fn fs_read_text(root: String, rel: String, max: Option<u64>) -> Result<String, String> {
    let root = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let full = std::fs::canonicalize(root.join(&rel)).map_err(|e| e.to_string())?;
    if !full.starts_with(&root) {
        return Err("outside the project".into());
    }
    let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
    if meta.len() > max.unwrap_or(256 * 1024) {
        return Err("too large".into());
    }
    let b = std::fs::read(&full).map_err(|e| e.to_string())?;
    if b.contains(&0) {
        return Err("binary".into());
    }
    String::from_utf8(b).map_err(|_| "not utf-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lists_and_skips() {
        let d = std::env::temp_dir().join(format!("scs-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src/deep")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(d.join("secret_out")).unwrap();
        std::fs::write(d.join(".gitignore"), "secret_out/\n*.log\n").unwrap();
        std::fs::write(d.join("src/deep/a.rs"), "x").unwrap();
        std::fs::write(d.join("README.md"), "x").unwrap();
        let paths: Vec<String> = list(&d, 100).into_iter().map(|e| e.path).collect();
        assert!(paths.contains(&"src/".to_string()) && paths.contains(&"src/deep/a.rs".to_string()) && paths.contains(&"README.md".to_string()));
        assert!(!paths.iter().any(|p| p.starts_with("node_modules") || p.starts_with("secret_out")));
        assert_eq!(list(&d, 2).len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }
}
