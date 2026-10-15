//! Local shell in the right panel. One PTY, bytes streamed to the UI.

use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter, State};

struct Live {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct Terms(Mutex<Option<Live>>);

impl Terms {
    pub fn new() -> Self { Self(Mutex::new(None)) }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

#[tauri::command]
pub fn term_open(app: AppHandle, state: State<Terms>, cwd: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
    term_close(state.clone());
    let pair = NativePtySystem::default().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    });
    if let Some(dir) = cwd.filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if app.emit("term-data", String::from_utf8_lossy(&buf[..n]).to_string()).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app.emit("term-exit", ());
    });
    *state.0.lock().unwrap() = Some(Live { writer, master: pair.master, child });
    Ok(())
}

#[tauri::command]
pub fn term_write(state: State<Terms>, data: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let live = guard.as_mut().ok_or("no terminal")?;
    live.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    live.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: State<Terms>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let live = guard.as_ref().ok_or("no terminal")?;
    live.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_close(state: State<Terms>) {
    if let Some(mut live) = state.0.lock().unwrap().take() {
        let _ = live.child.kill();
        let _ = live.writer.flush();
    }
}
