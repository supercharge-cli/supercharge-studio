//! File uploads from paired phones (and the desktop composer).
//!
//! Gateway frames are capped (the relay forwards at most 256 KB per frame), so devices send a
//! file as ordered base64 chunks with `_supercharge/upload`:
//!   {uploadId, name, mimeType, size, index, total, data}
//! The last chunk returns `{uploadId, uri: "file:///…", path, name, mimeType, size}`; the device
//! then refers to the file in `session/prompt` with a `resource_link` carrying
//! `_meta.supercharge.uploadId`. Files land in `<base>/uploads/<yyyymmdd>/<random>-<name>`.
//! Shared by the desktop app and the headless server.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};

pub const MAX_UPLOAD: u64 = 25 * 1024 * 1024;
pub const MAX_CHUNK: usize = 192 * 1024;
/// Images up to this size are passed to the agent as image content blocks.
pub const MAX_IMAGE_INLINE: u64 = 8 * 1024 * 1024;

/// Safe single path component: no separators, no leading dots, bounded length.
pub fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_. ()".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .to_string();
    let s = if s.is_empty() { "file".to_string() } else { s };
    let s = if is_opaque_cache_name(&s) { upload_name(&s) } else { s };
    s.chars().rev().take(100).collect::<Vec<_>>().into_iter().rev().collect()
}

/// Share sheets and app caches hand over names like `<app>_<random id>.png`.
/// Those carry no meaning for the user, so they become `upload-<time>.<ext>`.
fn is_opaque_cache_name(s: &str) -> bool {
    let stem = s.rsplit_once('.').map(|(a, _)| a).unwrap_or(s);
    match stem.split_once('_') {
        Some((pre, id)) => !pre.is_empty() && pre.chars().all(|c| c.is_ascii_alphabetic()) && id.len() >= 8 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-' || c == '_'),
        None => false,
    }
}

fn upload_name(s: &str) -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    match s.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => format!("upload-{secs}.{ext}"),
        _ => format!("upload-{secs}"),
    }
}

pub fn file_uri(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = if s.starts_with('/') { s } else { format!("/{s}") };
    let enc: String = s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~/:()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    format!("file://{enc}")
}

struct Partial {
    path: PathBuf,
    name: String,
    mime: String,
    size: u64,
    next: u64,
    total: u64,
    written: u64,
}

#[derive(Clone, Debug)]
pub struct Saved {
    pub path: PathBuf,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

impl Saved {
    pub fn to_json(&self, id: &str) -> Value {
        json!({ "uploadId": id, "uri": file_uri(&self.path), "path": self.path.to_string_lossy(), "name": self.name, "mimeType": self.mime, "size": self.size })
    }
}

#[derive(Default)]
pub struct Uploads {
    partial: HashMap<String, Partial>,
    pub done: HashMap<String, Saved>,
}

fn rand_hex() -> String {
    let mut b = [0u8; 6];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl Uploads {
    /// Accept one chunk; returns the saved file after the last one.
    pub fn chunk(&mut self, base: &Path, p: &Value) -> Result<Option<(String, Saved)>, String> {
        let id = p["uploadId"].as_str().filter(|s| !s.is_empty() && s.len() <= 64).ok_or("uploadId required")?.to_string();
        let index = p["index"].as_u64().ok_or("index required")?;
        let total = p["total"].as_u64().filter(|t| *t >= 1).ok_or("total required")?;
        let data = p["data"].as_str().unwrap_or("");
        if data.len() > MAX_CHUNK * 4 / 3 + 8 {
            return Err("chunk too large".into());
        }
        let bytes = B64.decode(data).map_err(|_| "bad base64")?;
        if index == 0 {
            let size = p["size"].as_u64().unwrap_or(0);
            if size > MAX_UPLOAD {
                return Err(format!("file too large (max {} MB)", MAX_UPLOAD / 1024 / 1024));
            }
            let name = sanitize(p["name"].as_str().unwrap_or("file"));
            let mime = p["mimeType"].as_str().unwrap_or("application/octet-stream").chars().take(100).collect();
            let day = { let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86400).unwrap_or(0); format!("d{d}") };
            let dir = base.join("uploads").join(day);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join(format!("{}-{}", rand_hex(), name));
            std::fs::File::create(&path).map_err(|e| e.to_string())?;
            self.partial.insert(id.clone(), Partial { path, name, mime, size, next: 0, total, written: 0 });
        }
        let part = self.partial.get_mut(&id).ok_or("unknown upload (send chunk 0 first)")?;
        if index != part.next || total != part.total {
            let path = part.path.clone();
            self.partial.remove(&id);
            let _ = std::fs::remove_file(path);
            return Err("chunks out of order".into());
        }
        part.written += bytes.len() as u64;
        if part.written > MAX_UPLOAD || (part.size > 0 && part.written > part.size) {
            let path = part.path.clone();
            self.partial.remove(&id);
            let _ = std::fs::remove_file(path);
            return Err("file larger than announced".into());
        }
        std::fs::OpenOptions::new().append(true).open(&part.path).and_then(|mut f| f.write_all(&bytes)).map_err(|e| e.to_string())?;
        part.next += 1;
        if part.next < part.total {
            return Ok(None);
        }
        let p = self.partial.remove(&id).unwrap();
        let saved = Saved { path: p.path, name: p.name, mime: p.mime, size: p.written };
        self.done.insert(id.clone(), saved.clone());
        Ok(Some((id, saved)))
    }

    /// Rewrite a device prompt: links to finished uploads point at the saved file; small
    /// images become image blocks when `images` is true. Unknown upload ids are dropped.
    pub fn rewrite_prompt(&self, prompt: &mut Value, images: bool) {
        let Some(arr) = prompt.as_array_mut() else { return };
        arr.retain_mut(|b| {
            let Some(id) = b.pointer("/_meta/supercharge/uploadId").and_then(|v| v.as_str()).map(String::from) else { return true };
            let Some(s) = self.done.get(&id) else { return false };
            if images && s.mime.starts_with("image/") && s.size <= MAX_IMAGE_INLINE {
                if let Ok(bytes) = std::fs::read(&s.path) {
                    *b = json!({ "type": "image", "mimeType": s.mime, "data": B64.encode(bytes), "uri": file_uri(&s.path) });
                    return true;
                }
            }
            *b = json!({ "type": "resource_link", "uri": file_uri(&s.path), "name": s.name, "mimeType": s.mime, "size": s.size });
            true
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, i: u64, n: u64, data: &[u8], size: u64) -> Value {
        json!({"uploadId": id, "index": i, "total": n, "data": B64.encode(data), "name": "../../etc/pass wd.png", "mimeType": "image/png", "size": size})
    }

    #[test]
    fn assembles_chunks_and_rewrites_prompts() {
        let base = std::env::temp_dir().join(format!("scs-up-{}", rand_hex()));
        let mut u = Uploads::default();
        assert!(u.chunk(&base, &chunk("a", 0, 2, b"hel", 5)).unwrap().is_none());
        let (id, s) = u.chunk(&base, &chunk("a", 1, 2, b"lo", 5)).unwrap().unwrap();
        assert_eq!(id, "a");
        assert_eq!(std::fs::read(&s.path).unwrap(), b"hello");
        assert!(s.path.starts_with(base.join("uploads")));
        assert!(!s.name.contains('/') && !s.name.starts_with('.'));
        let mut prompt = json!([{"type":"text","text":"hi"},{"type":"resource_link","uri":"x","name":"x","_meta":{"supercharge":{"uploadId":"a"}}},{"type":"resource_link","uri":"y","name":"y","_meta":{"supercharge":{"uploadId":"nope"}}}]);
        u.rewrite_prompt(&mut prompt, true);
        assert_eq!(prompt.as_array().unwrap().len(), 2);
        assert_eq!(prompt[1]["type"], "image");
        assert_eq!(prompt[1]["data"], B64.encode(b"hello"));
        let mut p2 = json!([{"type":"resource_link","uri":"x","name":"x","_meta":{"supercharge":{"uploadId":"a"}}}]);
        u.rewrite_prompt(&mut p2, false);
        assert_eq!(p2[0]["type"], "resource_link");
        assert!(p2[0]["uri"].as_str().unwrap().starts_with("file:///"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_bad_uploads() {
        let base = std::env::temp_dir().join(format!("scs-up-{}", rand_hex()));
        let mut u = Uploads::default();
        assert!(u.chunk(&base, &chunk("b", 0, 1, b"x", MAX_UPLOAD + 1)).is_err());
        assert!(u.chunk(&base, &chunk("c", 1, 2, b"x", 2)).is_err()); // no chunk 0
        assert!(u.chunk(&base, &chunk("d", 0, 3, b"x", 2)).unwrap().is_none());
        assert!(u.chunk(&base, &chunk("d", 2, 3, b"x", 2)).is_err()); // out of order
        assert!(u.chunk(&base, &chunk("e", 0, 1, b"toolong", 2)).is_err()); // bigger than announced
        assert_eq!(sanitize("..."), "file");
        let n = sanitize("app_1734567890123.png");
        assert!(n.starts_with("upload-") && n.ends_with(".png"), "{n}");
        assert_eq!(sanitize("my_holiday.png"), "my_holiday.png");
        assert_eq!(sanitize("notes.zip"), "notes.zip");
        assert_eq!(file_uri(Path::new("/tmp/a b.txt")), "file:///tmp/a%20b.txt");
        let _ = std::fs::remove_dir_all(base);
    }
}
