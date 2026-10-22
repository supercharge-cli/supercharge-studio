//! Project file listing for `@` mentions in the composer, and small text reads to attach them.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Entry {
    /// Path relative to the project root, `/`-separated; folders end with `/`.
    pub path: String,
    pub dir: bool,
    /// Folder whose contents were not walked (depth or size cap, or ignored); list it with `fs_list_dir`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
    /// Matched the built-in skip list or a root `.gitignore` name; the UI hides it unless asked.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ignored: bool,
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

fn entries_of(dir: &Path, rel: &str, ign: &[String]) -> Vec<(Entry, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut items: Vec<_> = rd.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    items
        .into_iter()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let ignored = SKIP.contains(&name.as_str()) || ign.iter().any(|i| *i == name);
            // Do not follow symlinked folders (loops, escaping the project).
            let ft = e.file_type().ok()?;
            let path = format!("{rel}{name}");
            Some(if ft.is_dir() {
                (Entry { path: format!("{path}/"), dir: true, partial: ignored, ignored }, e.path())
            } else {
                (Entry { path, dir: false, partial: false, ignored }, e.path())
            })
        })
        .collect()
}

/// Breadth-first so shallow paths come first. A folder is always listed whole; folders left unread by
/// the depth or entry cap come back `partial` so the tree can load them when expanded.
pub fn list(root: &Path, max: usize) -> Vec<Entry> {
    let ign = root_ignores(root);
    let mut out: Vec<Entry> = Vec::new();
    let mut queue: std::collections::VecDeque<(PathBuf, String, usize, Option<usize>)> = std::collections::VecDeque::new();
    queue.push_back((root.to_path_buf(), String::new(), 0, None));
    while let Some((dir, rel, depth, idx)) = queue.pop_front() {
        if out.len() >= max || depth > 16 {
            if let Some(i) = idx { out[i].partial = true; }
            for (_, _, _, i) in queue.drain(..) { if let Some(i) = i { out[i].partial = true; } }
            break;
        }
        for (e, p) in entries_of(&dir, &rel, &ign) {
            let walk = e.dir && !e.ignored;
            let path = e.path.clone();
            out.push(e);
            if walk { queue.push_back((p, path, depth + 1, Some(out.len() - 1))); }
        }
    }
    out
}

/// One folder's direct children (for folders the full listing left `partial`).
#[tauri::command]
pub async fn fs_list_dir(root: String, rel: String) -> Result<Vec<Entry>, String> {
    let r = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let full = std::fs::canonicalize(r.join(&rel)).map_err(|e| e.to_string())?;
    if !full.starts_with(&r) || !full.is_dir() {
        return Err("not a folder in the project".into());
    }
    let rel = if rel.is_empty() || rel.ends_with('/') { rel } else { format!("{rel}/") };
    tauri::async_runtime::spawn_blocking(move || {
        let ign = root_ignores(&r);
        entries_of(&full, &rel, &ign).into_iter().map(|(mut e, _)| { e.partial = e.dir; e }).collect()
    })
    .await
    .map_err(|e| e.to_string())
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
        let all = list(&d, 100);
        let hidden: Vec<&str> = all.iter().filter(|e| e.ignored).map(|e| e.path.as_str()).collect();
        assert_eq!(hidden, vec!["node_modules/", "secret_out/"]);
        assert!(!all.iter().any(|e| e.path.starts_with("node_modules/x")));
        assert!(all.iter().any(|e| e.path == ".gitignore"), "dot files are listed");
        // The cap never cuts a folder in half; unread folders are marked partial instead of vanishing.
        let capped = list(&d, 2);
        assert!(capped.iter().any(|e| e.path == "README.md"));
        assert!(capped.iter().find(|e| e.path == "src/").unwrap().partial);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn big_and_deep_folders_are_not_lost() {
        let d = std::env::temp_dir().join(format!("scs-files-big-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("big")).unwrap();
        for i in 0..300 { std::fs::write(d.join(format!("big/f{i:03}.txt")), "x").unwrap(); }
        let mut deep = d.join("deep");
        for i in 0..20 { deep = deep.join(format!("d{i}")); }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("leaf.rs"), "x").unwrap();
        let all = list(&d, 100);
        assert_eq!(all.iter().filter(|e| e.path.starts_with("big/f")).count(), 300, "a folder is listed whole even past the cap");
        let all = list(&d, 100000);
        let last = all.iter().filter(|e| e.dir && e.path.starts_with("deep/")).last().unwrap();
        assert!(last.partial, "the depth limit marks the folder instead of hiding it");
        let _ = std::fs::remove_dir_all(&d);
    }
}

/// Save an exported chat into the Downloads folder (or home) without overwriting; returns the path.
#[tauri::command]
pub fn export_save(name: String, text: String) -> Result<String, String> {
    let dir = dirs::download_dir().or_else(dirs::home_dir).ok_or("No Downloads folder")?;
    export_into(&dir, &name, &text)
}

fn export_into(dir: &Path, name: &str, text: &str) -> Result<String, String> {
    let clean: String = name.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '-' }).collect();
    let clean = clean.trim().trim_start_matches('.');
    let (stem, ext) = clean.rsplit_once('.').unwrap_or((clean, "txt"));
    let stem = if stem.is_empty() { "chat" } else { stem };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for i in 0..1000 {
        let p = dir.join(if i == 0 { format!("{stem}.{ext}") } else { format!("{stem} ({i}).{ext}") });
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            use std::io::Write;
            f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
            return Ok(p.to_string_lossy().into_owned());
        }
    }
    Err("Could not pick a file name".into())
}

#[cfg(test)]
mod export_tests {
    #[test]
    fn export_never_overwrites_and_cleans_names() {
        let d = std::env::temp_dir().join(format!("sc-export-{}", std::process::id()));
        let a = super::export_into(&d, "../My chat?.md", "one").unwrap();
        let b = super::export_into(&d, "../My chat?.md", "two").unwrap();
        assert!(a.ends_with("My chat-.md") && b.ends_with("My chat- (1).md"), "{a} {b}");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "one");
        let _ = std::fs::remove_dir_all(d);
    }
}
