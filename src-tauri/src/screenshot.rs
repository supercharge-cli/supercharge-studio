//! Native PNG capture of the side browser's visible area.
//! Linux: WebKitGTK snapshot · macOS: WKWebView takeSnapshot · Windows: WebView2 CapturePreview.

use std::sync::Mutex;
use tauri::{Runtime, Webview};
use tokio::sync::oneshot;

type Reply = Mutex<Option<oneshot::Sender<Result<Vec<u8>, String>>>>;

fn send(reply: &Reply, v: Result<Vec<u8>, String>) {
    if let Some(tx) = reply.lock().unwrap().take() {
        let _ = tx.send(v);
    }
}

pub async fn capture<R: Runtime>(wv: &Webview<R>) -> Result<Vec<u8>, String> {
    let (tx, rx) = oneshot::channel();
    let reply: std::sync::Arc<Reply> = std::sync::Arc::new(Mutex::new(Some(tx)));
    let r2 = reply.clone();
    wv.with_webview(move |pw| platform_capture(pw, r2)).map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(v)) => v,
        _ => Err("screenshot timed out".into()),
    }
}

#[cfg(target_os = "linux")]
fn platform_capture(pw: tauri::webview::PlatformWebview, reply: std::sync::Arc<Reply>) {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
    pw.inner().snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&gtk::gio::Cancellable>,
        move |res| {
            let out = res.map_err(|e| e.to_string()).and_then(|surface| {
                let img = cairo::ImageSurface::try_from(surface).map_err(|_| "not an image surface".to_string())?;
                let mut buf = Vec::new();
                img.write_to_png(&mut buf).map_err(|e| e.to_string())?;
                Ok(buf)
            });
            send(&reply, out);
        },
    );
}

#[cfg(target_os = "macos")]
fn platform_capture(pw: tauri::webview::PlatformWebview, reply: std::sync::Arc<Reply>) {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let webview: &WKWebView = unsafe { &*(pw.inner() as *const WKWebView) };
    let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let out = (|| -> Result<Vec<u8>, String> {
            if image.is_null() {
                let msg = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
                return Err(msg.unwrap_or_else(|| "snapshot failed".into()));
            }
            let image = unsafe { &*image };
            let tiff = image.TIFFRepresentation().ok_or("no TIFF representation")?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("no bitmap rep")?;
            let props = NSDictionary::new();
            let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }
                .ok_or("PNG encoding failed")?;
            Ok(png.to_vec())
        })();
        send(&reply, out);
    });
    unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &block) };
}

#[cfg(target_os = "windows")]
fn platform_capture(pw: tauri::webview::PlatformWebview, reply: std::sync::Arc<Reply>) {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    let run = || -> Result<(), String> {
        let core = unsafe { pw.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
        let stream: IStream = unsafe { SHCreateMemStream(None) }.ok_or("SHCreateMemStream failed")?;
        let s2 = stream.clone();
        let r2 = reply.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |res: windows_core::Result<()>| {
            let out = res.map_err(|e| e.to_string()).and_then(|_| unsafe {
                s2.Seek(0, STREAM_SEEK_SET, None).map_err(|e| e.to_string())?;
                let mut data = Vec::new();
                let mut chunk = [0u8; 65536];
                loop {
                    let mut read = 0u32;
                    let hr = s2.Read(chunk.as_mut_ptr() as _, chunk.len() as u32, Some(&mut read));
                    if hr.is_err() || read == 0 {
                        break;
                    }
                    data.extend_from_slice(&chunk[..read as usize]);
                }
                Ok(data)
            });
            send(&r2, out);
            Ok(())
        }));
        unsafe { core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) }
            .map_err(|e| e.to_string())
    };
    if let Err(e) = run() {
        send(&reply, Err(e));
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_capture(_pw: tauri::webview::PlatformWebview, reply: std::sync::Arc<Reply>) {
    send(&reply, Err("screenshots not supported on this platform".into()));
}
