//! Local shells in the right panel. Each terminal id owns one PTY.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct Live {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct Terms(Mutex<HashMap<String, Live>>);

impl Terms {
    pub fn new() -> Self { Self(Mutex::new(HashMap::new())) }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad terminal id".into());
    }
    Ok(())
}

#[derive(Clone, Serialize)]
struct TermChunk {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TermGone {
    id: String,
}

#[tauri::command]
pub fn term_open(app: AppHandle, state: State<Terms>, id: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
    crate::telemetry::feature("terminal");
    check_id(&id)?;
    close_one(&state, &id);
    let pair = NativePtySystem::default().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    });
    if !cfg!(windows) {
        // Desktop launchers often leave TERM unset or "dumb", which makes shells
        // print autosuggestions and prompts as plain committed text.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let app_r = app.clone();
    let id_r = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let cut = utf8_complete_len(&pending);
                    if cut == 0 {
                        continue;
                    }
                    let rest = pending.split_off(cut);
                    let chunk = TermChunk { id: id_r.clone(), data: String::from_utf8_lossy(&pending).to_string() };
                    pending = rest;
                    if app_r.emit("term-data", chunk).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app_r.emit("term-exit", TermGone { id: id_r });
    });
    state.0.lock().unwrap().insert(id, Live { writer, master: pair.master, child });
    Ok(())
}

#[tauri::command]
pub fn term_write(state: State<Terms>, id: String, data: String) -> Result<(), String> {
    check_id(&id)?;
    let mut guard = state.0.lock().unwrap();
    let live = guard.get_mut(&id).ok_or("no terminal")?;
    live.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    live.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: State<Terms>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    check_id(&id)?;
    let guard = state.0.lock().unwrap();
    let live = guard.get(&id).ok_or("no terminal")?;
    live.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

fn close_one(state: &State<Terms>, id: &str) {
    if let Some(mut live) = state.0.lock().unwrap().remove(id) {
        let _ = live.child.kill();
        let _ = live.writer.flush();
    }
}

#[tauri::command]
pub fn term_close(state: State<Terms>, id: String) {
    if check_id(&id).is_ok() {
        close_one(&state, &id);
    }
}

/// Length of the prefix that does not end in a partial UTF-8 sequence, so a
/// multi-byte character split across reads is not turned into garbage.
pub fn utf8_complete_len(b: &[u8]) -> usize {
    let n = b.len();
    for back in 1..=3.min(n) {
        let c = b[n - back];
        if c & 0xC0 == 0x80 {
            continue;
        }
        let need = if c >= 0xF0 { 4 } else if c >= 0xE0 { 3 } else if c >= 0xC0 { 2 } else { 1 };
        return if need > back { n - back } else { n };
    }
    n
}

#[cfg(test)]
mod utf8_tests {
    use super::utf8_complete_len;
    #[test]
    fn holds_back_partial_chars() {
        assert_eq!(utf8_complete_len(b"ls"), 2);
        let s = "a→".as_bytes();
        assert_eq!(utf8_complete_len(&s[..2]), 1);
        assert_eq!(utf8_complete_len(s), s.len());
    }
}
