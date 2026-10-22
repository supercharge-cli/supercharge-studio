//! Checkpoints of a project folder, taken before each prompt so a turn can be undone.
//! Git folders: the whole working tree (tracked + untracked, minus ignored files) is written
//! through a temporary index to a commit under the hidden ref `refs/supercharge/checkpoints/<id>`;
//! the user's index, branches and stash are never touched. Other folders: a file copy under
//! `~/.supercharge/studio-checkpoints/<folder hash>/<id>`.
use crate::hidden;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;

const REF: &str = "refs/supercharge/checkpoints/";
const SKIP: &[&str] = &[".git", "node_modules", "target", "dist", ".venv", "__pycache__"];
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 512 << 20;
const KEEP: usize = 30;

#[derive(Serialize, Debug, PartialEq)]
pub struct Checkpoint {
    pub id: String,
    pub kind: &'static str,
}

fn git(root: &Path, index: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut c = hidden::std_cmd("git");
    c.arg("-C").arg(root).args(["-c", "user.name=Supercharge Studio", "-c", "user.email=studio@localhost", "-c", "core.autocrlf=false"]);
    c.args(args).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C").stdin(Stdio::null());
    if let Some(i) = index {
        c.env("GIT_INDEX_FILE", i);
    }
    let out = c.output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn safe_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("bad checkpoint id: {id}"));
    }
    Ok(id)
}

fn git_root(cwd: &Path) -> Option<PathBuf> {
    git(cwd, None, &["rev-parse", "--show-toplevel"]).ok().filter(|s| !s.is_empty()).map(PathBuf::from)
}

/// Temporary index file, removed on drop.
struct TmpIndex(PathBuf);
impl TmpIndex {
    fn new(id: &str) -> Self {
        TmpIndex(std::env::temp_dir().join(format!("supercharge-checkpoint-{id}-{}.idx", std::process::id())))
    }
}
impl Drop for TmpIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn nul_list(s: &str) -> HashSet<String> {
    s.split('\0').filter(|x| !x.is_empty()).map(String::from).collect()
}

fn store_dir(cwd: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(cwd.to_string_lossy().as_bytes());
    let hex: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".supercharge").join("studio-checkpoints").join(hex)
}

/// Files under `root` (relative, '/'-separated), skipping heavy build/dependency folders.
fn walk(root: &Path) -> Result<Vec<(String, u64)>, String> {
    let mut out = vec![];
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(root.join(&rel)) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            let r = rel.join(&name);
            if ft.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    stack.push(r);
                }
            } else if ft.is_file() {
                out.push((r.to_string_lossy().replace('\\', "/"), e.metadata().map(|m| m.len()).unwrap_or(0)));
                if out.len() > MAX_FILES {
                    return Err("This folder is too large to checkpoint without git".into());
                }
            }
        }
    }
    Ok(out)
}

fn copy_files(from: &Path, to: &Path, files: &[(String, u64)]) -> Result<(), String> {
    for (f, _) in files {
        let dst = to.join(f);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(from.join(f), &dst).map_err(|e| format!("{f}: {e}"))?;
    }
    Ok(())
}

pub fn create(cwd: &Path, id: &str) -> Result<Checkpoint, String> {
    let id = safe_id(id)?;
    if let Some(root) = git_root(cwd) {
        let idx = TmpIndex::new(id);
        git(&root, Some(&idx.0), &["add", "-A", "--", "."])?;
        let tree = git(&root, Some(&idx.0), &["write-tree"])?;
        let head = git(&root, None, &["rev-parse", "--verify", "-q", "HEAD"]).ok().filter(|s| !s.is_empty());
        let mut args = vec!["commit-tree", tree.as_str(), "-m", "Supercharge Studio checkpoint"];
        if let Some(h) = head.as_deref() {
            args.extend(["-p", h]);
        }
        let commit = git(&root, None, &args)?;
        git(&root, None, &["update-ref", &format!("{REF}{id}"), &commit])?;
        // Keep the newest checkpoints only.
        let refs = git(&root, None, &["for-each-ref", "--sort=-creatordate", "--format=%(refname)", REF]).unwrap_or_default();
        for r in refs.lines().skip(KEEP) {
            let _ = git(&root, None, &["update-ref", "-d", r]);
        }
        return Ok(Checkpoint { id: id.into(), kind: "git" });
    }
    let files = walk(cwd)?;
    if files.iter().map(|f| f.1).sum::<u64>() > MAX_BYTES {
        return Err("This folder is too large to checkpoint without git".into());
    }
    let base = store_dir(cwd);
    copy_files(cwd, &base.join(id), &files)?;
    if let Ok(rd) = std::fs::read_dir(&base) {
        let mut all: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        all.sort();
        let n = all.len();
        for p in all.into_iter().take(n.saturating_sub(KEEP)) {
            let _ = std::fs::remove_dir_all(p);
        }
    }
    Ok(Checkpoint { id: id.into(), kind: "copy" })
}

pub fn restore(cwd: &Path, id: &str) -> Result<(), String> {
    let id = safe_id(id)?;
    if let Some(root) = git_root(cwd) {
        let r = format!("{REF}{id}");
        if git(&root, None, &["rev-parse", "--verify", "-q", &r]).is_ok() {
            let keep = nul_list(&git(&root, None, &["ls-tree", "-r", "-z", "--name-only", &r])?);
            let now = nul_list(&git(&root, None, &["ls-files", "-z", "-co", "--exclude-standard"])?);
            for f in now.difference(&keep) {
                let _ = std::fs::remove_file(root.join(f));
            }
            let idx = TmpIndex::new(id);
            git(&root, Some(&idx.0), &["read-tree", &r])?;
            git(&root, Some(&idx.0), &["checkout-index", "-a", "-f"])?;
            return Ok(());
        }
    }
    let snap = store_dir(cwd).join(id);
    if !snap.is_dir() {
        return Err("That checkpoint no longer exists".into());
    }
    let keep = walk(&snap)?;
    let names: HashSet<&str> = keep.iter().map(|f| f.0.as_str()).collect();
    for (f, _) in walk(cwd)? {
        if !names.contains(f.as_str()) {
            let _ = std::fs::remove_file(cwd.join(&f));
        }
    }
    copy_files(&snap, cwd, &keep)
}

#[tauri::command]
pub async fn checkpoint_create(cwd: String, id: String) -> Result<Checkpoint, String> {
    tokio::task::spawn_blocking(move || create(Path::new(&cwd), &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn checkpoint_restore(cwd: String, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || restore(Path::new(&cwd), &id)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tmp(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sc-ckpt-test-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn w(d: &Path, f: &str, s: &str) {
        std::fs::create_dir_all(d.join(f).parent().unwrap()).unwrap();
        std::fs::write(d.join(f), s).unwrap();
    }
    fn r(d: &Path, f: &str) -> Option<String> {
        std::fs::read_to_string(d.join(f)).ok()
    }

    #[test]
    fn git_checkpoint_restores_tree_without_touching_index_or_branch() {
        let d = tmp("git");
        git(&d, None, &["init", "-q"]).unwrap();
        w(&d, ".gitignore", "secret.txt\n");
        w(&d, "a.txt", "one");
        git(&d, None, &["add", "-A"]).unwrap();
        git(&d, None, &["commit", "-qm", "init"]).unwrap();
        w(&d, "b.txt", "untracked");
        w(&d, "secret.txt", "ignored");
        let head = git(&d, None, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(create(&d, "c1").unwrap().kind, "git");
        w(&d, "a.txt", "changed");
        w(&d, "sub/new.txt", "new");
        std::fs::remove_file(d.join("b.txt")).unwrap();
        restore(&d, "c1").unwrap();
        assert_eq!(r(&d, "a.txt").as_deref(), Some("one"));
        assert_eq!(r(&d, "b.txt").as_deref(), Some("untracked"));
        assert_eq!(r(&d, "sub/new.txt"), None);
        assert_eq!(r(&d, "secret.txt").as_deref(), Some("ignored"));
        assert_eq!(git(&d, None, &["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(git(&d, None, &["status", "--porcelain"]).unwrap(), "?? b.txt");
        assert!(git(&d, None, &["branch", "--list"]).unwrap().lines().count() == 1);
        assert!(restore(&d, "../x").is_err());
    }

    #[test]
    fn plain_folder_checkpoint_copies_and_restores() {
        let d = tmp("plain");
        w(&d, "a.txt", "one");
        w(&d, "node_modules/x.js", "dep");
        let id = format!("t{}", std::process::id());
        assert_eq!(create(&d, &id).unwrap().kind, "copy");
        w(&d, "a.txt", "two");
        w(&d, "c.txt", "added");
        restore(&d, &id).unwrap();
        assert_eq!(r(&d, "a.txt").as_deref(), Some("one"));
        assert_eq!(r(&d, "c.txt"), None);
        assert_eq!(r(&d, "node_modules/x.js").as_deref(), Some("dep"));
        let _ = std::fs::remove_dir_all(store_dir(&d));
    }
}
