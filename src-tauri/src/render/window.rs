// Master output window: a raw (webview-less) tauri window whose wgpu surface
// is driven by the render thread. Window and surface creation are forced onto
// the main thread (macOS requires the CAMetalLayer attach there), and on
// close the surface is dropped by the render thread BEFORE the native window
// goes away.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use tauri::{Emitter, Manager};

use super::engine::{pack_size, Job, RenderState};

pub const MASTER_LABEL: &str = "master-out";

#[tauri::command]
pub async fn render_master(
    app: tauri::AppHandle,
    state: tauri::State<'_, RenderState>,
    open: bool,
) -> Result<bool, String> {
    if !open {
        if let Some(window) = app.get_window(MASTER_LABEL) {
            // close() raises CloseRequested, whose handler tears the surface
            // down before the window dies — same path as a user close.
            window.close().map_err(|e| e.to_string())?;
        }
        return Ok(false);
    }
    if app.get_window(MASTER_LABEL).is_some() {
        return Ok(true);
    }

    let (instance, job_tx) = state
        .handles()
        .ok_or_else(|| "render engine not started".to_string())?;

    let (built_tx, built_rx) = mpsc::sync_channel(1);
    let main_app = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let window = tauri::window::WindowBuilder::new(&main_app, MASTER_LABEL)
                .title("Vizzy — Master Out")
                .inner_size(1280.0, 720.0)
                .resizable(true)
                .closable(true)
                .background_color(tauri::window::Color(0, 0, 0, 255))
                .build()
                .map_err(|e| format!("failed to create master window: {e}"))?;
            let surface = instance
                .create_surface(window.clone())
                .map_err(|e| format!("failed to create master surface: {e}"))?;
            let size = window
                .inner_size()
                .map_err(|e| format!("failed to read master window size: {e}"))?;
            Ok::<_, String>((window, surface, size))
        })();
        let _ = built_tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    let (window, surface, size) = built_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "main thread did not respond".to_string())??;

    let shared_size = Arc::new(AtomicU64::new(pack_size(
        size.width.max(1),
        size.height.max(1),
    )));

    let event_size = shared_size.clone();
    let event_tx = job_tx.clone();
    let event_app = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(s) => {
            event_size.store(
                pack_size(s.width.max(1), s.height.max(1)),
                Ordering::Relaxed,
            );
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            // Have the render thread drop the surface first, then let the
            // close proceed and tell the UI.
            let (done_tx, done_rx) = mpsc::sync_channel(1);
            if event_tx.send(Job::CloseMaster { reply: done_tx }).is_ok() {
                let _ = done_rx.recv_timeout(Duration::from_secs(2));
            }
            let _ = event_app.emit("vizzy://render-master-closed", serde_json::json!({}));
        }
        _ => {}
    });

    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    job_tx
        .send(Job::OpenMaster {
            surface: Box::new(surface),
            size: shared_size,
            reply: reply_tx,
        })
        .map_err(|_| "render thread stopped".to_string())?;
    let configured = reply_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "render thread did not respond".to_string())?;
    if let Err(e) = configured {
        let _ = window.close();
        return Err(e);
    }
    Ok(true)
}

#[tauri::command]
pub async fn render_master_fullscreen(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    let window = app
        .get_window(MASTER_LABEL)
        .ok_or_else(|| "master window is not open".to_string())?;
    window.set_fullscreen(on).map_err(|e| e.to_string())
}
