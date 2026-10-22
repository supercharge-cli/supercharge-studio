//! Rules / memory files the agent reads: project `AGENTS.md`, `AGENT.md` and
//! `.supercharge/rules/*.md`; global `~/.supercharge/AGENTS.md` and `~/.supercharge/rules/*.md`.
//! Files are addressed by scope + name ("AGENTS.md", "AGENT.md" or "rules/<name>.md"), never raw paths.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq)]
pub struct RuleFile {
    pub scope: String,
    pub name: String,
    pub path: String,
    pub exists: bool,
}

fn safe_name(name: &str) -> Result<(), String> {
    let ok = match name.strip_prefix("rules/") {
        Some(f) => f.ends_with(".md") && f.len() > 3 && f.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && !f.starts_with('.'),
        None => name == "AGENTS.md" || name == "AGENT.md",
    };
    if ok { Ok(()) } else { Err(format!("bad rules file name: {name}")) }
}

fn base(scope: &str, cwd: &Path, home: &Path) -> Result<PathBuf, String> {
    match scope {
        "project" => Ok(cwd.to_path_buf()),
        "global" => Ok(home.join(".supercharge")),
        _ => Err(format!("bad scope: {scope}")),
    }
}

/// Where `name` lives: project AGENTS.md sits in the folder itself, rules/ under .supercharge.
fn path_of(scope: &str, name: &str, cwd: &Path, home: &Path) -> Result<PathBuf, String> {
    safe_name(name)?;
    let b = base(scope, cwd, home)?;
    Ok(match name.strip_prefix("rules/") {
        Some(f) if scope == "project" => b.join(".supercharge").join("rules").join(f),
        Some(f) => b.join("rules").join(f),
        None => b.join(name),
    })
}

pub fn list(cwd: &Path, home: &Path) -> Vec<RuleFile> {
    let mut out = vec![];
    for scope in ["project", "global"] {
        let mut names: Vec<String> = vec!["AGENTS.md".into(), "AGENT.md".into()];
        let dir = path_of(scope, "rules/x.md", cwd, home).unwrap().parent().unwrap().to_path_buf();
        let mut extra: Vec<String> = std::fs::read_dir(&dir).into_iter().flatten().flatten()
            .map(|e| format!("rules/{}", e.file_name().to_string_lossy()))
            .filter(|n| safe_name(n).is_ok())
            .collect();
        extra.sort();
        names.extend(extra);
        for name in names {
            let p = path_of(scope, &name, cwd, home).unwrap();
            if scope == "global" && name == "AGENT.md" && !p.exists() {
                continue;
            }
            out.push(RuleFile { scope: scope.into(), exists: p.is_file(), path: p.to_string_lossy().into_owned(), name });
        }
    }
    out
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
}

#[tauri::command]
pub fn rules_list(cwd: String) -> Vec<RuleFile> {
    list(Path::new(&cwd), &home())
}

#[tauri::command]
pub fn rules_read(cwd: String, scope: String, name: String) -> Result<String, String> {
    let p = path_of(&scope, &name, Path::new(&cwd), &home())?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Write a rules file (creating folders); empty text deletes a rules/ file.
#[tauri::command]
pub fn rules_write(cwd: String, scope: String, name: String, text: String) -> Result<(), String> {
    let p = path_of(&scope, &name, Path::new(&cwd), &home())?;
    if text.is_empty() && name.starts_with("rules/") {
        return match std::fs::remove_file(&p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_paths_and_listing() {
        let t = std::env::temp_dir().join(format!("sc-rules-{}", std::process::id()));
        let (cwd, home) = (t.join("proj"), t.join("home"));
        std::fs::create_dir_all(cwd.join(".supercharge/rules")).unwrap();
        std::fs::write(cwd.join("AGENTS.md"), "x").unwrap();
        std::fs::write(cwd.join(".supercharge/rules/style.md"), "y").unwrap();
        std::fs::write(cwd.join(".supercharge/rules/notes.txt"), "skip").unwrap();
        for bad in ["../x.md", "rules/../a.md", "rules/.hidden.md", "README.md", "rules/a.txt", "rules/a/b.md"] {
            assert!(path_of("project", bad, &cwd, &home).is_err(), "{bad}");
        }
        assert!(path_of("other", "AGENTS.md", &cwd, &home).is_err());
        assert_eq!(path_of("global", "rules/a.md", &cwd, &home).unwrap(), home.join(".supercharge/rules/a.md"));
        let l = list(&cwd, &home);
        let names: Vec<_> = l.iter().map(|r| format!("{}:{}:{}", r.scope, r.name, r.exists)).collect();
        assert_eq!(names, ["project:AGENTS.md:true", "project:AGENT.md:false", "project:rules/style.md:true", "global:AGENTS.md:false"]);
        let _ = std::fs::remove_dir_all(t);
    }
}
