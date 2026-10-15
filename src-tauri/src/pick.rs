//! Native folder picker. Linux, macOS, and Windows each use the system dialog.

use std::process::Command;

fn output(cmd: &mut Command) -> Option<String> {
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().trim_matches('"').to_string();
    if path.is_empty() { None } else { Some(path) }
}

fn linux() -> Result<Option<String>, String> {
    if Command::new("zenity").arg("--version").output().is_ok_and(|o| o.status.success()) {
        return Ok(output(Command::new("zenity").args(["--file-selection", "--directory", "--title=Open project"])));
    }
    if Command::new("kdialog").arg("--version").output().is_ok_and(|o| o.status.success()) {
        return Ok(output(Command::new("kdialog").args(["--getexistingdirectory", ".", "--title", "Open project"])));
    }
    let py = r#"
import sys
try:
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk
    d = Gtk.FileChooserNative(title="Open project", action=Gtk.FileChooserAction.SELECT_FOLDER)
    if d.run() == Gtk.ResponseType.ACCEPT:
        print(d.get_filename() or "")
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(2)
"#;
    Ok(output(Command::new("python3").args(["-c", py])))
}

fn macos() -> Result<Option<String>, String> {
    Ok(output(Command::new("osascript").args(["-e", "POSIX path of (choose folder with prompt \"Open project\")"])))
}

fn windows() -> Result<Option<String>, String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = "Open project"
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
"#;
    Ok(output(Command::new("powershell.exe").args(["-NoProfile", "-STA", "-Command", script])))
}

#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    if cfg!(target_os = "macos") {
        macos()
    } else if cfg!(target_os = "windows") {
        windows()
    } else {
        linux()
    }
}
