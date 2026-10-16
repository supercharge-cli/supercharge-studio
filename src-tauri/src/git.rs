//! Git operations for the Changes panel, built-in Git controls and worktree chats.
//! Every call passes arguments as a list (no shell strings) through `hidden::std_cmd`.

use crate::hidden;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

fn git_in(root: &Path, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let mut c = hidden::std_cmd("git");
    c.arg("-C").arg(root).args(args).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = c.spawn().map_err(|e| format!("git: {e}"))?;
    if let Some(s) = stdin {
        child.stdin.take().unwrap().write_all(s.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err })
    }
}

/// Reject paths that try to leave the repository.
fn safe_rel(p: &str) -> Result<&str, String> {
    if p.is_empty() || p.starts_with('-') || Path::new(p).is_absolute() || p.split(['/', '\\']).any(|s| s == "..") {
        return Err(format!("bad path: {p}"));
    }
    Ok(p)
}
fn safe_ref(b: &str) -> Result<&str, String> {
    if b.is_empty() || b.starts_with('-') || b.contains("..") || b.chars().any(|c| c.is_whitespace() || "~^:?*[\\".contains(c)) {
        return Err(format!("bad branch name: {b}"));
    }
    Ok(b)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileStatus {
    pub path: String,
    /// Index (staged) status letter, ' ' when none.
    pub x: String,
    /// Working-tree status letter; '?' for untracked.
    pub y: String,
}

#[derive(Serialize, Debug, Default)]
pub struct Status {
    pub repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
    pub root: Option<String>,
}

/// Parse `git status --porcelain=v2 --branch -z --untracked-files=all`.
pub fn parse_status(s: &str) -> Status {
    let mut st = Status { repo: true, ..Default::default() };
    let mut it = s.split('\0').peekable();
    while let Some(rec) = it.next() {
        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(b) = h.strip_prefix("branch.head ") {
                st.branch = (b != "(detached)").then(|| b.to_string());
            } else if let Some(u) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(u.to_string());
            } else if let Some(ab) = h.strip_prefix("branch.ab ") {
                for p in ab.split(' ') {
                    if let Some(n) = p.strip_prefix('+') { st.ahead = n.parse().unwrap_or(0) }
                    if let Some(n) = p.strip_prefix('-') { st.behind = n.parse().unwrap_or(0) }
                }
            }
        } else if let Some(r) = rec.strip_prefix("1 ") {
            let f: Vec<&str> = r.splitn(8, ' ').collect();
            if f.len() == 8 {
                let xy = f[0].as_bytes();
                st.files.push(FileStatus { path: f[7].into(), x: (xy[0] as char).to_string().replace('.', " "), y: (xy[1] as char).to_string().replace('.', " ") });
            }
        } else if let Some(r) = rec.strip_prefix("2 ") {
            let f: Vec<&str> = r.splitn(9, ' ').collect();
            if f.len() == 9 {
                let xy = f[0].as_bytes();
                st.files.push(FileStatus { path: f[8].into(), x: (xy[0] as char).to_string().replace('.', " "), y: (xy[1] as char).to_string().replace('.', " ") });
            }
            it.next(); // original path
        } else if let Some(r) = rec.strip_prefix("u ") {
            if let Some(p) = r.splitn(10, ' ').nth(9) {
                st.files.push(FileStatus { path: p.into(), x: "U".into(), y: "U".into() });
            }
        } else if let Some(p) = rec.strip_prefix("? ") {
            st.files.push(FileStatus { path: p.into(), x: " ".into(), y: "?".into() });
        }
    }
    st
}

fn status_sync(root: &Path) -> Status {
    let Ok(top) = git_in(root, &["rev-parse", "--show-toplevel"], None) else { return Status::default() };
    let mut st = git_in(root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], None).map(|s| parse_status(&s)).unwrap_or_default();
    st.repo = true;
    st.root = Some(top.trim().to_string());
    // Our own worktree folder is never a "change".
    st.files.retain(|f| !f.path.starts_with(".supercharge/worktrees/"));
    st
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<Status, String> {
    blocking(move || Ok(status_sync(Path::new(&root)))).await
}

/// Unified diff of one file vs HEAD (working tree incl. staged); untracked files diff against empty.
pub fn diff_file_sync(root: &Path, path: &str) -> Result<String, String> {
    let path = safe_rel(path)?;
    let untracked = git_in(root, &["ls-files", "--error-unmatch", "--", path], None).is_err();
    if untracked {
        // --no-index exits 1 when files differ; read stdout regardless.
        let mut c = hidden::std_cmd("git");
        c.arg("-C").arg(root).args(["diff", "--no-color", "--no-index", "--", "/dev/null", path]);
        let out = c.output().map_err(|e| e.to_string())?;
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let has_head = git_in(root, &["rev-parse", "--verify", "-q", "HEAD"], None).is_ok();
    if has_head { git_in(root, &["diff", "--no-color", "HEAD", "--", path], None) } else { git_in(root, &["diff", "--no-color", "--cached", "--", path], None) }
}

#[tauri::command]
pub async fn git_diff_file(root: String, path: String) -> Result<String, String> {
    blocking(move || diff_file_sync(Path::new(&root), &path)).await
}

/// Whole working-tree diff vs HEAD (for commit messages), capped.
#[tauri::command]
pub async fn git_diff_all(root: String, max: Option<usize>) -> Result<String, String> {
    blocking(move || {
        let mut s = git_in(Path::new(&root), &["diff", "--no-color", "--stat", "--patch", "HEAD"], None).unwrap_or_default();
        let m = max.unwrap_or(60_000);
        if s.len() > m { let mut i = m; while !s.is_char_boundary(i) { i -= 1 } s.truncate(i); s.push_str("\n…(truncated)"); }
        Ok(s)
    })
    .await
}

/// Revert one hunk: `patch` is a single-file unified diff (header + hunk) against HEAD.
/// Applied in reverse to the working tree; also to the index if the hunk is staged there.
pub fn revert_patch_sync(root: &Path, patch: &str) -> Result<(), String> {
    git_in(root, &["apply", "-R", "--recount", "--whitespace=nowarn", "-"], Some(patch)).map(|_| ())
}

#[tauri::command]
pub async fn git_revert_hunk(root: String, patch: String) -> Result<(), String> {
    blocking(move || revert_patch_sync(Path::new(&root), &patch)).await
}

/// Throw away all changes to a file (tracked: back to HEAD; untracked: delete).
pub fn restore_file_sync(root: &Path, path: &str) -> Result<(), String> {
    let path = safe_rel(path)?;
    if git_in(root, &["ls-files", "--error-unmatch", "--", path], None).is_err() {
        let top = git_in(root, &["rev-parse", "--show-toplevel"], None)?;
        return std::fs::remove_file(PathBuf::from(top.trim()).join(path)).map_err(|e| e.to_string());
    }
    if git_in(root, &["cat-file", "-e", &format!("HEAD:{path}")], None).is_err() {
        // Newly added in the index only.
        git_in(root, &["rm", "-f", "--", path], None)?;
        return Ok(());
    }
    git_in(root, &["restore", "--source=HEAD", "--staged", "--worktree", "--", path], None).map(|_| ())
}

#[tauri::command]
pub async fn git_restore_file(root: String, path: String) -> Result<(), String> {
    blocking(move || restore_file_sync(Path::new(&root), &path)).await
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>, stage: bool) -> Result<(), String> {
    blocking(move || {
        let r = Path::new(&root);
        for p in &paths { safe_rel(p)?; }
        let mut a: Vec<&str> = if stage { vec!["add", "--"] } else { vec!["reset", "-q", "HEAD", "--"] };
        a.extend(paths.iter().map(|s| s.as_str()));
        git_in(r, &a, None).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, all: bool) -> Result<String, String> {
    blocking(move || {
        let r = Path::new(&root);
        if message.trim().is_empty() { return Err("Commit message is empty".into()) }
        if all { git_in(r, &["add", "-A", "--", ".", ":!.supercharge/worktrees"], None)?; }
        git_in(r, &["commit", "-F", "-"], Some(&message))?;
        git_in(r, &["rev-parse", "--short", "HEAD"], None).map(|s| s.trim().to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<String>, String> {
    blocking(move || Ok(git_in(Path::new(&root), &["branch", "--format=%(refname:short)"], None)?.lines().map(|s| s.to_string()).collect())).await
}

#[tauri::command]
pub async fn git_checkout(root: String, branch: String, create: bool) -> Result<(), String> {
    blocking(move || {
        let b = safe_ref(&branch)?;
        let a: Vec<&str> = if create { vec!["switch", "-c", b] } else { vec!["switch", b] };
        git_in(Path::new(&root), &a, None).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    blocking(move || {
        let r = Path::new(&root);
        let has_up = git_in(r, &["rev-parse", "--abbrev-ref", "@{u}"], None).is_ok();
        if has_up { git_in(r, &["push"], None) } else {
            let b = git_in(r, &["branch", "--show-current"], None)?;
            git_in(r, &["push", "-u", "origin", b.trim()], None)
        }
        .map(|s| if s.trim().is_empty() { "Pushed".into() } else { s })
    })
    .await
}

/// Turn a remote URL into a web compare URL for the branch.
pub fn compare_url(remote: &str, branch: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    let web = if let Some(rest) = r.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        format!("https://{host}/{path}")
    } else if let Some(rest) = r.strip_prefix("ssh://git@") {
        format!("https://{}", rest)
    } else if r.starts_with("https://") || r.starts_with("http://") {
        // Drop credentials.
        match r.split_once("://") { Some((s, rest)) => format!("{s}://{}", rest.rsplit_once('@').map(|x| x.1).unwrap_or(rest)), None => r.into() }
    } else {
        return None;
    };
    Some(format!("{web}/compare/{branch}?expand=1"))
}

/// Open a pull request: `gh pr create --web` when available, else the remote's compare page.
#[tauri::command]
pub async fn git_open_pr(root: String) -> Result<String, String> {
    blocking(move || {
        let r = Path::new(&root);
        let gh = hidden::std_cmd("gh").arg("pr").arg("create").arg("--web").current_dir(r).stdin(Stdio::null()).output();
        if let Ok(o) = gh { if o.status.success() { return Ok("Opened in browser".into()) } }
        let remote = git_in(r, &["remote", "get-url", "origin"], None)?;
        let b = git_in(r, &["branch", "--show-current"], None)?;
        let url = compare_url(&remote, b.trim()).ok_or("Could not work out the remote's web address")?;
        open_url(&url)?;
        Ok(url)
    })
    .await
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut c = { let mut c = hidden::std_cmd("rundll32"); c.args(["url.dll,FileProtocolHandler", url]); c };
    #[cfg(target_os = "macos")]
    let mut c = { let mut c = hidden::std_cmd("open"); c.arg(url); c };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut c = { let mut c = hidden::std_cmd("xdg-open"); c.arg(url); c };
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Lowercase slug, `[a-z0-9-]`, max 40 chars.
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() { out.push(ch) } else if !out.ends_with('-') && !out.is_empty() { out.push('-') }
        if out.len() >= 40 { break }
    }
    let t = out.trim_matches('-').to_string();
    if t.is_empty() { "chat".into() } else { t }
}

#[derive(Serialize, Debug)]
pub struct Worktree { pub path: String, pub branch: String, pub base: String, pub root: String }

pub fn worktree_add_sync(root: &Path, name: &str) -> Result<Worktree, String> {
    let top = PathBuf::from(git_in(root, &["rev-parse", "--show-toplevel"], None)?.trim());
    let base = git_in(&top, &["branch", "--show-current"], None)?.trim().to_string();
    if base.is_empty() { return Err("Check out a branch first (HEAD is detached)".into()) }
    // Keep our worktrees out of `git status` for the main checkout.
    let common = PathBuf::from(git_in(&top, &["rev-parse", "--path-format=absolute", "--git-common-dir"], None)?.trim());
    let excl = common.join("info").join("exclude");
    let cur = std::fs::read_to_string(&excl).unwrap_or_default();
    if !cur.lines().any(|l| l.trim() == "/.supercharge/worktrees/") {
        let _ = std::fs::create_dir_all(excl.parent().unwrap());
        let sep = if cur.is_empty() || cur.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&excl, format!("{cur}{sep}/.supercharge/worktrees/\n")).map_err(|e| e.to_string())?;
    }
    let base_slug = slugify(name);
    let mut slug = base_slug.clone();
    let mut n = 2;
    while top.join(".supercharge/worktrees").join(&slug).exists() || git_in(&top, &["rev-parse", "--verify", "-q", &format!("refs/heads/supercharge/{slug}")], None).is_ok() {
        slug = format!("{base_slug}-{n}");
        n += 1;
    }
    let path = top.join(".supercharge").join("worktrees").join(&slug);
    let branch = format!("supercharge/{slug}");
    let ps = path.to_string_lossy().to_string();
    git_in(&top, &["worktree", "add", &ps, "-b", &branch], None)?;
    Ok(Worktree { path: ps, branch, base, root: top.to_string_lossy().into() })
}

#[tauri::command]
pub async fn git_worktree_add(root: String, name: String) -> Result<Worktree, String> {
    blocking(move || worktree_add_sync(Path::new(&root), &name)).await
}

/// Merge the worktree branch into `base` in the main checkout. Uncommitted work in the
/// worktree is committed first. On conflict the merge is aborted and the files are listed.
pub fn worktree_merge_sync(root: &Path, wt: &Path, branch: &str, base: &str) -> Result<String, String> {
    safe_ref(branch)?;
    safe_ref(base)?;
    if !git_in(wt, &["status", "--porcelain"], None)?.trim().is_empty() {
        git_in(wt, &["add", "-A"], None)?;
        git_in(wt, &["commit", "-m", &format!("Work from {branch}")], None)?;
    }
    let cur = git_in(root, &["branch", "--show-current"], None)?.trim().to_string();
    if cur != base { git_in(root, &["switch", base], None)?; }
    match git_in(root, &["merge", "--no-ff", "--no-edit", branch], None) {
        Ok(_) => git_in(root, &["rev-parse", "--short", "HEAD"], None).map(|s| s.trim().to_string()),
        Err(e) => {
            let files = git_in(root, &["diff", "--name-only", "--diff-filter=U"], None).unwrap_or_default();
            let _ = git_in(root, &["merge", "--abort"], None);
            if files.trim().is_empty() { Err(e) } else { Err(format!("CONFLICT in: {}", files.lines().collect::<Vec<_>>().join(", "))) }
        }
    }
}

#[tauri::command]
pub async fn git_worktree_merge(root: String, path: String, branch: String, base: String) -> Result<String, String> {
    blocking(move || worktree_merge_sync(Path::new(&root), Path::new(&path), &branch, &base)).await
}

pub fn worktree_remove_sync(root: &Path, path: &str, branch: &str) -> Result<(), String> {
    safe_ref(branch)?;
    if !branch.starts_with("supercharge/") { return Err("Only Supercharge worktree branches can be discarded".into()) }
    let _ = git_in(root, &["worktree", "remove", "--force", path], None);
    let _ = git_in(root, &["worktree", "prune"], None);
    git_in(root, &["branch", "-D", branch], None).map(|_| ())
}

#[tauri::command]
pub async fn git_worktree_remove(root: String, path: String, branch: String) -> Result<(), String> {
    blocking(move || worktree_remove_sync(Path::new(&root), &path, &branch)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        let d = std::env::temp_dir().join(format!("scgit-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        for a in [vec!["init", "-q", "-b", "main"], vec!["config", "user.email", "t@t"], vec!["config", "user.name", "t"], vec!["config", "commit.gpgsign", "false"]] {
            git_in(&d, &a, None).unwrap();
        }
        std::fs::write(d.join("a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n").unwrap();
        git_in(&d, &["add", "."], None).unwrap();
        git_in(&d, &["commit", "-qm", "init"], None).unwrap();
        d
    }

    #[test]
    fn status_and_diff_and_revert() {
        let d = repo();
        std::fs::write(d.join("a.txt"), "1x\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12y\n").unwrap();
        std::fs::write(d.join("new.txt"), "hi\n").unwrap();
        let st = status_sync(&d);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.files.len(), 2);
        assert!(st.files.iter().any(|f| f.path == "new.txt" && f.y == "?"));
        let diff = diff_file_sync(&d, "a.txt").unwrap();
        assert!(diff.contains("-1\n+1x"));
        // Revert only the first hunk.
        let parts: Vec<&str> = diff.split("\n@@").collect();
        assert_eq!(parts.len(), 3, "{diff}");
        let patch = format!("{}\n@@{}\n", parts[0], parts[1].trim_end_matches('\n'));
        revert_patch_sync(&d, &patch).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12y\n");
        assert!(diff_file_sync(&d, "new.txt").unwrap().contains("+hi"));
        restore_file_sync(&d, "new.txt").unwrap();
        restore_file_sync(&d, "a.txt").unwrap();
        assert!(status_sync(&d).files.is_empty());
        assert!(safe_rel("../x").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn worktree_flow() {
        let d = repo();
        let wt = worktree_add_sync(&d, "Fix the Thing!").unwrap();
        assert_eq!(wt.branch, "supercharge/fix-the-thing");
        assert_eq!(wt.base, "main");
        assert!(status_sync(&d).files.is_empty(), "worktree folder must be ignored");
        std::fs::write(Path::new(&wt.path).join("b.txt"), "b\n").unwrap();
        worktree_merge_sync(&d, Path::new(&wt.path), &wt.branch, "main").unwrap();
        assert!(d.join("b.txt").exists());
        let wt2 = worktree_add_sync(&d, "Fix the Thing!").unwrap();
        assert_eq!(wt2.branch, "supercharge/fix-the-thing-2");
        worktree_remove_sync(&d, &wt2.path, &wt2.branch).unwrap();
        assert!(!Path::new(&wt2.path).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn urls_and_slugs() {
        assert_eq!(compare_url("git@github.com:o/r.git", "f").unwrap(), "https://github.com/o/r/compare/f?expand=1");
        assert_eq!(compare_url("https://tok@github.com/o/r", "f").unwrap(), "https://github.com/o/r/compare/f?expand=1");
        assert_eq!(slugify("  Hello, World  "), "hello-world");
        let st = parse_status("# branch.head main\0# branch.ab +2 -1\0? x y.txt\0");
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.files[0].path, "x y.txt");
    }
}
