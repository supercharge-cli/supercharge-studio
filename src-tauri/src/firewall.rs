//! Detect a local firewall that may block phones from reaching the gateway, and open the port
//! with one click (the OS asks for the admin password).

use serde::Serialize;
use std::process::{Command, Stdio};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Firewall {
    /// "firewalld", "ufw", "windows" or "macos".
    pub kind: String,
    /// Whether the port is known to be allowed; `None` when it can't be checked without admin rights.
    pub open: Option<bool>,
    /// Command the user can run themselves.
    pub cmd: String,
    /// The app can run the command for the user (with an elevation prompt).
    pub can_allow: bool,
}

fn out(cmd: &str, args: &[&str]) -> Option<(bool, String)> {
    let o = crate::hidden::std_cmd(cmd).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    Some((o.status.success(), String::from_utf8_lossy(&o.stdout).trim().to_string()))
}

/// Does a firewalld port list ("22/tcp 1025-65535/tcp 53/udp") cover `port`/tcp?
pub fn ports_cover(list: &str, port: u16) -> bool {
    list.split_whitespace().any(|e| {
        let Some((range, proto)) = e.split_once('/') else { return false };
        if proto != "tcp" {
            return false;
        }
        match range.split_once('-') {
            Some((a, b)) => matches!((a.parse::<u16>(), b.parse::<u16>()), (Ok(a), Ok(b)) if a <= port && port <= b),
            None => range.parse::<u16>().ok() == Some(port),
        }
    })
}

/// The firewall situation for `port`, or `None` when no firewall seems to be active.
pub fn detect(port: u16) -> Option<Firewall> {
    #[cfg(target_os = "linux")]
    {
        let active = |unit: &str| out("systemctl", &["is-active", unit]).map(|(_, s)| s == "active").unwrap_or(false);
        if active("firewalld") || out("firewall-cmd", &["--state"]).map(|(_, s)| s == "running").unwrap_or(false) {
            // Read-only queries work for a desktop user; check the zone of the default-route interface.
            let open = out("firewall-cmd", &["--query-port", &format!("{port}/tcp")]).map(|(ok, _)| ok).unwrap_or(false)
                || out("firewall-cmd", &["--list-ports"]).map(|(_, s)| ports_cover(&s, port)).unwrap_or(false);
            return Some(Firewall {
                kind: "firewalld".into(),
                open: Some(open),
                cmd: format!("sudo firewall-cmd --add-port={port}/tcp && sudo firewall-cmd --permanent --add-port={port}/tcp"),
                can_allow: which("pkexec"),
            });
        }
        if active("ufw") {
            return Some(Firewall { kind: "ufw".into(), open: None, cmd: format!("sudo ufw allow {port}/tcp"), can_allow: which("pkexec") });
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        let name = format!("Supercharge Studio gateway {port}");
        let open = out("netsh", &["advfirewall", "firewall", "show", "rule", &format!("name={name}")]).map(|(ok, _)| ok).unwrap_or(false);
        Some(Firewall {
            kind: "windows".into(),
            open: Some(open),
            cmd: format!("netsh advfirewall firewall add rule name=\"{name}\" dir=in action=allow protocol=TCP localport={port}"),
            can_allow: true,
        })
    }
    #[cfg(target_os = "macos")]
    {
        let on = out("/usr/libexec/ApplicationFirewall/socketfilterfw", &["--getglobalstate"]).map(|(_, s)| s.contains("enabled")).unwrap_or(false);
        if !on {
            return None;
        }
        let _ = port;
        Some(Firewall {
            kind: "macos".into(),
            open: None,
            cmd: "System Settings → Network → Firewall → Options → allow Supercharge Studio to accept incoming connections (or click Allow when macOS asks).".into(),
            can_allow: false,
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = port;
        None
    }
}

#[allow(dead_code)]
fn which(bin: &str) -> bool {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file())).unwrap_or(false)
}

/// Open `port`/tcp in the active firewall, asking the OS for admin rights. Returns a short result.
pub fn allow(port: u16) -> Result<String, String> {
    let fw = detect(port).ok_or("No active firewall was found; nothing to change.")?;
    let run = |cmd: &mut Command| -> Result<(), String> {
        let o = cmd.stdin(Stdio::null()).output().map_err(|e| format!("could not start: {e}"))?;
        if o.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            // pkexec: 126 = dismissed, 127 = not authorized
            Err(match o.status.code() {
                Some(126) => "The password prompt was cancelled.".into(),
                Some(127) => "Not authorized to change the firewall.".into(),
                _ if err.is_empty() => format!("failed ({})", o.status),
                _ => err,
            })
        }
    };
    match fw.kind.as_str() {
        "firewalld" => {
            let p = format!("{port}/tcp");
            // One prompt: runtime (takes effect now) and permanent (survives reboot).
            run(crate::hidden::std_cmd("pkexec").args(["sh", "-c", &format!("firewall-cmd --add-port={p} && firewall-cmd --permanent --add-port={p}")]))?;
        }
        "ufw" => run(crate::hidden::std_cmd("pkexec").args(["ufw", "allow", &format!("{port}/tcp")]))?,
        "windows" => {
            let name = format!("Supercharge Studio gateway {port}");
            let args = format!("advfirewall firewall add rule name=\"\"{name}\"\" dir=in action=allow protocol=TCP localport={port} profile=private,domain");
            let ps = format!("$p = Start-Process netsh -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '{args}'; exit $p.ExitCode");
            run(crate::hidden::std_cmd("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &ps]))
                .map_err(|e| if e.contains("canceled") || e.contains("cancelled") { "The administrator prompt was cancelled.".into() } else { e })?;
        }
        _ => return Err(fw.cmd),
    }
    match detect(port) {
        Some(Firewall { open: Some(false), .. }) => Err(format!("The command ran but port {port} still looks closed. Try: {}", fw.cmd)),
        _ => Ok(format!("Port {port}/tcp is now allowed in {}.", fw.kind)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn port_lists() {
        assert!(ports_cover("1025-65535/udp 1025-65535/tcp", 2422));
        assert!(ports_cover("2422/tcp", 2422));
        assert!(!ports_cover("2422/udp 22/tcp", 2422));
        assert!(!ports_cover("", 2422));
        assert!(!ports_cover("3000-4000/tcp", 2422));
    }
}
