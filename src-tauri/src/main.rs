#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    linux_graphics::prepare();
    supercharge_studio_lib::run()
}

/// Linux graphics workarounds, applied before GTK/WebKit start.
///
/// Some Wayland compositor + GPU driver combinations abort WebKitGTK at startup with
/// "Error 71 (Protocol error) dispatching to Wayland display" (DMA-BUF renderer).
/// Others fail to paint on X11 ("Failed to create GBM buffer").
/// - By default the DMA-BUF renderer is disabled unless the user set WEBKIT_DISABLE_DMABUF_RENDERER.
///   SUPERCHARGE_STUDIO_GPU=1 keeps the full GPU path.
/// - SUPERCHARGE_STUDIO_GDK_BACKEND=x11|wayland forces a GDK backend.
/// - `--safe-graphics` (or SUPERCHARGE_STUDIO_SAFE_GRAPHICS=1) also disables compositing and forces X11.
/// - On Wayland with XWayland available, if the app dies within a few seconds of starting,
///   it is relaunched once with GDK_BACKEND=x11 and compositing disabled.
///   Set SUPERCHARGE_STUDIO_NO_FALLBACK=1 to turn this off.
#[cfg(target_os = "linux")]
mod linux_graphics {
    use std::env::{set_var, var_os};
    use std::time::{Duration, Instant};

    const CHILD: &str = "SUPERCHARGE_STUDIO_GFX_CHILD";

    fn set_default(k: &str, v: &str) {
        if var_os(k).is_none() {
            // SAFETY: called at the very start of main, before any other thread exists.
            unsafe { set_var(k, v) }
        }
    }

    pub fn prepare() {
        let gpu = var_os("SUPERCHARGE_STUDIO_GPU").is_some_and(|v| v == "1");
        if !gpu {
            // No DMA-BUF/GBM buffers (the cause of Wayland "Error 71" / "Failed to create GBM
            // buffer"). Accelerated compositing stays on: WebKitGTK's no-compositing mode is
            // less tested (it crashed in view transitions). Inherited by every webview.
            set_default("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if let Some(b) = var_os("SUPERCHARGE_STUDIO_GDK_BACKEND") {
            unsafe { set_var("GDK_BACKEND", b) }
        }
        let safe = std::env::args_os().any(|a| a == "--safe-graphics")
            || var_os("SUPERCHARGE_STUDIO_SAFE_GRAPHICS").is_some_and(|v| v == "1");
        if safe {
            unsafe {
                set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
                set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            }
            if var_os("DISPLAY").is_some() {
                set_default("GDK_BACKEND", "x11");
            }
        }
        let wayland = var_os("WAYLAND_DISPLAY").is_some() || var_os("XDG_SESSION_TYPE").is_some_and(|v| v == "wayland");
        if !wayland || var_os("DISPLAY").is_none() || var_os("GDK_BACKEND").is_some() || var_os(CHILD).is_some() || var_os("SUPERCHARGE_STUDIO_NO_FALLBACK").is_some() {
            return;
        }
        // Supervise one native-Wayland attempt; fall back to XWayland if it dies early.
        let Ok(exe) = std::env::current_exe() else { return };
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        let started = Instant::now();
        let status = match std::process::Command::new(&exe).args(&args).env(CHILD, "1").status() {
            Ok(s) => s,
            Err(_) => return, // could not spawn: just run in-process
        };
        if status.success() || started.elapsed() > Duration::from_secs(5) {
            std::process::exit(status.code().unwrap_or(1));
        }
        eprintln!("supercharge-studio: Wayland start failed ({status}); retrying with GDK_BACKEND=x11");
        let status = std::process::Command::new(&exe)
            .args(&args)
            .env(CHILD, "1")
            .env("GDK_BACKEND", "x11")
            .env("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
            .status();
        std::process::exit(status.ok().and_then(|s| s.code()).unwrap_or(1));
    }
}
