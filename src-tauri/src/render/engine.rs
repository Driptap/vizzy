// Native render engine: 8 GLSL deck pipelines into offscreen targets, a WGSL
// compositor for the scene/preview/master passes, JPEG readback events, a
// persistent offscreen master target (blitted to the optional master-output
// surface and shared over Syphon on macOS) — all driven by one render thread.
use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use tauri::Emitter;

use super::content;
use super::evaluate::{ContentAnim, Evaluator};
use super::params::{
    floats_to_bytes, pack_compositor_uniform, pack_deck_uniform, unpad_and_flip_rows, DeckDraw,
    EvaluatedFrame, SLOT_COUNT, UNIFORM_FLOATS,
};
use super::patch;
use super::state::RenderStateMsg;
use crate::audio::RawLevels;

const DECK_WIDTH: u32 = 960;
const SCENE_SIZE: (u32, u32) = (480, 270);
const PREVIEW_SIZE: (u32, u32) = (160, 90);
const FRAME_INTERVAL: Duration = Duration::from_nanos(16_666_667);
const JPEG_QUALITY: u8 = 70;
const FRAME_EVENT: &str = "vizzy://render-frame";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const TEXTURE_SHARE_EVENT: &str = "vizzy://texture-share";
const GLOW_EVENT: &str = "vizzy://glow";

/// MSAA samples for the mesh passes (models/landscapes/scenes) when the
/// adapter supports it on the deck-target format; deck shader quads and
/// sprites don't need it, mesh silhouettes do.
const MESH_MSAA_SAMPLES: u32 = 4;
/// Master glow: luma threshold for the bright pass and the additive
/// composite strength — tasteful stage glow, not bloom soup.
const GLOW_THRESHOLD: f32 = 0.6;
const GLOW_STRENGTH: f32 = 0.6;

/// The master composite is always rendered to this persistent offscreen
/// target; the window pass and Syphon both consume it. Bgra8Unorm because
/// that's the IOSurface format Syphon publishes, which keeps the share on
/// its zero-conversion blit path.
const MASTER_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
/// Master target size while no master window dictates one.
const DEFAULT_MASTER_SIZE: (u32, u32) = (1920, 1080);

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum FrameEvent {
    #[serde(rename_all = "camelCase")]
    Preview { channel: u8, jpeg_base64: String },
    #[serde(rename_all = "camelCase")]
    Scene { scene: u8, jpeg_base64: String },
}

/// A mesh parsed/normalized off the render thread, ready for GPU upload.
pub(crate) struct StagedMesh {
    /// Interleaved pos(3) normal(3) color(3) uv(2) — see vs_mesh in
    /// content.wgsl.
    pub verts: Vec<f32>,
    pub indices: Vec<u32>,
    /// Per-primitive draw ranges + materials (glTF primitives; OBJ/STL and
    /// procedural scenes are one whole-mesh primitive).
    pub primitives: Vec<content::MeshPrimitive>,
    /// Decoded base-colour textures the primitives reference by index.
    pub textures: Vec<content::MeshTexture>,
    pub kind: StagedMeshKind,
}

impl StagedMesh {
    pub(crate) fn from_mesh(mesh: content::MeshData, kind: StagedMeshKind) -> Self {
        let verts = content::interleave(&mesh);
        Self {
            verts,
            indices: mesh.indices,
            primitives: mesh.primitives,
            textures: mesh.textures,
            kind,
        }
    }
}

pub(crate) enum StagedMeshKind {
    Model,
    /// Endless-flight tile (landscape or scene). Everything here is STAGED
    /// state: the evaluator animates the camera/tiles around it per frame.
    Flight {
        base_scale: f32,
        span: f32,
        cam_height: f32,
        through: bool,
        rig: content::Rig,
        fog_color: [f32; 3],
    },
}

impl StagedMeshKind {
    /// The animation state machine a freshly staged mesh starts with.
    fn content_anim(&self) -> ContentAnim {
        match self {
            StagedMeshKind::Model => ContentAnim::Model { spin: 0.0 },
            StagedMeshKind::Flight {
                span,
                cam_height,
                through,
                ..
            } => ContentAnim::Flight {
                through: *through,
                span: *span,
                cam_height: *cam_height,
                scroll: 0.0,
            },
        }
    }
}

pub(crate) enum Job {
    Stage {
        slot: usize,
        patch: Box<patch::ComposedPatch>,
        reply: SyncSender<Result<(), String>>,
    },
    StageSprite {
        slot: usize,
        width: u32,
        height: u32,
        rgba: Vec<u8>,
        reply: SyncSender<Result<(), String>>,
    },
    StageMesh {
        slot: usize,
        mesh: Box<StagedMesh>,
        reply: SyncSender<Result<(), String>>,
    },
    /// Start a video on a slot: upload the first frame for immediate display and
    /// spawn the decode thread that feeds subsequent frames.
    StageVideo {
        slot: usize,
        path: std::path::PathBuf,
        meta: super::video::VideoMeta,
        width: u32,
        height: u32,
        rgba: Vec<u8>,
        reply: SyncSender<Result<(), String>>,
    },
    OpenMaster {
        surface: Box<wgpu::Surface<'static>>,
        size: Arc<AtomicU64>,
        reply: SyncSender<Result<(), String>>,
    },
    CloseMaster {
        reply: SyncSender<()>,
    },
    /// Start/stop texture sharing (render thread owns the server): Syphon on
    /// macOS, Spout on Windows. Replies with the resulting share state.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    TextureShare {
        on: bool,
        reply: SyncSender<Result<bool, String>>,
    },
    /// Toggle the master glow (bloom) post chain. Replies with the state.
    Glow {
        on: bool,
        reply: SyncSender<Result<bool, String>>,
    },
    Stop,
}

struct Engine {
    job_tx: Sender<Job>,
    thread: Option<JoinHandle<()>>,
    state: Arc<Mutex<RenderStateMsg>>,
    instance: Arc<wgpu::Instance>,
}

#[derive(Default)]
pub struct RenderState {
    inner: Mutex<Option<Engine>>,
}

impl RenderState {
    /// Handles needed by the master-window command (surface creation happens
    /// outside the render thread).
    pub(crate) fn handles(&self) -> Option<(Arc<wgpu::Instance>, Sender<Job>)> {
        lock(&self.inner)
            .as_ref()
            .map(|e| (e.instance.clone(), e.job_tx.clone()))
    }

    fn job_sender(&self) -> Option<Sender<Job>> {
        lock(&self.inner).as_ref().map(|e| e.job_tx.clone())
    }

    /// Stop the render thread; called from RunEvent::Exit.
    pub fn stop(&self) {
        if let Some(mut engine) = lock(&self.inner).take() {
            let _ = engine.job_tx.send(Job::Stop);
            if let Some(thread) = engine.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

#[tauri::command]
pub fn render_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, RenderState>,
    audio: tauri::State<'_, crate::audio::AudioState>,
) -> Result<(), String> {
    let mut guard = lock(&state.inner);
    if guard.is_some() {
        return Ok(());
    }
    let audio_raw = audio.raw_levels();

    let instance = Arc::new(wgpu::Instance::new(
        wgpu::InstanceDescriptor::new_without_display_handle(),
    ));
    let adapter = tauri::async_runtime::block_on(
        instance.request_adapter(&wgpu::RequestAdapterOptions::default()),
    )
    .map_err(|e| {
        let msg = format!("no compatible GPU adapter: {e}");
        eprintln!("[vizzy render] {msg}");
        msg
    })?;
    let info = adapter.get_info();
    eprintln!(
        "[vizzy render] adapter: {} | backend {:?} | driver {} {}",
        info.name, info.backend, info.driver, info.driver_info
    );
    // Request only the limits this adapter actually advertises. Desktop GPUs
    // meet wgpu's default tier, but lower-power GPUs (e.g. the Raspberry Pi 5's
    // V3D, whose max 2D texture is 4096) do not — DeviceDescriptor::default()
    // asks for the desktop tier, so request_device fails outright and the
    // engine never starts. Clamping to adapter.limits() lets it come up there;
    // the per-pass code already clamps texture sizes to device limits.
    let (device, queue) =
        tauri::async_runtime::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .map_err(|e| {
            let msg = format!("GPU device request failed: {e}");
            eprintln!("[vizzy render] {msg}");
            msg
        })?;
    // Late validation errors (e.g. a deck shader misbehaving at draw time)
    // must never abort the process.
    device.on_uncaptured_error(Arc::new(|e: wgpu::Error| {
        eprintln!("[vizzy render] uncaptured wgpu error: {e}");
    }));

    let shared_state = Arc::new(Mutex::new(RenderStateMsg::default()));
    let aspect = lock(&shared_state).aspect;
    let mut core = GpuCore::new(adapter, device, queue, aspect)?;
    for slot in 0..SLOT_COUNT {
        let composed = patch::compose(&patch::default_patch(slot))?;
        core.set_deck_patch(slot, composed)?;
    }

    let (job_tx, job_rx) = mpsc::channel();
    let thread_state = shared_state.clone();
    let thread = std::thread::Builder::new()
        .name("vizzy-render".into())
        .spawn(move || render_loop(core, app, thread_state, audio_raw, job_rx))
        .map_err(|e| format!("failed to spawn render thread: {e}"))?;

    *guard = Some(Engine {
        job_tx,
        thread: Some(thread),
        state: shared_state,
        instance,
    });
    Ok(())
}

/// The TS client pushes full control STATE here on change (coalesced); the
/// render thread evaluates it every frame on its own clock, so the master
/// output keeps running even when the webview is hidden and rAF stalls.
#[tauri::command]
pub fn render_state(engine: tauri::State<'_, RenderState>, state: RenderStateMsg) {
    if let Some(engine) = lock(&engine.inner).as_ref() {
        *lock(&engine.state) = state;
    }
}

fn check_slot(slot: u32) -> Result<usize, String> {
    if slot as usize >= SLOT_COUNT {
        return Err(format!("invalid deck slot {slot} (expected 0..7)"));
    }
    Ok(slot as usize)
}

/// Ship a staging job to the render thread and wait for its reply. CPU-heavy
/// decode/parse happens BEFORE this call (on the command's worker thread);
/// only the GPU upload + content swap run on the render thread.
fn run_job(
    state: &tauri::State<'_, RenderState>,
    make: impl FnOnce(SyncSender<Result<(), String>>) -> Job,
) -> Result<(), String> {
    let job_tx = state
        .job_sender()
        .ok_or_else(|| "render engine not started".to_string())?;
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    job_tx
        .send(make(reply_tx))
        .map_err(|_| "render thread stopped".to_string())?;
    reply_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "render thread did not respond".to_string())?
}

#[tauri::command]
pub async fn render_stage_patch(
    state: tauri::State<'_, RenderState>,
    slot: u32,
    spec: patch::PatchSpec,
) -> Result<(), String> {
    let slot = check_slot(slot)?;
    // Compose + validate on the command thread; only the pipeline build and
    // params upload run on the render thread.
    let composed = patch::compose(&spec)?;
    run_job(&state, |reply| Job::Stage {
        slot,
        patch: Box::new(composed),
        reply,
    })
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteMeta {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandscapeMeta {
    pub span: f32,
    pub cam_height: f32,
}

#[tauri::command]
pub async fn render_stage_sprite(
    state: tauri::State<'_, RenderState>,
    slot: u32,
    path: String,
) -> Result<SpriteMeta, String> {
    let slot = check_slot(slot)?;
    let (rgba, width, height) = content::load_sprite_rgba(Path::new(&path))?;
    run_job(&state, |reply| Job::StageSprite {
        slot,
        width,
        height,
        rgba,
        reply,
    })?;
    Ok(SpriteMeta { width, height })
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMeta {
    pub width: u32,
    pub height: u32,
    pub duration_s: f64,
}

#[tauri::command]
pub async fn render_stage_video(
    state: tauri::State<'_, RenderState>,
    slot: u32,
    path: String,
) -> Result<VideoMeta, String> {
    let slot = check_slot(slot)?;
    // Probe + decode the first frame on the command thread (validates the file,
    // gives instant display). The render thread uploads that frame and spawns a
    // decode thread (which re-opens the clip on its own thread) for playback.
    let mut source = super::video::open(Path::new(&path))?;
    let meta = source.meta();
    let frame = source
        .frame_at(0.0)
        .ok_or_else(|| "could not decode the first video frame".to_string())?;
    drop(source);
    run_job(&state, |reply| Job::StageVideo {
        slot,
        path: std::path::PathBuf::from(&path),
        meta,
        width: frame.width,
        height: frame.height,
        rgba: frame.rgba,
        reply,
    })?;
    Ok(VideoMeta {
        width: meta.width,
        height: meta.height,
        duration_s: meta.duration_s,
    })
}

#[tauri::command]
pub async fn render_stage_model(
    state: tauri::State<'_, RenderState>,
    slot: u32,
    path: String,
) -> Result<(), String> {
    let slot = check_slot(slot)?;
    let mut mesh = content::load_mesh(Path::new(&path))?;
    // center + 2.2/maxDim baked in: the client's unit transforms render at
    // the same size THREE's group.scale = baseScale did.
    content::bake_model_normalization(&mut mesh);
    let staged = StagedMesh::from_mesh(mesh, StagedMeshKind::Model);
    run_job(&state, |reply| Job::StageMesh {
        slot,
        mesh: Box::new(staged),
        reply,
    })
}

#[tauri::command]
pub async fn render_stage_landscape(
    state: tauri::State<'_, RenderState>,
    slot: u32,
    path: String,
) -> Result<LandscapeMeta, String> {
    let slot = check_slot(slot)?;
    let mut mesh = content::load_mesh(Path::new(&path))?;
    let layout = content::bake_tile_layout(&mut mesh, true, true);
    let (span, cam_height) = content::landscape_meta(&layout, false); // fly-over
    let staged = StagedMesh::from_mesh(
        mesh,
        StagedMeshKind::Flight {
            base_scale: layout.base_scale,
            span,
            cam_height,
            through: false,
            rig: content::LANDSCAPE_RIG,
            fog_color: [0.0, 0.0, 0.0], // landscapes fade to black
        },
    );
    run_job(&state, |reply| Job::StageMesh {
        slot,
        mesh: Box::new(staged),
        reply,
    })?;
    Ok(LandscapeMeta { span, cam_height })
}

#[tauri::command]
pub async fn render_stage_scene(
    state: tauri::State<'_, RenderState>,
    slot: u32,
    positions: Vec<f32>,
    colors: Vec<f32>,
    indices: Vec<u32>,
    fly: String,
    fog_color: [f32; 3],
) -> Result<LandscapeMeta, String> {
    let slot = check_slot(slot)?;
    let mut mesh = content::scene_mesh(&positions, &colors, &indices)?;
    let through = fly == "through";
    // tunnels keep the geometry centred on the camera axis; everything else
    // rests on y=0 and is flown over
    let layout = content::bake_tile_layout(&mut mesh, false, !through);
    let (span, cam_height) = content::landscape_meta(&layout, through);
    let staged = StagedMesh::from_mesh(
        mesh,
        StagedMeshKind::Flight {
            base_scale: layout.base_scale,
            span,
            cam_height,
            through,
            rig: content::SCENE_RIG,
            // the TS palette hex is sRGB; fog mixes in linear like THREE
            fog_color: content::srgb_to_linear3(fog_color),
        },
    );
    run_job(&state, |reply| Job::StageMesh {
        slot,
        mesh: Box::new(staged),
        reply,
    })?;
    Ok(LandscapeMeta { span, cam_height })
}

/// Toggle texture sharing of the master composite — Syphon on macOS, Spout on
/// Windows. Returns the resulting share state and notifies the UI via
/// TEXTURE_SHARE_EVENT.
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub fn render_texture_share(
    app: tauri::AppHandle,
    state: tauri::State<'_, RenderState>,
    on: bool,
) -> Result<bool, String> {
    let job_tx = state
        .job_sender()
        .ok_or_else(|| "render engine not started".to_string())?;
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    job_tx
        .send(Job::TextureShare {
            on,
            reply: reply_tx,
        })
        .map_err(|_| "render thread stopped".to_string())?;
    let sharing = reply_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "render thread did not respond".to_string())??;
    let _ = app.emit(TEXTURE_SHARE_EVENT, serde_json::json!({ "on": sharing }));
    Ok(sharing)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
pub fn render_texture_share(
    app: tauri::AppHandle,
    state: tauri::State<'_, RenderState>,
    on: bool,
) -> Result<bool, String> {
    let _ = (app, state, on);
    Err("Texture sharing needs macOS (Syphon) or Windows (Spout)".to_string())
}

/// Toggle the master glow (bloom) post chain. Returns the resulting state
/// and notifies the UI via GLOW_EVENT, mirroring render_texture_share.
#[tauri::command]
pub fn render_glow(
    app: tauri::AppHandle,
    state: tauri::State<'_, RenderState>,
    on: bool,
) -> Result<bool, String> {
    let job_tx = state
        .job_sender()
        .ok_or_else(|| "render engine not started".to_string())?;
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    job_tx
        .send(Job::Glow {
            on,
            reply: reply_tx,
        })
        .map_err(|_| "render thread stopped".to_string())?;
    let glowing = reply_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "render thread did not respond".to_string())??;
    let _ = app.emit(GLOW_EVENT, serde_json::json!({ "on": glowing }));
    Ok(glowing)
}

struct ReadTarget {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    staging: wgpu::Buffer,
    width: u32,
    height: u32,
    padded_row: u32,
}

/// The Spout sender name, matching the Syphon server name so receivers see one
/// "Vizzy Master" feed regardless of platform.
#[cfg(target_os = "windows")]
const SPOUT_SENDER_NAME: &str = "Vizzy Master";

/// CPU readback of the master target for the Spout publish: a persistent
/// staging buffer sized to the master (recreated on resize). Spout shares a
/// D3D11 texture on its own device, so unlike Syphon there is no zero-copy
/// path — the master is copied to host memory and re-uploaded.
#[cfg(target_os = "windows")]
struct MasterReadback {
    staging: wgpu::Buffer,
    size: (u32, u32),
    padded_row: u32,
}

#[cfg(target_os = "windows")]
impl MasterReadback {
    fn new(device: &wgpu::Device, size: (u32, u32)) -> Self {
        let padded_row = padded_bytes_per_row(size.0);
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("vizzy-spout-readback"),
            size: u64::from(padded_row) * u64::from(size.1),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        Self {
            staging,
            size,
            padded_row,
        }
    }

    /// Copy the master target to the staging buffer and return tightly-packed
    /// top-down BGRA. The master renders upright (vs_present), so — unlike the
    /// JPEG readbacks — its rows need no vertical flip. None on a failed map,
    /// so a bad readback skips one published frame rather than killing publish.
    fn read(&mut self, core: &GpuCore) -> Option<(Vec<u8>, u32, u32)> {
        let (w, h) = core.master_target.size;
        if (w, h) != self.size {
            *self = Self::new(&core.device, (w, h));
        }
        let mut encoder = core
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("vizzy-spout-readback"),
            });
        encoder.copy_texture_to_buffer(
            core.master_target.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &self.staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        core.queue.submit(Some(encoder.finish()));

        let slice = self.staging.slice(..);
        let (tx, rx) = mpsc::sync_channel(1);
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        if core
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .is_err()
        {
            return None;
        }
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(())) => {}
            _ => return None,
        }
        let data = slice.get_mapped_range().to_vec();
        self.staging.unmap();

        let row = w as usize * 4;
        let padded = self.padded_row as usize;
        let mut pixels = Vec::with_capacity(row * h as usize);
        for y in 0..h as usize {
            let start = y * padded;
            pixels.extend_from_slice(&data[start..start + row]);
        }
        Some((pixels, w, h))
    }
}

/// The persistent offscreen master composite (see MASTER_FORMAT). Stored
/// TOP-DOWN upright — fs_master renders with vs_present — so Syphon can
/// publish it unflipped; the window pass re-flips while sampling.
struct MasterTarget {
    // read by the Syphon (macOS) / Spout (Windows) publish and the GPU test
    // readbacks only
    #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    size: (u32, u32),
}

struct MasterOut {
    surface: wgpu::Surface<'static>,
    format: wgpu::TextureFormat,
    alpha_mode: wgpu::CompositeAlphaMode,
    size: Arc<AtomicU64>,
    configured: (u32, u32),
}

pub(crate) fn pack_size(w: u32, h: u32) -> u64 {
    (u64::from(w) << 32) | u64::from(h)
}

fn unpack_size(packed: u64) -> (u32, u32) {
    ((packed >> 32) as u32, packed as u32)
}

/// Clamp a render size to an optional max box, scaling uniformly so the aspect
/// ratio is preserved and never upscaling. `cap_w`/`cap_h` of 0 (either axis)
/// means uncapped — the size passes through unchanged.
fn cap_render_size(w: u32, h: u32, cap_w: u32, cap_h: u32) -> (u32, u32) {
    if cap_w == 0 || cap_h == 0 || w == 0 || h == 0 {
        return (w, h);
    }
    let scale = (cap_w as f32 / w as f32)
        .min(cap_h as f32 / h as f32)
        .min(1.0);
    let cw = ((w as f32 * scale).round() as u32).max(1);
    let ch = ((h as f32 * scale).round() as u32).max(1);
    (cw, ch)
}

impl MasterOut {
    fn new(
        core: &GpuCore,
        surface: wgpu::Surface<'static>,
        size: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        let caps = surface.get_capabilities(&core.adapter);
        // Prefer a non-srgb format to match WebGL's unmanaged color behavior.
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| {
                matches!(
                    f,
                    wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm
                )
            })
            .or_else(|| caps.formats.first().copied())
            .ok_or_else(|| "master surface reports no supported formats".to_string())?;
        let alpha_mode = caps
            .alpha_modes
            .first()
            .copied()
            .unwrap_or(wgpu::CompositeAlphaMode::Auto);
        let mut master = Self {
            surface,
            format,
            alpha_mode,
            size,
            configured: (0, 0),
        };
        let (w, h) = unpack_size(master.size.load(Ordering::Relaxed));
        master.configure(core, w.max(1), h.max(1));
        Ok(master)
    }

    fn configure(&mut self, core: &GpuCore, width: u32, height: u32) {
        self.surface.configure(
            &core.device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: self.format,
                width,
                height,
                present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 2,
                alpha_mode: self.alpha_mode,
                view_formats: vec![],
            },
        );
        self.configured = (width, height);
    }

    fn acquire(&mut self, core: &GpuCore) -> Option<wgpu::SurfaceTexture> {
        let (w, h) = unpack_size(self.size.load(Ordering::Relaxed));
        let (w, h) = (w.max(1), h.max(1));
        if (w, h) != self.configured {
            self.configure(core, w, h);
        }
        use wgpu::CurrentSurfaceTexture as Cst;
        match self.surface.get_current_texture() {
            Cst::Success(frame) | Cst::Suboptimal(frame) => Some(frame),
            Cst::Outdated | Cst::Lost => {
                self.configure(core, w, h);
                match self.surface.get_current_texture() {
                    Cst::Success(frame) | Cst::Suboptimal(frame) => Some(frame),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}

/// GPU-resident non-shader deck content. The ext mode in the frame params
/// chooses what to DRAW; this is what's STAGED — a mismatch (stale frame
/// during a swap) simply draws nothing for that slot.
enum DeckContent {
    None,
    Sprite {
        bind_group: wgpu::BindGroup,
        // kept alive for the bind group's sake
        _texture: wgpu::Texture,
    },
    Mesh {
        vertices: wgpu::Buffer,
        indices: wgpu::Buffer,
        prims: Vec<PrimDraw>,
        kind: StagedMeshKind,
        // kept alive for the primitive bind groups' sake
        _textures: Vec<wgpu::Texture>,
    },
}

/// One mesh primitive's index range + material bind group (group 1).
struct PrimDraw {
    range: std::ops::Range<u32>,
    bind_group: wgpu::BindGroup,
    _uniform: wgpu::Buffer,
}

/// What frame() decided to draw into a deck target this frame.
#[derive(Clone, Copy, PartialEq)]
enum SlotDraw {
    Shader,
    Sprite,
    Model,
    Flight,
    Nothing,
}

/// Floats in the sprite uniform (3 vec4s — see SpriteUniforms in content.wgsl).
const SPRITE_UNIFORM_FLOATS: usize = 12;
/// Interleaved mesh vertex: pos(3) + normal(3) + color(3) + uv(2).
const MESH_VERTEX_FLOATS: usize = 11;

/// The three glow passes' pipelines (size-independent, built once).
struct GlowPipelines {
    threshold: wgpu::RenderPipeline,
    blur: wgpu::RenderPipeline,
    composite: wgpu::RenderPipeline,
}

/// Size-dependent glow resources: two half-res ping-pong targets and the
/// bind groups wiring master → bright → blur → bright → master. Rebuilt
/// whenever the master target changes.
struct GlowChain {
    master_size: (u32, u32),
    bright_view: wgpu::TextureView,
    blur_view: wgpu::TextureView,
    bg_threshold: wgpu::BindGroup,
    bg_blur_h: wgpu::BindGroup,
    bg_blur_v: wgpu::BindGroup,
    bg_composite: wgpu::BindGroup,
    _textures: [wgpu::Texture; 2],
    _uniforms: [wgpu::Buffer; 4],
    _sampler: wgpu::Sampler,
}

pub(crate) struct GpuCore {
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,

    compositor: wgpu::ShaderModule,
    deck_pipeline_layout: wgpu::PipelineLayout,
    comp_bind_layout: wgpu::BindGroupLayout,
    scene_pipeline: wgpu::RenderPipeline,
    preview_pipeline: wgpu::RenderPipeline,
    master_pipeline: wgpu::RenderPipeline,
    /// Window present blit, keyed by the surface's format.
    present_pipeline: Option<(wgpu::TextureFormat, wgpu::RenderPipeline)>,
    blit_bind_layout: wgpu::BindGroupLayout,
    blit_pipeline_layout: wgpu::PipelineLayout,
    master_target: MasterTarget,
    master_bind_group: wgpu::BindGroup,

    deck_pipelines: Vec<Option<wgpu::RenderPipeline>>,
    deck_uniforms: Vec<wgpu::Buffer>,
    deck_bind_groups: Vec<wgpu::BindGroup>,
    deck_views: Vec<wgpu::TextureView>,
    deck_textures: Vec<wgpu::Texture>,
    deck_size: (u32, u32),
    aspect: f32,

    // patch resources (group 1 of every deck pipeline): per-slot params
    // uniform + previous-frame history texture for feedback trails
    patch_bind_layout: wgpu::BindGroupLayout,
    patch_params: Vec<wgpu::Buffer>,
    patch_bind_groups: Vec<wgpu::BindGroup>,
    history_textures: Vec<wgpu::Texture>,
    /// Whether the slot's compiled patch samples its history texture (drives
    /// the post-pass deck→history copy).
    patch_history: Vec<bool>,
    history_sampler: wgpu::Sampler,

    // non-shader deck content (Phase 3)
    sprite_pipeline: wgpu::RenderPipeline,
    sprite_bind_layout: wgpu::BindGroupLayout,
    sprite_uniforms: Vec<wgpu::Buffer>,
    mesh_model_pipeline: wgpu::RenderPipeline,
    mesh_flight_pipeline: wgpu::RenderPipeline,
    mesh_uniforms: Vec<[wgpu::Buffer; 2]>,
    mesh_bind_groups: Vec<[wgpu::BindGroup; 2]>,
    deck_content: Vec<DeckContent>,
    /// Shared Depth32Float buffer for the mesh passes (slot passes run
    /// sequentially and each clears it); recreated with the deck targets.
    /// Multisampled when the mesh passes run at 4x.
    depth_view: wgpu::TextureView,
    /// Per-primitive material bind group layout (group 1 of the mesh
    /// pipelines): sampler + base-colour texture + PrimUniforms.
    prim_bind_layout: wgpu::BindGroupLayout,
    /// 1x1 white sRGB fallback so untextured primitives sample a no-op.
    white_view: wgpu::TextureView,
    _white_texture: wgpu::Texture,
    /// Trilinear repeat sampler (white fallback / default wrap modes).
    mesh_sampler: wgpu::Sampler,
    /// MESH_MSAA_SAMPLES when the adapter supports it on the deck format,
    /// else 1 (clean fallback — pipelines and targets all follow this).
    mesh_samples: u32,
    /// Shared multisampled colour target the mesh passes resolve into the
    /// deck targets from (None at 1x); recreated with the deck size.
    msaa_view: Option<wgpu::TextureView>,

    // master glow (bloom) post chain — B5
    glow_pipelines: GlowPipelines,
    glow_bind_layout: wgpu::BindGroupLayout,
    glow_enabled: bool,
    glow: Option<GlowChain>,

    sampler: wgpu::Sampler,
    comp_uniform: wgpu::Buffer,
    comp_bind_group: wgpu::BindGroup,

    // per-deck post filters (src/render/filter.wgsl): one fullscreen pass per
    // deck writes deck_filter_textures, which the compositor samples (via
    // comp_filtered_bind_group) instead of the raw decks when any filter is on.
    comp_filtered_bind_group: wgpu::BindGroup,
    /// Held only to keep the filtered targets alive (the views borrow them).
    _deck_filter_textures: Vec<wgpu::Texture>,
    deck_filter_views: Vec<wgpu::TextureView>,
    filter_bind_layout: wgpu::BindGroupLayout,
    filter_pipeline: wgpu::RenderPipeline,
    filter_uniforms: Vec<wgpu::Buffer>,
    filter_bind_groups: Vec<wgpu::BindGroup>,

    scene_target: ReadTarget,
    preview_target: ReadTarget,
}

fn deck_size_for_aspect(aspect: f32) -> (u32, u32) {
    let aspect = if aspect.is_finite() {
        aspect.clamp(0.1, 10.0)
    } else {
        16.0 / 9.0
    };
    let height = (DECK_WIDTH as f32 / aspect).round().max(1.0) as u32;
    (DECK_WIDTH, height)
}

fn padded_bytes_per_row(width: u32) -> u32 {
    (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
}

impl GpuCore {
    pub(crate) fn new(
        adapter: wgpu::Adapter,
        device: wgpu::Device,
        queue: wgpu::Queue,
        aspect: f32,
    ) -> Result<Self, String> {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let compositor = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("vizzy-compositor"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("compositor.wgsl"))),
        });
        if let Some(err) = tauri::async_runtime::block_on(scope.pop()) {
            return Err(format!("compositor shader failed to compile: {err}"));
        }
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let content_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("vizzy-content"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("content.wgsl"))),
        });
        if let Some(err) = tauri::async_runtime::block_on(scope.pop()) {
            return Err(format!("content shader failed to compile: {err}"));
        }
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let glow_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("vizzy-glow"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("glow.wgsl"))),
        });
        if let Some(err) = tauri::async_runtime::block_on(scope.pop()) {
            return Err(format!("glow shader failed to compile: {err}"));
        }
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let filter_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("vizzy-filter"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("filter.wgsl"))),
        });
        if let Some(err) = tauri::async_runtime::block_on(scope.pop()) {
            return Err(format!("filter shader failed to compile: {err}"));
        }

        let deck_bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vizzy-deck-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(32),
                },
                count: None,
            }],
        });
        let patch_bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vizzy-patch-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(patch::PARAM_BYTES),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let deck_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("vizzy-deck-layout"),
            bind_group_layouts: &[Some(&deck_bind_layout), Some(&patch_bind_layout)],
            immediate_size: 0,
        });

        let mut comp_entries = vec![
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new((UNIFORM_FLOATS * 4) as u64),
                },
                count: None,
            },
        ];
        for i in 0..SLOT_COUNT as u32 {
            comp_entries.push(wgpu::BindGroupLayoutEntry {
                binding: 2 + i,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            });
        }
        let comp_bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vizzy-comp-bgl"),
            entries: &comp_entries,
        });
        let comp_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("vizzy-comp-layout"),
            bind_group_layouts: &[Some(&comp_bind_layout)],
            immediate_size: 0,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("vizzy-deck-sampler"),
            address_mode_u: wgpu::AddressMode::MirrorRepeat,
            address_mode_v: wgpu::AddressMode::MirrorRepeat,
            address_mode_w: wgpu::AddressMode::MirrorRepeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let comp_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("vizzy-comp-uniform"),
            size: (UNIFORM_FLOATS * 4) as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let deck_uniforms: Vec<_> = (0..SLOT_COUNT)
            .map(|i| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("vizzy-deck-uniform-{i}")),
                    size: 32,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
            .collect();
        let deck_bind_groups = deck_uniforms
            .iter()
            .enumerate()
            .map(|(i, buffer)| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some(&format!("vizzy-deck-bg-{i}")),
                    layout: &deck_bind_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    }],
                })
            })
            .collect();

        let scene_target = Self::make_read_target(&device, "vizzy-scene", SCENE_SIZE);
        let preview_target = Self::make_read_target(&device, "vizzy-preview", PREVIEW_SIZE);

        let scene_pipeline = Self::comp_pipeline(
            &device,
            &comp_pipeline_layout,
            &compositor,
            "fs_scene",
            "vs_fullscreen",
            wgpu::TextureFormat::Rgba8Unorm,
        );
        let preview_pipeline = Self::comp_pipeline(
            &device,
            &comp_pipeline_layout,
            &compositor,
            "fs_preview",
            "vs_fullscreen",
            wgpu::TextureFormat::Rgba8Unorm,
        );
        // vs_present here stores the offscreen master top-down upright; the
        // window blit and Syphon both rely on that (see MasterTarget).
        let master_pipeline = Self::comp_pipeline(
            &device,
            &comp_pipeline_layout,
            &compositor,
            "fs_master",
            "vs_present",
            MASTER_FORMAT,
        );

        // Present blit: sampler + the master texture (binding 10, matching
        // master_tex in compositor.wgsl).
        let blit_bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vizzy-blit-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 10,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let blit_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("vizzy-blit-layout"),
            bind_group_layouts: &[Some(&blit_bind_layout)],
            immediate_size: 0,
        });

        // ---- non-shader deck content: sprite + mesh pipelines ----
        let sprite_bind_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("vizzy-sprite-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(
                                (SPRITE_UNIFORM_FLOATS * 4) as u64,
                            ),
                        },
                        count: None,
                    },
                ],
            });
        let sprite_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("vizzy-sprite-layout"),
            bind_group_layouts: &[Some(&sprite_bind_layout)],
            immediate_size: 0,
        });
        let sprite_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("vizzy-sprite-pipeline"),
            layout: Some(&sprite_layout),
            vertex: wgpu::VertexState {
                module: &content_shader,
                entry_point: Some("vs_sprite"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &content_shader,
                entry_point: Some("fs_sprite"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    // classic over-blend; alpha accumulates as coverage over
                    // the transparent-black clear
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });

        let mesh_bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vizzy-mesh-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(
                        (content::MESH_UNIFORM_FLOATS * 4) as u64,
                    ),
                },
                count: None,
            }],
        });
        // Group 1: per-primitive material — sampler + base-colour texture
        // (sRGB view) + PrimUniforms.
        let prim_bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vizzy-prim-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(
                            (content::PRIM_UNIFORM_FLOATS * 4) as u64,
                        ),
                    },
                    count: None,
                },
            ],
        });
        let mesh_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("vizzy-mesh-layout"),
            bind_group_layouts: &[Some(&mesh_bind_layout), Some(&prim_bind_layout)],
            immediate_size: 0,
        });
        // MSAA 4x on the mesh passes when the deck format supports it (it
        // does on Metal); otherwise fall back to 1x cleanly.
        let mesh_samples = if adapter
            .get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm)
            .flags
            .sample_count_supported(MESH_MSAA_SAMPLES)
            && adapter
                .get_texture_format_features(wgpu::TextureFormat::Depth32Float)
                .flags
                .sample_count_supported(MESH_MSAA_SAMPLES)
        {
            MESH_MSAA_SAMPLES
        } else {
            1
        };
        // Models cull like THREE FrontSide; flight tiles render both faces
        // because the mirrored copy flips winding.
        let mesh_model_pipeline = Self::mesh_pipeline(
            &device,
            &mesh_layout,
            &content_shader,
            Some(wgpu::Face::Back),
            mesh_samples,
        );
        let mesh_flight_pipeline =
            Self::mesh_pipeline(&device, &mesh_layout, &content_shader, None, mesh_samples);

        // White fallback so fs_mesh always has a texture to sample.
        let white_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("vizzy-mesh-white"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            white_texture.as_image_copy(),
            &[255u8; 4],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let white_view = white_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mesh_sampler =
            Self::make_mesh_sampler(&device, content::TexWrap::Repeat, content::TexWrap::Repeat);

        // Glow post chain: one shared bind layout + three pipelines.
        let glow_bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("vizzy-glow-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(16),
                    },
                    count: None,
                },
            ],
        });
        let glow_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("vizzy-glow-layout"),
            bind_group_layouts: &[Some(&glow_bind_layout)],
            immediate_size: 0,
        });
        let glow_pipelines = GlowPipelines {
            threshold: Self::glow_pipeline(
                &device,
                &glow_layout,
                &glow_shader,
                "fs_threshold",
                false,
            ),
            blur: Self::glow_pipeline(&device, &glow_layout, &glow_shader, "fs_blur", false),
            composite: Self::glow_pipeline(
                &device,
                &glow_layout,
                &glow_shader,
                "fs_composite",
                true,
            ),
        };

        // Per-deck filter pass: sampler + raw deck source + the filter uniform
        // (kind/amount/param2) + the deck's resolution/time/audio uniform.
        let filter_bind_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("vizzy-filter-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(16),
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(32),
                        },
                        count: None,
                    },
                ],
            });
        let filter_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("vizzy-filter-layout"),
                bind_group_layouts: &[Some(&filter_bind_layout)],
                immediate_size: 0,
            });
        let filter_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("vizzy-filter-pipeline"),
            layout: Some(&filter_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &filter_shader,
                entry_point: Some("vs_filter"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &filter_shader,
                entry_point: Some("fs_filter"),
                compilation_options: Default::default(),
                // Deck targets are Rgba8Unorm; the pass overwrites every texel.
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let filter_uniforms: Vec<_> = (0..SLOT_COUNT)
            .map(|i| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("vizzy-filter-uniform-{i}")),
                    size: 16,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
            .collect();

        let sprite_uniforms: Vec<_> = (0..SLOT_COUNT)
            .map(|i| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("vizzy-sprite-uniform-{i}")),
                    size: (SPRITE_UNIFORM_FLOATS * 4) as u64,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
            .collect();
        // two mesh uniforms per slot: models use [0], flight decks use both tiles
        let mesh_uniforms: Vec<[wgpu::Buffer; 2]> = (0..SLOT_COUNT)
            .map(|i| {
                std::array::from_fn(|t| {
                    device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some(&format!("vizzy-mesh-uniform-{i}-{t}")),
                        size: (content::MESH_UNIFORM_FLOATS * 4) as u64,
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    })
                })
            })
            .collect();
        let mesh_bind_groups: Vec<[wgpu::BindGroup; 2]> = mesh_uniforms
            .iter()
            .enumerate()
            .map(|(i, buffers)| {
                std::array::from_fn(|t| {
                    device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some(&format!("vizzy-mesh-bg-{i}-{t}")),
                        layout: &mesh_bind_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 3,
                            resource: buffers[t].as_entire_binding(),
                        }],
                    })
                })
            })
            .collect();

        let deck_size = deck_size_for_aspect(aspect);
        let (deck_textures, deck_views) = Self::build_deck_textures(&device, deck_size);
        // Patch params + feedback history. ClampToEdge keeps trails from
        // echoing across the opposite edge when the feedback transform pans.
        let history_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("vizzy-history-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let patch_params: Vec<_> = (0..SLOT_COUNT)
            .map(|i| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("vizzy-patch-params-{i}")),
                    size: patch::PARAM_BYTES,
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
            .collect();
        let (history_textures, patch_bind_groups) = Self::build_patch_resources(
            &device,
            &patch_bind_layout,
            &patch_params,
            &history_sampler,
            deck_size,
        );
        let depth_view = Self::make_depth_view(&device, deck_size, mesh_samples);
        let msaa_view = Self::make_msaa_view(&device, deck_size, mesh_samples);
        let comp_bind_group = Self::build_comp_bind_group(
            &device,
            &comp_bind_layout,
            &sampler,
            &comp_uniform,
            &deck_views,
        );
        let (deck_filter_textures, deck_filter_views) =
            Self::build_filter_textures(&device, deck_size);
        let filter_bind_groups = Self::build_filter_bind_groups(
            &device,
            &filter_bind_layout,
            &sampler,
            &deck_views,
            &filter_uniforms,
            &deck_uniforms,
        );
        // The compositor reads these filtered targets in place of the raw decks
        // on frames where any deck has a filter active.
        let comp_filtered_bind_group = Self::build_comp_bind_group(
            &device,
            &comp_bind_layout,
            &sampler,
            &comp_uniform,
            &deck_filter_views,
        );
        let master_target = Self::make_master_target(&device, DEFAULT_MASTER_SIZE);
        let master_bind_group =
            Self::make_blit_bind_group(&device, &blit_bind_layout, &sampler, &master_target.view);

        Ok(Self {
            adapter,
            device,
            queue,
            compositor,
            deck_pipeline_layout,
            comp_bind_layout,
            scene_pipeline,
            preview_pipeline,
            master_pipeline,
            present_pipeline: None,
            blit_bind_layout,
            blit_pipeline_layout,
            master_target,
            master_bind_group,
            deck_pipelines: (0..SLOT_COUNT).map(|_| None).collect(),
            deck_uniforms,
            deck_bind_groups,
            deck_views,
            deck_textures,
            deck_size,
            aspect,
            patch_bind_layout,
            patch_params,
            patch_bind_groups,
            history_textures,
            patch_history: vec![false; SLOT_COUNT],
            history_sampler,
            sprite_pipeline,
            sprite_bind_layout,
            sprite_uniforms,
            mesh_model_pipeline,
            mesh_flight_pipeline,
            mesh_uniforms,
            mesh_bind_groups,
            deck_content: (0..SLOT_COUNT).map(|_| DeckContent::None).collect(),
            depth_view,
            prim_bind_layout,
            white_view,
            _white_texture: white_texture,
            mesh_sampler,
            mesh_samples,
            msaa_view,
            glow_pipelines,
            glow_bind_layout,
            glow_enabled: false,
            glow: None,
            sampler,
            comp_uniform,
            comp_bind_group,
            comp_filtered_bind_group,
            _deck_filter_textures: deck_filter_textures,
            deck_filter_views,
            filter_bind_layout,
            filter_pipeline,
            filter_uniforms,
            filter_bind_groups,
            scene_target,
            preview_target,
        })
    }

    fn mesh_pipeline(
        device: &wgpu::Device,
        layout: &wgpu::PipelineLayout,
        module: &wgpu::ShaderModule,
        cull_mode: Option<wgpu::Face>,
        sample_count: u32,
    ) -> wgpu::RenderPipeline {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("vizzy-mesh-pipeline"),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vs_mesh"),
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: (MESH_VERTEX_FLOATS * 4) as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![
                        0 => Float32x3, 1 => Float32x3, 2 => Float32x3, 3 => Float32x2
                    ],
                }],
            },
            primitive: wgpu::PrimitiveState {
                // vs_mesh negates clip y for the bottom-up targets, which
                // flips winding: CCW source triangles arrive clockwise.
                front_face: wgpu::FrontFace::Cw,
                cull_mode,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState {
                count: sample_count,
                ..Default::default()
            },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some("fs_mesh"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None, // opaque: fragments write alpha 1 (coverage)
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    }

    fn glow_pipeline(
        device: &wgpu::Device,
        layout: &wgpu::PipelineLayout,
        module: &wgpu::ShaderModule,
        fs_entry: &str,
        additive: bool,
    ) -> wgpu::RenderPipeline {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(fs_entry),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vs_glow"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(fs_entry),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: MASTER_FORMAT,
                    // the composite ADDS the blurred highlights onto the
                    // master; the intermediate passes overwrite
                    blend: additive.then_some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::Zero,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    }

    fn make_mesh_sampler(
        device: &wgpu::Device,
        wrap_u: content::TexWrap,
        wrap_v: content::TexWrap,
    ) -> wgpu::Sampler {
        let address = |w: content::TexWrap| match w {
            content::TexWrap::Repeat => wgpu::AddressMode::Repeat,
            content::TexWrap::Clamp => wgpu::AddressMode::ClampToEdge,
            content::TexWrap::Mirror => wgpu::AddressMode::MirrorRepeat,
        };
        // trilinear: linear min/mag + linear between the CPU-built mips
        device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("vizzy-mesh-sampler"),
            address_mode_u: address(wrap_u),
            address_mode_v: address(wrap_v),
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        })
    }

    fn make_depth_view(
        device: &wgpu::Device,
        size: (u32, u32),
        sample_count: u32,
    ) -> wgpu::TextureView {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("vizzy-deck-depth"),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth32Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&wgpu::TextureViewDescriptor::default())
    }

    /// The shared multisampled colour target the mesh passes resolve from;
    /// None when MSAA is off (mesh passes then render straight to the deck).
    fn make_msaa_view(
        device: &wgpu::Device,
        size: (u32, u32),
        sample_count: u32,
    ) -> Option<wgpu::TextureView> {
        (sample_count > 1).then(|| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("vizzy-deck-msaa"),
                    size: wgpu::Extent3d {
                        width: size.0,
                        height: size.1,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                })
                .create_view(&wgpu::TextureViewDescriptor::default())
        })
    }

    fn build_deck_textures(
        device: &wgpu::Device,
        size: (u32, u32),
    ) -> (Vec<wgpu::Texture>, Vec<wgpu::TextureView>) {
        let mut textures = Vec::with_capacity(SLOT_COUNT);
        let mut views = Vec::with_capacity(SLOT_COUNT);
        for i in 0..SLOT_COUNT {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(&format!("vizzy-deck-{i}")),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                // COPY_SRC so tests (and future capture paths) can read a
                // deck target back directly.
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            views.push(texture.create_view(&wgpu::TextureViewDescriptor::default()));
            textures.push(texture);
        }
        (textures, views)
    }

    /// Per-slot history textures (previous deck frame, for feedback trails)
    /// and the group-1 bind groups tying them to the patch params. Rebuilt
    /// with the deck targets whenever the aspect changes.
    fn build_patch_resources(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        params: &[wgpu::Buffer],
        sampler: &wgpu::Sampler,
        size: (u32, u32),
    ) -> (Vec<wgpu::Texture>, Vec<wgpu::BindGroup>) {
        let mut textures = Vec::with_capacity(SLOT_COUNT);
        let mut bind_groups = Vec::with_capacity(SLOT_COUNT);
        for (i, buffer) in params.iter().enumerate() {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(&format!("vizzy-history-{i}")),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            bind_groups.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(&format!("vizzy-patch-bg-{i}")),
                layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(sampler),
                    },
                ],
            }));
            textures.push(texture);
        }
        (textures, bind_groups)
    }

    fn build_comp_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        uniform: &wgpu::Buffer,
        deck_views: &[wgpu::TextureView],
    ) -> wgpu::BindGroup {
        let mut entries = vec![
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: uniform.as_entire_binding(),
            },
        ];
        for (i, view) in deck_views.iter().enumerate() {
            entries.push(wgpu::BindGroupEntry {
                binding: 2 + i as u32,
                resource: wgpu::BindingResource::TextureView(view),
            });
        }
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("vizzy-comp-bg"),
            layout,
            entries: &entries,
        })
    }

    /// Per-deck filter intermediates: the compositor samples these instead of
    /// the raw deck targets on frames where a filter is active. Rebuilt with the
    /// deck size (alongside build_deck_textures).
    fn build_filter_textures(
        device: &wgpu::Device,
        size: (u32, u32),
    ) -> (Vec<wgpu::Texture>, Vec<wgpu::TextureView>) {
        let mut textures = Vec::with_capacity(SLOT_COUNT);
        let mut views = Vec::with_capacity(SLOT_COUNT);
        for i in 0..SLOT_COUNT {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(&format!("vizzy-deck-filter-{i}")),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                // COPY_SRC so tests can read a filtered deck target back.
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            views.push(texture.create_view(&wgpu::TextureViewDescriptor::default()));
            textures.push(texture);
        }
        (textures, views)
    }

    /// The per-deck filter bind groups (sampler + raw deck source + filter
    /// uniform + the deck's resolution/time/audio uniform). Rebuilt whenever the
    /// deck views change, since they borrow `deck_views`.
    fn build_filter_bind_groups(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        deck_views: &[wgpu::TextureView],
        filter_uniforms: &[wgpu::Buffer],
        deck_uniforms: &[wgpu::Buffer],
    ) -> Vec<wgpu::BindGroup> {
        (0..SLOT_COUNT)
            .map(|i| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some(&format!("vizzy-filter-bg-{i}")),
                    layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::Sampler(sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&deck_views[i]),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: filter_uniforms[i].as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: deck_uniforms[i].as_entire_binding(),
                        },
                    ],
                })
            })
            .collect()
    }

    fn make_read_target(device: &wgpu::Device, label: &str, size: (u32, u32)) -> ReadTarget {
        let (width, height) = size;
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let padded_row = padded_bytes_per_row(width);
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&format!("{label}-staging")),
            size: u64::from(padded_row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        ReadTarget {
            texture,
            view,
            staging,
            width,
            height,
            padded_row,
        }
    }

    fn comp_pipeline(
        device: &wgpu::Device,
        layout: &wgpu::PipelineLayout,
        module: &wgpu::ShaderModule,
        fs_entry: &str,
        vs_entry: &str,
        format: wgpu::TextureFormat,
    ) -> wgpu::RenderPipeline {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(fs_entry),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some(vs_entry),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(fs_entry),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    }

    /// Recreate the 8 deck render targets (and the compositor bind group that
    /// samples them) when the aspect ratio moves more than 0.01.
    fn ensure_aspect(&mut self, aspect: f32) {
        if !aspect.is_finite() || (aspect - self.aspect).abs() <= 0.01 {
            return;
        }
        self.aspect = aspect;
        self.deck_size = deck_size_for_aspect(aspect);
        let (textures, views) = Self::build_deck_textures(&self.device, self.deck_size);
        self.deck_textures = textures;
        self.deck_views = views;
        let (history, patch_bgs) = Self::build_patch_resources(
            &self.device,
            &self.patch_bind_layout,
            &self.patch_params,
            &self.history_sampler,
            self.deck_size,
        );
        self.history_textures = history;
        self.patch_bind_groups = patch_bgs;
        self.depth_view = Self::make_depth_view(&self.device, self.deck_size, self.mesh_samples);
        self.msaa_view = Self::make_msaa_view(&self.device, self.deck_size, self.mesh_samples);
        self.comp_bind_group = Self::build_comp_bind_group(
            &self.device,
            &self.comp_bind_layout,
            &self.sampler,
            &self.comp_uniform,
            &self.deck_views,
        );
        let (filter_textures, filter_views) =
            Self::build_filter_textures(&self.device, self.deck_size);
        self._deck_filter_textures = filter_textures;
        self.deck_filter_views = filter_views;
        self.filter_bind_groups = Self::build_filter_bind_groups(
            &self.device,
            &self.filter_bind_layout,
            &self.sampler,
            &self.deck_views,
            &self.filter_uniforms,
            &self.deck_uniforms,
        );
        self.comp_filtered_bind_group = Self::build_comp_bind_group(
            &self.device,
            &self.comp_bind_layout,
            &self.sampler,
            &self.comp_uniform,
            &self.deck_filter_views,
        );
    }

    /// Build (or replace) a deck pipeline from a composed patch. The module
    /// is generated from trusted blocks, so a device-level failure here is an
    /// internal bug — still caught with an error scope and returned.
    pub(crate) fn set_deck_patch(
        &mut self,
        slot: usize,
        composed: patch::ComposedPatch,
    ) -> Result<(), String> {
        if slot >= SLOT_COUNT {
            return Err(format!("invalid deck slot {slot} (expected 0..7)"));
        }
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("vizzy-patch-shader"),
                source: wgpu::ShaderSource::Naga(Cow::Owned(composed.module)),
            });
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("vizzy-deck-pipeline"),
                layout: Some(&self.deck_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_patch"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_patch"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
        if let Some(err) = tauri::async_runtime::block_on(scope.pop()) {
            return Err(err.to_string());
        }
        self.queue.write_buffer(
            &self.patch_params[slot],
            0,
            &floats_to_bytes(&composed.params),
        );
        self.patch_history[slot] = composed.uses_history;
        self.deck_pipelines[slot] = Some(pipeline);
        Ok(())
    }

    /// Upload a decoded sprite and swap it in. Rows must already be flipped
    /// bottom-up (load_sprite_rgba does this) so uv (0,0) is the BOTTOM-LEFT
    /// of the upright image.
    pub(crate) fn stage_sprite(
        &mut self,
        slot: usize,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), String> {
        if slot >= SLOT_COUNT {
            return Err(format!("invalid deck slot {slot} (expected 0..7)"));
        }
        let max = self.device.limits().max_texture_dimension_2d;
        if width == 0 || height == 0 || width > max || height > max {
            return Err(format!(
                "sprite size {width}x{height} unsupported (max {max})"
            ));
        }
        if rgba.len() != (width as usize) * (height as usize) * 4 {
            return Err("sprite pixel data does not match its dimensions".into());
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("vizzy-sprite"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.queue.write_texture(
            texture.as_image_copy(),
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("vizzy-sprite-bg"),
            layout: &self.sprite_bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.sprite_uniforms[slot].as_entire_binding(),
                },
            ],
        });
        // swap only after the new content is fully built — a failed stage
        // leaves the previous content rendering
        self.deck_content[slot] = DeckContent::Sprite {
            bind_group,
            _texture: texture,
        };
        Ok(())
    }

    /// Upload a video frame, reusing the existing sprite texture in place when
    /// the dimensions match (the common case — only `write_texture`, no
    /// allocation). On a size change (or first frame) it falls back to a full
    /// (re)stage. Called every frame for active video decks.
    pub(crate) fn update_video_frame(
        &mut self,
        slot: usize,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), String> {
        if slot >= SLOT_COUNT {
            return Err(format!("invalid deck slot {slot}"));
        }
        if rgba.len() != (width as usize) * (height as usize) * 4 {
            return Err("video frame pixel data does not match its dimensions".into());
        }
        let reuse = matches!(
            &self.deck_content[slot],
            DeckContent::Sprite { _texture, .. }
                if _texture.width() == width && _texture.height() == height
        );
        if reuse {
            if let DeckContent::Sprite { _texture, .. } = &self.deck_content[slot] {
                self.queue.write_texture(
                    _texture.as_image_copy(),
                    rgba,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(width * 4),
                        rows_per_image: None,
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
            }
            Ok(())
        } else {
            self.stage_sprite(slot, width, height, rgba)
        }
    }

    /// Upload one base-colour texture: sRGB format (hardware decode at
    /// sample time) with a full CPU box-filtered mip chain.
    fn upload_mesh_texture(&self, tex: &content::MeshTexture) -> Result<wgpu::Texture, String> {
        let max = self.device.limits().max_texture_dimension_2d;
        if tex.width == 0 || tex.height == 0 || tex.width > max || tex.height > max {
            return Err(format!(
                "mesh texture size {}x{} unsupported (max {max})",
                tex.width, tex.height
            ));
        }
        if tex.rgba.len() != (tex.width as usize) * (tex.height as usize) * 4 {
            return Err("mesh texture pixel data does not match its dimensions".into());
        }
        let mip_count = content::mip_level_count(tex.width, tex.height);
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("vizzy-mesh-texture"),
            size: wgpu::Extent3d {
                width: tex.width,
                height: tex.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: mip_count,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut level = (tex.rgba.clone(), tex.width, tex.height);
        for mip in 0..mip_count {
            if mip > 0 {
                level = content::next_mip(&level.0, level.1, level.2);
            }
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: mip,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &level.0,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(level.1 * 4),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: level.1,
                    height: level.2,
                    depth_or_array_layers: 1,
                },
            );
        }
        Ok(texture)
    }

    /// Upload a parsed mesh (model or flight tile) and swap it in: vertex +
    /// index buffers, sRGB base-colour textures (mipped), and one material
    /// bind group per primitive (untextured primitives share the 1x1 white).
    pub(crate) fn stage_mesh(&mut self, slot: usize, staged: StagedMesh) -> Result<(), String> {
        if slot >= SLOT_COUNT {
            return Err(format!("invalid deck slot {slot} (expected 0..7)"));
        }
        let vert_count = staged.verts.len() / MESH_VERTEX_FLOATS;
        if vert_count == 0 || !staged.verts.len().is_multiple_of(MESH_VERTEX_FLOATS) {
            return Err("mesh has no vertices".into());
        }
        if staged.indices.is_empty() || !staged.indices.len().is_multiple_of(3) {
            return Err("mesh has no triangles".into());
        }
        if staged.indices.iter().any(|&i| i as usize >= vert_count) {
            return Err("mesh index out of range".into());
        }
        if staged.primitives.is_empty() {
            return Err("mesh has no primitives".into());
        }
        let index_count = staged.indices.len() as u32;
        for prim in &staged.primitives {
            let end = prim.start.checked_add(prim.count);
            if prim.count == 0 || end.is_none() || end.unwrap() > index_count {
                return Err("mesh primitive range out of bounds".into());
            }
            if prim.texture.is_some_and(|t| t >= staged.textures.len()) {
                return Err("mesh primitive texture index out of range".into());
            }
        }

        let mut textures = Vec::with_capacity(staged.textures.len());
        let mut texture_binds = Vec::with_capacity(staged.textures.len());
        for tex in &staged.textures {
            let texture = self.upload_mesh_texture(tex)?;
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let sampler = Self::make_mesh_sampler(&self.device, tex.wrap_u, tex.wrap_v);
            textures.push(texture);
            texture_binds.push((view, sampler));
        }

        let prims = staged
            .primitives
            .iter()
            .map(|prim| {
                let uniform = Self::buffer_with_data(
                    &self.device,
                    "vizzy-prim-uniform",
                    wgpu::BufferUsages::UNIFORM,
                    &floats_to_bytes(&content::pack_prim_uniform(prim)),
                );
                let (view, sampler) = match prim.texture {
                    Some(t) => (&texture_binds[t].0, &texture_binds[t].1),
                    None => (&self.white_view, &self.mesh_sampler),
                };
                let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("vizzy-prim-bg"),
                    layout: &self.prim_bind_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::Sampler(sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: uniform.as_entire_binding(),
                        },
                    ],
                });
                PrimDraw {
                    range: prim.start..prim.start + prim.count,
                    bind_group,
                    _uniform: uniform,
                }
            })
            .collect();

        let vertices = Self::buffer_with_data(
            &self.device,
            "vizzy-mesh-verts",
            wgpu::BufferUsages::VERTEX,
            &floats_to_bytes(&staged.verts),
        );
        let mut index_bytes = Vec::with_capacity(staged.indices.len() * 4);
        for i in &staged.indices {
            index_bytes.extend_from_slice(&i.to_ne_bytes());
        }
        let indices = Self::buffer_with_data(
            &self.device,
            "vizzy-mesh-indices",
            wgpu::BufferUsages::INDEX,
            &index_bytes,
        );
        // swap only after the new content is fully built
        self.deck_content[slot] = DeckContent::Mesh {
            vertices,
            indices,
            prims,
            kind: staged.kind,
            _textures: textures,
        };
        Ok(())
    }

    fn buffer_with_data(
        device: &wgpu::Device,
        label: &str,
        usage: wgpu::BufferUsages,
        bytes: &[u8],
    ) -> wgpu::Buffer {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: bytes.len() as u64,
            usage,
            mapped_at_creation: true,
        });
        buffer
            .slice(..)
            .get_mapped_range_mut()
            .copy_from_slice(bytes);
        buffer.unmap();
        buffer
    }

    fn make_master_target(device: &wgpu::Device, size: (u32, u32)) -> MasterTarget {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("vizzy-master"),
            size: wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: MASTER_FORMAT,
            // TEXTURE_BINDING for the window blit, COPY_SRC for Syphon's
            // blit-copy publish (and test readbacks).
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        MasterTarget {
            texture,
            view,
            size,
        }
    }

    fn make_blit_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        master_view: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("vizzy-blit-bg"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(master_view),
                },
            ],
        })
    }

    /// Resize the offscreen master target (follows the master window when
    /// open, DEFAULT_MASTER_SIZE otherwise).
    fn ensure_master_size(&mut self, width: u32, height: u32) {
        let size = (width.max(1), height.max(1));
        if self.master_target.size == size {
            return;
        }
        self.master_target = Self::make_master_target(&self.device, size);
        self.master_bind_group = Self::make_blit_bind_group(
            &self.device,
            &self.blit_bind_layout,
            &self.sampler,
            &self.master_target.view,
        );
        // the glow chain samples the master target — rebuild lazily
        self.glow = None;
    }

    /// Build (or rebuild) the glow chain for the current master target.
    /// Called only while glow is enabled, BEFORE frame encoding starts.
    fn ensure_glow(&mut self) {
        let size = self.master_target.size;
        if matches!(&self.glow, Some(g) if g.master_size == size) {
            return;
        }
        let half = ((size.0 / 2).max(1), (size.1 / 2).max(1));
        let make_half = |label: &str| {
            let tex = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: half.0,
                    height: half.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: MASTER_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
            (tex, view)
        };
        let (bright_tex, bright_view) = make_half("vizzy-glow-bright");
        let (blur_tex, blur_view) = make_half("vizzy-glow-blur");
        // (blur step x, blur step y, threshold, strength) per pass
        let uniform = |label: &str, params: [f32; 4]| {
            Self::buffer_with_data(
                &self.device,
                label,
                wgpu::BufferUsages::UNIFORM,
                &floats_to_bytes(&params),
            )
        };
        let texel = (1.0 / half.0 as f32, 1.0 / half.1 as f32);
        let uniforms = [
            uniform("vizzy-glow-u-thresh", [0.0, 0.0, GLOW_THRESHOLD, 0.0]),
            uniform("vizzy-glow-u-h", [texel.0, 0.0, 0.0, 0.0]),
            uniform("vizzy-glow-u-v", [0.0, texel.1, 0.0, 0.0]),
            uniform("vizzy-glow-u-comp", [0.0, 0.0, 0.0, GLOW_STRENGTH]),
        ];
        // clamp so edge highlights don't bleed in from a wrapped border
        let glow_sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("vizzy-glow-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let bind = |label: &str, src: &wgpu::TextureView, uniform: &wgpu::Buffer| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout: &self.glow_bind_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::Sampler(&glow_sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(src),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: uniform.as_entire_binding(),
                    },
                ],
            })
        };
        let bg_threshold = bind(
            "vizzy-glow-bg-thresh",
            &self.master_target.view,
            &uniforms[0],
        );
        let bg_blur_h = bind("vizzy-glow-bg-h", &bright_view, &uniforms[1]);
        let bg_blur_v = bind("vizzy-glow-bg-v", &blur_view, &uniforms[2]);
        let bg_composite = bind("vizzy-glow-bg-comp", &bright_view, &uniforms[3]);
        self.glow = Some(GlowChain {
            master_size: size,
            bg_threshold,
            bg_blur_h,
            bg_blur_v,
            bg_composite,
            bright_view,
            blur_view,
            _textures: [bright_tex, blur_tex],
            _uniforms: uniforms,
            _sampler: glow_sampler,
        });
    }

    fn present_pipeline_for(&mut self, format: wgpu::TextureFormat) -> &wgpu::RenderPipeline {
        let stale = !matches!(&self.present_pipeline, Some((f, _)) if *f == format);
        if stale {
            let pipeline = Self::comp_pipeline(
                &self.device,
                &self.blit_pipeline_layout,
                &self.compositor,
                "fs_blit",
                "vs_fullscreen",
                format,
            );
            self.present_pipeline = Some((format, pipeline));
        }
        &self.present_pipeline.as_ref().expect("just set").1
    }

    /// Encode and submit one full frame: 8 deck passes, the scene + preview
    /// passes with their staging copies, the offscreen master pass, and —
    /// when the master window is open — a blit onto its surface.
    fn frame(
        &mut self,
        frame: &EvaluatedFrame,
        time: f32,
        scene: u32,
        preview_slot: u32,
        surface: Option<(&wgpu::TextureView, wgpu::TextureFormat)>,
    ) {
        let (dw, dh) = self.deck_size;
        let deck_aspect = dw as f32 / dh as f32;
        let mut draws = [SlotDraw::Shader; SLOT_COUNT];
        for (i, draw) in draws.iter_mut().enumerate() {
            let slot = &frame.slots[i];
            let uniform = pack_deck_uniform(dw as f32, dh as f32, time, slot.uniforms.audio);
            self.queue
                .write_buffer(&self.deck_uniforms[i], 0, &floats_to_bytes(&uniform));
            let f = slot.filter;
            self.queue.write_buffer(
                &self.filter_uniforms[i],
                0,
                &floats_to_bytes(&[f.kind as f32, f.amount, f.param2, 0.0]),
            );

            // The evaluated draw picks what to render, the staged content
            // supplies the resources; a mismatch (frame in flight during a
            // swap) leaves the slot transparent for that frame.
            *draw = match (&slot.draw, &self.deck_content[i]) {
                (DeckDraw::Shader, _) => SlotDraw::Shader,
                (DeckDraw::Sprite(s), DeckContent::Sprite { .. }) => {
                    if !s.visible {
                        SlotDraw::Nothing
                    } else {
                        let u: [f32; SPRITE_UNIFORM_FLOATS] = [
                            s.m[0], s.m[1], s.m[2], s.m[3], s.t[0], s.t[1], s.distort, s.skew,
                            s.opacity, time, 0.0, 0.0,
                        ];
                        self.queue
                            .write_buffer(&self.sprite_uniforms[i], 0, &floats_to_bytes(&u));
                        SlotDraw::Sprite
                    }
                }
                (
                    DeckDraw::Model(m),
                    DeckContent::Mesh {
                        kind: StagedMeshKind::Model,
                        ..
                    },
                ) => {
                    if !m.visible {
                        SlotDraw::Nothing
                    } else {
                        let u = content::pack_model_uniform(m, deck_aspect);
                        self.queue
                            .write_buffer(&self.mesh_uniforms[i][0], 0, &floats_to_bytes(&u));
                        SlotDraw::Model
                    }
                }
                (
                    DeckDraw::Flight(f),
                    DeckContent::Mesh {
                        kind:
                            StagedMeshKind::Flight {
                                base_scale,
                                span,
                                rig,
                                fog_color,
                                ..
                            },
                        ..
                    },
                ) => {
                    if !f.visible {
                        SlotDraw::Nothing
                    } else {
                        for tile in 0..2 {
                            let u = content::pack_flight_uniform(
                                f,
                                tile,
                                *base_scale,
                                *span,
                                rig,
                                *fog_color,
                                deck_aspect,
                            );
                            self.queue.write_buffer(
                                &self.mesh_uniforms[i][tile],
                                0,
                                &floats_to_bytes(&u),
                            );
                        }
                        SlotDraw::Flight
                    }
                }
                _ => SlotDraw::Nothing,
            };
        }
        let comp = pack_compositor_uniform(frame, time, scene, preview_slot);
        self.queue
            .write_buffer(&self.comp_uniform, 0, &floats_to_bytes(&comp));

        // The present pipeline borrow must end before encoding starts; same
        // for the glow chain (it binds the current master target).
        if let Some((_, format)) = surface {
            self.present_pipeline_for(format);
        }
        if self.glow_enabled {
            self.ensure_glow();
        }

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("vizzy-frame"),
            });

        for (i, &draw) in draws.iter().enumerate() {
            // Cleared to transparent black each frame — alpha is coverage.
            // Mesh passes render multisampled and resolve into the deck
            // target; shader/sprite passes hit the deck target directly.
            let is_mesh = matches!(draw, SlotDraw::Model | SlotDraw::Flight);
            let msaa = if is_mesh {
                self.msaa_view.as_ref()
            } else {
                None
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("vizzy-deck-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: msaa.unwrap_or(&self.deck_views[i]),
                    depth_slice: None,
                    resolve_target: msaa.map(|_| &self.deck_views[i]),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: if msaa.is_some() {
                            wgpu::StoreOp::Discard // only the resolve survives
                        } else {
                            wgpu::StoreOp::Store
                        },
                    },
                })],
                depth_stencil_attachment: is_mesh.then_some(
                    wgpu::RenderPassDepthStencilAttachment {
                        view: &self.depth_view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Discard,
                        }),
                        stencil_ops: None,
                    },
                ),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            match draw {
                SlotDraw::Shader => {
                    if let Some(pipeline) = &self.deck_pipelines[i] {
                        pass.set_pipeline(pipeline);
                        pass.set_bind_group(0, &self.deck_bind_groups[i], &[]);
                        pass.set_bind_group(1, &self.patch_bind_groups[i], &[]);
                        pass.draw(0..3, 0..1);
                    }
                }
                SlotDraw::Sprite => {
                    if let DeckContent::Sprite { bind_group, .. } = &self.deck_content[i] {
                        pass.set_pipeline(&self.sprite_pipeline);
                        pass.set_bind_group(0, bind_group, &[]);
                        pass.draw(0..4, 0..1); // unit-quad triangle strip
                    }
                }
                SlotDraw::Model | SlotDraw::Flight => {
                    if let DeckContent::Mesh {
                        vertices,
                        indices,
                        prims,
                        ..
                    } = &self.deck_content[i]
                    {
                        let (pipeline, tiles) = if draw == SlotDraw::Model {
                            (&self.mesh_model_pipeline, 1)
                        } else {
                            (&self.mesh_flight_pipeline, 2)
                        };
                        pass.set_pipeline(pipeline);
                        pass.set_vertex_buffer(0, vertices.slice(..));
                        pass.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint32);
                        for tile in 0..tiles {
                            pass.set_bind_group(0, &self.mesh_bind_groups[i][tile], &[]);
                            for prim in prims {
                                pass.set_bind_group(1, &prim.bind_group, &[]);
                                pass.draw_indexed(prim.range.clone(), 0, 0..1);
                            }
                        }
                    }
                }
                SlotDraw::Nothing => {}
            }
            drop(pass);
            // Feedback decks keep last frame's output around for the next
            // frame's history sample.
            if draw == SlotDraw::Shader && self.patch_history[i] {
                encoder.copy_texture_to_texture(
                    self.deck_textures[i].as_image_copy(),
                    self.history_textures[i].as_image_copy(),
                    wgpu::Extent3d {
                        width: dw,
                        height: dh,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }

        // Per-deck post filters: one fullscreen pass per deck (kind 0 passes
        // through), but only when something is actually filtered — otherwise the
        // compositor samples the raw decks and these passes are skipped entirely.
        let any_filter = frame.slots.iter().any(|s| s.filter.kind != 0);
        if any_filter {
            for i in 0..SLOT_COUNT {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("vizzy-filter-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.deck_filter_views[i],
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&self.filter_pipeline);
                pass.set_bind_group(0, &self.filter_bind_groups[i], &[]);
                pass.draw(0..3, 0..1);
            }
        }
        let comp_bg = if any_filter {
            &self.comp_filtered_bind_group
        } else {
            &self.comp_bind_group
        };

        for (target, pipeline) in [
            (&self.scene_target, &self.scene_pipeline),
            (&self.preview_target, &self.preview_pipeline),
        ] {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("vizzy-comp-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, comp_bg, &[]);
            pass.draw(0..3, 0..1);
            drop(pass);
            encoder.copy_texture_to_buffer(
                target.texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &target.staging,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(target.padded_row),
                        rows_per_image: None,
                    },
                },
                wgpu::Extent3d {
                    width: target.width,
                    height: target.height,
                    depth_or_array_layers: 1,
                },
            );
        }

        // Master composite, always rendered offscreen: the window blit below
        // and the Syphon publish (after submit) both read this target.
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("vizzy-master-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.master_target.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.master_pipeline);
            pass.set_bind_group(0, comp_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        // Glow post chain on the master target, BEFORE the present blit and
        // the (post-submit) Syphon publish / monitor encode, so every
        // consumer sees it. Off = zero extra passes.
        if self.glow_enabled {
            if let Some(glow) = &self.glow {
                let mut run = |label: &str,
                               pipeline: &wgpu::RenderPipeline,
                               bind: &wgpu::BindGroup,
                               target: &wgpu::TextureView,
                               load: wgpu::LoadOp<wgpu::Color>| {
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some(label),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: target,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load,
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });
                    pass.set_pipeline(pipeline);
                    pass.set_bind_group(0, bind, &[]);
                    pass.draw(0..3, 0..1);
                };
                let clear = wgpu::LoadOp::Clear(wgpu::Color::BLACK);
                run(
                    "vizzy-glow-threshold",
                    &self.glow_pipelines.threshold,
                    &glow.bg_threshold,
                    &glow.bright_view,
                    clear,
                );
                run(
                    "vizzy-glow-blur-h",
                    &self.glow_pipelines.blur,
                    &glow.bg_blur_h,
                    &glow.blur_view,
                    clear,
                );
                run(
                    "vizzy-glow-blur-v",
                    &self.glow_pipelines.blur,
                    &glow.bg_blur_v,
                    &glow.bright_view,
                    clear,
                );
                run(
                    "vizzy-glow-composite",
                    &self.glow_pipelines.composite,
                    &glow.bg_composite,
                    &self.master_target.view,
                    wgpu::LoadOp::Load,
                );
            }
        }

        if let Some((view, format)) = surface {
            let pipeline = match &self.present_pipeline {
                Some((f, p)) if *f == format => p,
                _ => unreachable!("present pipeline prepared above"),
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("vizzy-present-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &self.master_bind_group, &[]);
            pass.draw(0..3, 0..1);
        }

        self.queue.submit(Some(encoder.finish()));
    }

    /// Map a target's staging buffer and return its padded contents. Failures
    /// return None — a bad readback must never kill the loop.
    fn read_target(&self, target: &ReadTarget) -> Option<Vec<u8>> {
        let slice = target.staging.slice(..);
        let (tx, rx) = mpsc::sync_channel(1);
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        if self
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .is_err()
        {
            return None;
        }
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(())) => {}
            _ => return None,
        }
        let data = slice.get_mapped_range().to_vec();
        target.staging.unmap();
        Some(data)
    }

    fn read_target_rgba(&self, target: &ReadTarget) -> Option<Vec<u8>> {
        self.read_target(target).map(|data| {
            unpad_and_flip_rows(
                &data,
                target.width as usize,
                target.height as usize,
                target.padded_row as usize,
            )
        })
    }
}

fn encode_jpeg_base64(rgba: &[u8], width: u32, height: u32) -> Option<String> {
    let mut jpeg = Vec::new();
    let encoder = jpeg_encoder::Encoder::new(&mut jpeg, JPEG_QUALITY);
    encoder
        .encode(
            rgba,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Rgba,
        )
        .ok()?;
    Some(BASE64.encode(jpeg))
}

/// Advance one video deck's playhead for this frame. Mutates `player.playhead`
/// and `player.dir`; the caller then seeks the decode thread there. `beat` is
/// the combined beat envelope (0..1) for the beat-linked behaviours.
fn advance_video_playhead(
    player: &mut super::video::VideoPlayer,
    params: &super::state::VideoPlayback,
    bpm: f32,
    t: f32,
    dt: f32,
    beat: f32,
) {
    let dur = if player.meta.duration_s > 0.01 {
        player.meta.duration_s
    } else {
        1.0
    };
    // Rising edge of the beat envelope — one trigger per beat.
    let onset = beat > 0.6 && player.prev_beat <= 0.6;
    player.prev_beat = beat;

    // Beat-synced loop: the clip is tempo-locked, stretched to `beat_div` beats,
    // exactly like the deck loopers' phase (evaluate.rs).
    if params.beat_sync {
        let beats = (params.beat_div.max(0.25)) as f64;
        let phase = ((t as f64 * bpm as f64 / 60.0) / beats).rem_euclid(1.0);
        player.playhead = phase * dur;
        return;
    }

    // Direction: ping-pong and beat-flip own `dir`; otherwise it follows `reverse`.
    if params.loop_mode != "ping" && !params.beat_flip {
        player.dir = if params.reverse { -1 } else { 1 };
    }
    if params.beat_flip && onset {
        player.dir = -player.dir;
    }

    let mut rate = params.rate.max(0.0) as f64;
    if params.beat_rate {
        rate *= 1.0 + 1.5 * beat as f64; // pulse faster on hits
    }
    player.playhead += dt as f64 * rate * player.dir as f64;

    match params.loop_mode.as_str() {
        "once" => player.playhead = player.playhead.clamp(0.0, dur),
        "ping" => {
            if player.playhead > dur {
                player.playhead = dur - (player.playhead - dur);
                player.dir = -1;
            } else if player.playhead < 0.0 {
                player.playhead = -player.playhead;
                player.dir = 1;
            }
        }
        _ => player.playhead = player.playhead.rem_euclid(dur),
    }

    // Beat-triggered restart (stutter/glitch).
    if params.beat_jump && onset {
        player.playhead = 0.0;
    }
}

fn render_loop(
    mut core: GpuCore,
    app: tauri::AppHandle,
    state: Arc<Mutex<RenderStateMsg>>,
    audio_raw: RawLevels,
    jobs: Receiver<Job>,
) {
    let start = Instant::now();
    let mut evaluator = Evaluator::new();
    let mut last_time: Option<f32> = None;
    let mut master: Option<MasterOut> = None;
    #[cfg(target_os = "macos")]
    let mut syphon: Option<super::syphon::SyphonOut> = None;
    #[cfg(target_os = "windows")]
    let mut spout: Option<super::spout::SpoutOut> = None;
    // Persistent CPU-readback target for the Spout publish (resizes with the
    // master); only allocated once a Spout sender is running.
    #[cfg(target_os = "windows")]
    let mut spout_readback: Option<MasterReadback> = None;
    let mut frame: u64 = 0;
    let mut next_frame = Instant::now();
    // Active video decks. Staging anything onto a slot clears its player, so a
    // reassigned deck stops decoding; a None slot is a non-video deck.
    let mut video_players: Vec<Option<super::video::VideoPlayer>> =
        (0..SLOT_COUNT).map(|_| None).collect();

    loop {
        loop {
            match jobs.try_recv() {
                Ok(Job::Stage { slot, patch, reply }) => {
                    let result = core.set_deck_patch(slot, *patch);
                    if result.is_ok() {
                        video_players[slot] = None;
                        evaluator.set_content(slot, ContentAnim::Shader);
                    }
                    let _ = reply.send(result);
                }
                Ok(Job::StageSprite {
                    slot,
                    width,
                    height,
                    rgba,
                    reply,
                }) => {
                    let result = core.stage_sprite(slot, width, height, &rgba);
                    if result.is_ok() {
                        video_players[slot] = None;
                        evaluator.set_content(
                            slot,
                            ContentAnim::Sprite {
                                image_aspect: width as f32 / height.max(1) as f32,
                                spin: 0.0,
                            },
                        );
                    }
                    let _ = reply.send(result);
                }
                Ok(Job::StageVideo {
                    slot,
                    path,
                    meta,
                    width,
                    height,
                    rgba,
                    reply,
                }) => {
                    // Upload the first frame now; playback follows from the thread.
                    let result = core.stage_sprite(slot, width, height, &rgba);
                    if result.is_ok() {
                        evaluator.set_content(
                            slot,
                            ContentAnim::Sprite {
                                image_aspect: width as f32 / height.max(1) as f32,
                                spin: 0.0,
                            },
                        );
                        video_players[slot] = Some(super::video::VideoPlayer::spawn(path, meta));
                    }
                    let _ = reply.send(result);
                }
                Ok(Job::StageMesh { slot, mesh, reply }) => {
                    let content = mesh.kind.content_anim();
                    let result = core.stage_mesh(slot, *mesh);
                    if result.is_ok() {
                        video_players[slot] = None;
                        evaluator.set_content(slot, content);
                    }
                    let _ = reply.send(result);
                }
                Ok(Job::OpenMaster {
                    surface,
                    size,
                    reply,
                }) => match MasterOut::new(&core, *surface, size) {
                    Ok(m) => {
                        master = Some(m);
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                },
                Ok(Job::CloseMaster { reply }) => {
                    // Drop the surface before the window dies (metal layer).
                    master = None;
                    let _ = reply.send(());
                }
                Ok(Job::Glow { on, reply }) => {
                    core.glow_enabled = on;
                    if !on {
                        core.glow = None; // free the half-res chain
                    }
                    let _ = reply.send(Ok(on));
                }
                #[cfg(target_os = "macos")]
                Ok(Job::TextureShare { on, reply }) => {
                    let result = match (on, &syphon) {
                        (true, None) => super::syphon::SyphonOut::new(&core.device).map(|out| {
                            syphon = Some(out);
                            true
                        }),
                        (true, Some(_)) => Ok(true),
                        (false, _) => {
                            syphon = None; // drop stops the server
                            Ok(false)
                        }
                    };
                    let _ = reply.send(result);
                }
                #[cfg(target_os = "windows")]
                Ok(Job::TextureShare { on, reply }) => {
                    let (mw, mh) = core.master_target.size;
                    let result = match (on, &spout) {
                        (true, None) => {
                            super::spout::SpoutOut::new(SPOUT_SENDER_NAME, mw, mh).map(|out| {
                                spout = Some(out);
                                true
                            })
                        }
                        (true, Some(_)) => Ok(true),
                        (false, _) => {
                            spout = None; // drop releases the sender registry slot
                            spout_readback = None; // free the readback buffer
                            Ok(false)
                        }
                    };
                    let _ = reply.send(result);
                }
                Ok(Job::Stop) | Err(TryRecvError::Disconnected) => return,
                Err(TryRecvError::Empty) => break,
            }
        }

        // Evaluate loops/AUT/audio routing on the render clock — the webview
        // only pushes state changes, so a hidden UI can't stall the output.
        let msg = lock(&state).clone();
        let raw = *lock(&audio_raw);
        let time = start.elapsed().as_secs_f32();
        let dt = (time - last_time.unwrap_or(time)).min(0.1);
        last_time = Some(time);
        let evaluated = evaluator.evaluate(&msg, raw, time, dt);

        // Advance each video deck's playhead and upload its current frame before
        // drawing — video then flows through the sprite/filter/composite path.
        // raw[7] is the combined beat envelope (audio.rs) for the beat behaviours.
        for (slot, player) in video_players.iter_mut().enumerate() {
            let Some(player) = player.as_mut() else {
                continue;
            };
            let params = msg
                .slots
                .get(slot)
                .and_then(|s| s.video.clone())
                .unwrap_or_default();
            advance_video_playhead(player, &params, msg.bpm, time, dt, raw[7]);
            player.set_target(player.playhead);
            if let Some(f) = player.take_frame() {
                let _ = core.update_video_frame(slot, f.width, f.height, &f.rgba);
            }
        }

        core.ensure_aspect(evaluated.aspect);
        // The offscreen master follows the window size when one is open, then
        // is clamped to the optional render-resolution cap. The surface stays
        // at native size (MasterOut::acquire reads m.size), so the present
        // blit stretches the capped target back up — see cap_render_size.
        let (mw, mh) = master
            .as_ref()
            .map(|m| unpack_size(m.size.load(Ordering::Relaxed)))
            .unwrap_or(DEFAULT_MASTER_SIZE);
        let (mw, mh) = cap_render_size(mw, mh, msg.render_max_w, msg.render_max_h);
        core.ensure_master_size(mw, mh);
        let scene = (frame % 2) as u32;
        let channel = (frame % 4) as u32;
        let preview_slot = evaluated.cue_scene.min(1) * 4 + channel;

        let master_frame = master
            .as_mut()
            .and_then(|m| m.acquire(&core).map(|frame| (frame, m.format)));
        let master_view = master_frame.as_ref().map(|(frame, format)| {
            (
                frame
                    .texture
                    .create_view(&wgpu::TextureViewDescriptor::default()),
                *format,
            )
        });

        core.frame(
            &evaluated,
            time,
            scene,
            preview_slot,
            master_view.as_ref().map(|(view, format)| (view, *format)),
        );

        let presented = if let Some((frame, _)) = master_frame {
            frame.present();
            true
        } else {
            false
        };

        // Publish AFTER wgpu's submit so Syphon's copy is ordered behind the
        // master pass (Metal hazard-tracks the texture across queues).
        #[cfg(target_os = "macos")]
        if let Some(out) = syphon.as_mut() {
            out.publish(&core.master_target.texture, core.master_target.size);
        }

        // Spout has no shared command queue with wgpu, so it goes through a CPU
        // readback of the (already submitted) master target — top-down BGRA
        // straight onto the shared D3D11 texture.
        #[cfg(target_os = "windows")]
        if let Some(out) = spout.as_mut() {
            let readback = spout_readback
                .get_or_insert_with(|| MasterReadback::new(&core.device, core.master_target.size));
            if let Some((pixels, w, h)) = readback.read(&core) {
                out.publish(&pixels, w, h);
            }
        }

        if let Some(rgba) = core.read_target_rgba(&core.scene_target) {
            if let Some(jpeg_base64) = encode_jpeg_base64(&rgba, SCENE_SIZE.0, SCENE_SIZE.1) {
                let _ = app.emit(
                    FRAME_EVENT,
                    FrameEvent::Scene {
                        scene: scene as u8,
                        jpeg_base64,
                    },
                );
            }
        }
        if let Some(rgba) = core.read_target_rgba(&core.preview_target) {
            if let Some(jpeg_base64) = encode_jpeg_base64(&rgba, PREVIEW_SIZE.0, PREVIEW_SIZE.1) {
                let _ = app.emit(
                    FRAME_EVENT,
                    FrameEvent::Preview {
                        channel: channel as u8,
                        jpeg_base64,
                    },
                );
            }
        }

        frame += 1;
        // The timer paces when no surface is open; vsync (Fifo) paces while
        // the master window is presenting.
        next_frame += FRAME_INTERVAL;
        let now = Instant::now();
        if next_frame > now {
            if !presented {
                std::thread::sleep(next_frame - now);
            }
        } else {
            next_frame = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgpu::naga;

    #[test]
    fn cap_render_size_preserves_aspect_and_never_upscales() {
        // uncapped (0 on either axis) passes through
        assert_eq!(cap_render_size(1920, 1080, 0, 0), (1920, 1080));
        assert_eq!(cap_render_size(1920, 1080, 1280, 0), (1920, 1080));
        // 16:9 window capped to a 16:9 box → exact fit
        assert_eq!(cap_render_size(1920, 1080, 1280, 720), (1280, 720));
        // smaller-than-cap never upscales
        assert_eq!(cap_render_size(800, 450, 1280, 720), (800, 450));
        // a taller (16:10) window scales uniformly to fit the box, keeping aspect
        let (w, h) = cap_render_size(1920, 1200, 1280, 720);
        assert!(h <= 720 && w <= 1280);
        assert!(((w as f32 / h as f32) - (1920.0 / 1200.0)).abs() < 0.01);
    }

    #[test]
    fn frame_event_serializes_to_contract_shape() {
        let preview = serde_json::to_value(FrameEvent::Preview {
            channel: 2,
            jpeg_base64: "abc".into(),
        })
        .unwrap();
        assert_eq!(
            preview,
            serde_json::json!({"kind": "preview", "channel": 2, "jpegBase64": "abc"})
        );
        let scene = serde_json::to_value(FrameEvent::Scene {
            scene: 1,
            jpeg_base64: "xyz".into(),
        })
        .unwrap();
        assert_eq!(
            scene,
            serde_json::json!({"kind": "scene", "scene": 1, "jpegBase64": "xyz"})
        );
    }

    #[test]
    fn compositor_wgsl_parses_and_validates() {
        let module = naga::front::wgsl::parse_str(include_str!("compositor.wgsl"))
            .unwrap_or_else(|e| panic!("compositor.wgsl failed to parse:\n{e}"));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("compositor.wgsl failed to validate:\n{e:?}"));
        // The engine relies on these entry points by name.
        let entries: Vec<_> = module
            .entry_points
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        for entry in [
            "vs_fullscreen",
            "vs_present",
            "fs_scene",
            "fs_master",
            "fs_preview",
            "fs_blit",
        ] {
            assert!(entries.contains(&entry), "missing entry point {entry}");
        }
    }

    #[test]
    fn glow_and_content_wgsl_parse_and_validate() {
        for (name, src) in [
            ("glow.wgsl", include_str!("glow.wgsl")),
            ("content.wgsl", include_str!("content.wgsl")),
        ] {
            let module = naga::front::wgsl::parse_str(src)
                .unwrap_or_else(|e| panic!("{name} failed to parse:\n{e}"));
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::all(),
            )
            .validate(&module)
            .unwrap_or_else(|e| panic!("{name} failed to validate:\n{e:?}"));
        }
        let module = naga::front::wgsl::parse_str(include_str!("glow.wgsl")).unwrap();
        let entries: Vec<_> = module
            .entry_points
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        for entry in ["vs_glow", "fs_threshold", "fs_blur", "fs_composite"] {
            assert!(entries.contains(&entry), "missing glow entry point {entry}");
        }
    }

    #[test]
    fn deck_target_size_follows_aspect() {
        assert_eq!(deck_size_for_aspect(16.0 / 9.0), (960, 540));
        assert_eq!(deck_size_for_aspect(1.0), (960, 960));
        // Degenerate aspects clamp instead of exploding.
        assert_eq!(deck_size_for_aspect(f32::NAN), (960, 540));
        assert_eq!(deck_size_for_aspect(0.0), (960, 9600));
    }

    fn boot_core() -> GpuCore {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = tauri::async_runtime::block_on(
            instance.request_adapter(&wgpu::RequestAdapterOptions::default()),
        )
        .expect("a GPU adapter");
        let (device, queue) = tauri::async_runtime::block_on(
            adapter.request_device(&wgpu::DeviceDescriptor::default()),
        )
        .expect("a GPU device");
        GpuCore::new(adapter, device, queue, 16.0 / 9.0).expect("core boots")
    }

    /// Read back an arbitrary texture (test only — production readbacks go
    /// through persistent staging buffers).
    fn read_texture(core: &GpuCore, texture: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
        let padded_row = padded_bytes_per_row(w);
        let staging = core.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test-staging"),
            size: u64::from(padded_row) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = core
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        core.queue.submit(Some(encoder.finish()));
        let slice = staging.slice(..);
        let (tx, rx) = mpsc::sync_channel(1);
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        core.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("poll");
        rx.recv_timeout(Duration::from_secs(2))
            .expect("map callback")
            .expect("map ok");
        let data = slice.get_mapped_range().to_vec();
        staging.unmap();
        data
    }

    /// A ComposedPatch from a hand-written fs body (an expression yielding
    /// vec4<f32> from `uv`), for probes that need exact pixel output.
    fn custom_patch(fs_expr: &str) -> patch::ComposedPatch {
        let src = format!(
            "struct VsOut {{ @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }}
@vertex
fn vs_patch(@builtin(vertex_index) vi: u32) -> VsOut {{
  let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vi & 2u) * 2.0 - 1.0;
  var out: VsOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, -y * 0.5 + 0.5);
  return out;
}}
@fragment
fn fs_patch(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {{
  return {fs_expr};
}}
"
        );
        let module = naga::front::wgsl::parse_str(&src).expect("test patch parses");
        patch::ComposedPatch {
            module,
            params: [0.0; patch::PARAM_FLOATS],
            uses_history: false,
        }
    }

    fn stage_default_patches(core: &mut GpuCore) {
        for slot in 0..SLOT_COUNT {
            let composed = patch::compose(&patch::default_patch(slot)).unwrap();
            core.set_deck_patch(slot, composed).unwrap();
        }
    }

    fn mean_luma_of_rows(rgba: &[u8], width: usize, rows: std::ops::Range<usize>) -> f64 {
        let mut sum = 0u64;
        let mut count = 0u64;
        for y in rows {
            for x in 0..width {
                let o = (y * width + x) * 4;
                sum += u64::from(rgba[o]) + u64::from(rgba[o + 1]) + u64::from(rgba[o + 2]);
                count += 3;
            }
        }
        sum as f64 / count as f64
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_full_frame_renders_and_is_upright() {
        let mut core = boot_core();
        stage_default_patches(&mut core);
        // Orientation probe in slot 0: brightness rises with uv.y, so the
        // TOP of the upright image is the bright end.
        core.set_deck_patch(0, custom_patch("vec4<f32>(vec3<f32>(uv.y), 1.0)"))
            .unwrap();

        let mut frame = EvaluatedFrame::default();
        frame.slots[0].uniforms.mix = 1.0; // all other mixes default to 0

        // Stand-in for the master window's surface texture.
        let (mw, mh) = (640u32, 360u32);
        core.ensure_master_size(mw, mh);
        let surface_tex = core.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test-surface"),
            size: wgpu::Extent3d {
                width: mw,
                height: mh,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let surface_view = surface_tex.create_view(&wgpu::TextureViewDescriptor::default());

        core.frame(
            &frame,
            0.5,
            0,
            0,
            Some((&surface_view, wgpu::TextureFormat::Rgba8Unorm)),
        );

        // Offscreen master (vs_present): stored top-down, so no flip — the
        // top of the image is the first rows. (BGRA byte order; the luma
        // helper sums all three colour bytes, so order doesn't matter.)
        let padded = read_texture(&core, &core.master_target.texture, mw, mh);
        let master = unpad_rows(&padded, mw as usize, mh as usize);
        assert!(
            master.iter().any(|&b| b > 8),
            "master readback should not be black"
        );
        let h = mh as usize;
        let top = mean_luma_of_rows(&master, mw as usize, 0..h / 2);
        let bottom = mean_luma_of_rows(&master, mw as usize, h / 2..h);
        assert!(
            top > bottom + 30.0,
            "master should be brighter on top (top={top:.1}, bottom={bottom:.1})"
        );

        // The window present blit re-flips the top-down master while
        // sampling, so the surface is upright too.
        let padded = read_texture(&core, &surface_tex, mw, mh);
        let surface = unpad_rows(&padded, mw as usize, mh as usize);
        let top = mean_luma_of_rows(&surface, mw as usize, 0..h / 2);
        let bottom = mean_luma_of_rows(&surface, mw as usize, h / 2..h);
        assert!(
            top > bottom + 30.0,
            "present blit should be brighter on top (top={top:.1}, bottom={bottom:.1})"
        );

        // Scene readback through the production path (bottom-up storage +
        // row flip): the flipped image must also be brighter on top.
        let scene = core
            .read_target_rgba(&core.scene_target)
            .expect("scene readback");
        let h = SCENE_SIZE.1 as usize;
        let top = mean_luma_of_rows(&scene, SCENE_SIZE.0 as usize, 0..h / 2);
        let bottom = mean_luma_of_rows(&scene, SCENE_SIZE.0 as usize, h / 2..h);
        assert!(
            top > bottom + 30.0,
            "flipped scene JPEG should be brighter on top (top={top:.1}, bottom={bottom:.1})"
        );

        // Preview path also produces a valid JPEG payload.
        let preview = core
            .read_target_rgba(&core.preview_target)
            .expect("preview readback");
        let jpeg = encode_jpeg_base64(&preview, PREVIEW_SIZE.0, PREVIEW_SIZE.1)
            .expect("preview JPEG encodes");
        assert!(!jpeg.is_empty());
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_offscreen_master_renders_default_decks_non_black() {
        let mut core = boot_core();
        stage_default_patches(&mut core);
        let mut frame = EvaluatedFrame::default();
        for slot in &mut frame.slots {
            slot.uniforms.mix = 1.0;
        }

        // No window, no Syphon: the master must still render offscreen.
        core.frame(&frame, 0.5, 0, 0, None);

        let (mw, mh) = core.master_target.size;
        assert_eq!((mw, mh), DEFAULT_MASTER_SIZE);
        let padded = read_texture(&core, &core.master_target.texture, mw, mh);
        let master = unpad_rows(&padded, mw as usize, mh as usize);
        let luma = mean_luma_of_rows(&master, mw as usize, 0..mh as usize);
        assert!(
            luma > 2.0,
            "offscreen master with default decks should not be black (mean luma {luma:.2})"
        );
    }

    fn unpad_rows(data: &[u8], width: usize, height: usize) -> Vec<u8> {
        let padded = padded_bytes_per_row(width as u32) as usize;
        let mut out = Vec::with_capacity(width * 4 * height);
        for y in 0..height {
            out.extend_from_slice(&data[y * padded..y * padded + width * 4]);
        }
        out
    }

    /// Upright readback of one deck target (bottom-up storage + row flip,
    /// like the production JPEG path).
    fn read_deck_upright(core: &GpuCore, slot: usize) -> Vec<u8> {
        let (dw, dh) = core.deck_size;
        let padded = read_texture(core, &core.deck_textures[slot], dw, dh);
        unpad_and_flip_rows(
            &padded,
            dw as usize,
            dh as usize,
            padded_bytes_per_row(dw) as usize,
        )
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_staged_sprite_renders_upright() {
        let mut core = boot_core();

        // 16x16 PNG: red marker in the top-left quadrant, blue elsewhere.
        let mut img = image::RgbaImage::from_pixel(16, 16, image::Rgba([0u8, 0, 255, 255]));
        for y in 0..8 {
            for x in 0..8 {
                img.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
            }
        }
        let path = std::env::temp_dir().join("vizzy-sprite-orientation-test.png");
        img.save(&path).expect("test PNG saves");
        let (rgba, w, h) = content::load_sprite_rgba(&path).expect("decodes");
        assert_eq!((w, h), (16, 16));
        core.stage_sprite(0, w, h, &rgba).expect("stages");

        // Slot 0 draw: sprite scaled to fill the whole target, no warp.
        let mut frame = EvaluatedFrame::default();
        frame.slots[0].draw = DeckDraw::Sprite(super::super::params::SpriteDraw {
            m: [2.0, 0.0, 0.0, 2.0],
            t: [0.0, 0.0],
            distort: 0.0,
            skew: 0.0,
            opacity: 1.0,
            visible: true,
        });
        core.frame(&frame, 0.0, 0, 0, None);

        let (dw, dh) = core.deck_size;
        let (dw, dh) = (dw as usize, dh as usize);
        let rgba = read_deck_upright(&core, 0);
        let px = |x: usize, y: usize| {
            let o = (y * dw + x) * 4;
            (rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3])
        };
        // upright: the red marker sits at the TOP-LEFT of the readback
        let (r, _, b, a) = px(dw / 8, dh / 8);
        assert!(
            r > 180 && b < 80 && a > 250,
            "top-left should be the red marker, got r={r} b={b} a={a}"
        );
        let (r, _, b, _) = px(dw / 8, dh * 7 / 10);
        assert!(
            b > 180 && r < 80,
            "bottom-left should be blue, got r={r} b={b}"
        );
        let (r, _, b, _) = px(dw * 7 / 10, dh / 8);
        assert!(
            b > 180 && r < 80,
            "top-right should be blue, got r={r} b={b}"
        );
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_invert_filter_inverts_deck_output() {
        let mut core = boot_core();

        // Fill deck 0 with solid blue via a full-target sprite.
        let img = image::RgbaImage::from_pixel(8, 8, image::Rgba([0u8, 0, 255, 255]));
        let path = std::env::temp_dir().join("vizzy-filter-invert-test.png");
        img.save(&path).expect("test PNG saves");
        let (rgba, w, h) = content::load_sprite_rgba(&path).expect("decodes");
        core.stage_sprite(0, w, h, &rgba).expect("stages");

        let mut frame = EvaluatedFrame::default();
        frame.slots[0].draw = DeckDraw::Sprite(super::super::params::SpriteDraw {
            m: [2.0, 0.0, 0.0, 2.0],
            t: [0.0, 0.0],
            distort: 0.0,
            skew: 0.0,
            opacity: 1.0,
            visible: true,
        });
        // Invert at full strength: solid blue (0,0,255) must read back yellow.
        frame.slots[0].filter = super::super::params::FilterFrame {
            kind: super::super::params::filter_kind_index("invert"),
            amount: 1.0,
            param2: 0.0,
        };
        core.frame(&frame, 0.0, 0, 0, None);

        let (dw, dh) = core.deck_size;
        let padded = read_texture(&core, &core._deck_filter_textures[0], dw, dh);
        let filtered = unpad_rows(&padded, dw as usize, dh as usize);
        let o = ((dh as usize / 2) * dw as usize + dw as usize / 2) * 4;
        let (r, g, b, a) = (
            filtered[o],
            filtered[o + 1],
            filtered[o + 2],
            filtered[o + 3],
        );
        assert!(
            r > 230 && g > 230 && b < 40 && a > 250,
            "invert of blue should be yellow, got r={r} g={g} b={b} a={a}"
        );
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_scene_buffers_render_non_black() {
        let mut core = boot_core();

        // A camera-facing triangle through the real stage-scene path.
        let positions = [-1.0f32, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0];
        let colors = [1.0f32; 9];
        let indices = [0u32, 1, 2];
        let mut mesh = content::scene_mesh(&positions, &colors, &indices).unwrap();
        let layout = content::bake_tile_layout(&mut mesh, false, false); // tunnel
        let (span, _cam) = content::landscape_meta(&layout, true);
        let staged = StagedMesh::from_mesh(
            mesh,
            StagedMeshKind::Flight {
                base_scale: layout.base_scale,
                span,
                cam_height: 0.0,
                through: true,
                rig: content::SCENE_RIG,
                fog_color: [0.0, 0.0, 0.0],
            },
        );
        core.stage_mesh(0, staged).expect("stages");

        // Camera 0.5 in front of tile 0's triangle, identity quat (looking
        // -z), fov 64 — inside the fog near plane, so mostly unfogged.
        let mut frame = EvaluatedFrame::default();
        frame.slots[0].draw = DeckDraw::Flight(super::super::params::FlightDraw {
            cam: [0.0, 0.0, 0.5],
            quat: [0.0, 0.0, 0.0, 1.0],
            tile_z: [0.0, -span],
            tile_scale_y: 1.0,
            brightness: 1.0,
            light_angle: 0.0,
            visible: true,
            fov_deg: 64.0,
        });
        core.frame(&frame, 0.0, 0, 0, None);

        let (dw, dh) = core.deck_size;
        let (dw, dh) = (dw as usize, dh as usize);
        let rgba = read_deck_upright(&core, 0);
        let o = (dh / 2 * dw + dw / 2) * 4;
        let luma = u32::from(rgba[o]) + u32::from(rgba[o + 1]) + u32::from(rgba[o + 2]);
        assert!(
            luma > 60,
            "scene triangle should render non-black at center, got rgb=({}, {}, {})",
            rgba[o],
            rgba[o + 1],
            rgba[o + 2]
        );
        assert_eq!(rgba[o + 3], 255, "mesh coverage alpha should be 1");

        // invisible flag blanks the deck (previous content keeps its staging)
        let mut hidden = frame.clone();
        if let DeckDraw::Flight(f) = &mut hidden.slots[0].draw {
            f.visible = false;
        }
        core.frame(&hidden, 0.0, 0, 0, None);
        let rgba = read_deck_upright(&core, 0);
        let o = (dh / 2 * dw + dw / 2) * 4;
        assert_eq!(rgba[o + 3], 0, "hidden flight deck should be transparent");
    }

    /// Stage a camera-facing model on slot 0 and render one frame.
    fn frame_model(core: &mut GpuCore, staged: StagedMesh) {
        core.stage_mesh(0, staged).expect("stages");
        let mut frame = EvaluatedFrame::default();
        frame.slots[0].draw = DeckDraw::Model(super::super::params::ModelDraw {
            pos: [0.0, 0.0, 0.0],
            quat: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
            brightness: 0.25, // keeps the lit value well below clamp
            light_angle: 0.0,
            visible: true,
        });
        core.frame(&frame, 0.0, 0, 0, None);
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_mesh_lighting_encodes_srgb_brighter_than_linear() {
        let mut core = boot_core();
        // Camera-facing white triangle (+z normals), matte material.
        let mesh = content::MeshData {
            positions: vec![[-2.0, -2.0, 0.0], [2.0, -2.0, 0.0], [0.0, 2.0, 0.0]],
            normals: vec![[0.0, 0.0, 1.0]; 3],
            colors: vec![[1.0, 1.0, 1.0]; 3],
            uvs: vec![[0.0, 0.0]; 3],
            indices: vec![0, 1, 2],
            primitives: vec![content::MeshPrimitive {
                start: 0,
                count: 3,
                base_color: [1.0, 1.0, 1.0, 1.0],
                metallic: 0.0,
                roughness: 1.0,
                texture: None,
            }],
            textures: Vec::new(),
        };
        frame_model(
            &mut core,
            StagedMesh::from_mesh(mesh, StagedMeshKind::Model),
        );

        // Expected linear lit value at the centre (normal faces the camera):
        // MODEL_RIG ambient + key Lambert at brightness 0.25, rim unlit.
        let key_dir = [2.0 / 29f32.sqrt(), 3.0 / 29f32.sqrt(), 4.0 / 29f32.sqrt()];
        let diffuse = 0.5 * 0.25 + 1.6 * 0.25 * key_dir[2];
        // Blinn-Phong key spec: roughness 1 → shininess 2, dielectric 0.04.
        let h_len = (key_dir[0] * key_dir[0]
            + key_dir[1] * key_dir[1]
            + (key_dir[2] + 1.0) * (key_dir[2] + 1.0))
            .sqrt();
        let n_dot_h = (key_dir[2] + 1.0) / h_len;
        let spec = n_dot_h.powi(2) * 0.04 * 1.6 * 0.25;
        let linear = diffuse + spec;
        let expected = content::linear_to_srgb(linear) * 255.0;

        let (dw, dh) = core.deck_size;
        let rgba = read_deck_upright(&core, 0);
        let o = ((dh as usize / 2) * dw as usize + dw as usize / 2) * 4;
        let got = f32::from(rgba[o]);
        assert!(
            (got - expected).abs() < 10.0,
            "centre should match the sRGB-encoded lit value (got {got}, expected {expected:.1})"
        );
        assert!(
            got > linear * 255.0 + 20.0,
            "sRGB path must read brighter than raw linear (got {got}, linear {:.1})",
            linear * 255.0
        );
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_textured_primitive_renders_both_checker_colors() {
        let mut core = boot_core();
        // 2x2 red/blue checker on a camera-facing quad with full UVs.
        let checker = [
            255u8, 0, 0, 255, /* */ 0, 0, 255, 255, //
            0, 0, 255, 255, /* */ 255, 0, 0, 255,
        ];
        let mesh = content::MeshData {
            positions: vec![
                [-2.0, -2.0, 0.0],
                [2.0, -2.0, 0.0],
                [2.0, 2.0, 0.0],
                [-2.0, 2.0, 0.0],
            ],
            normals: vec![[0.0, 0.0, 1.0]; 4],
            colors: vec![[1.0, 1.0, 1.0]; 4],
            uvs: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
            indices: vec![0, 1, 2, 0, 2, 3],
            primitives: vec![content::MeshPrimitive {
                start: 0,
                count: 6,
                base_color: [1.0, 1.0, 1.0, 1.0],
                metallic: 0.0,
                roughness: 1.0,
                texture: Some(0),
            }],
            textures: vec![content::MeshTexture {
                rgba: checker.to_vec(),
                width: 2,
                height: 2,
                wrap_u: content::TexWrap::Clamp,
                wrap_v: content::TexWrap::Clamp,
            }],
        };
        frame_model(
            &mut core,
            StagedMesh::from_mesh(mesh, StagedMeshKind::Model),
        );

        let (dw, dh) = core.deck_size;
        let rgba = read_deck_upright(&core, 0);
        let (mut reds, mut blues) = (0usize, 0usize);
        for px in rgba.chunks_exact(4) {
            if px[3] == 255 {
                if px[0] > 100 && px[2] < 60 {
                    reds += 1;
                }
                if px[2] > 100 && px[0] < 60 {
                    blues += 1;
                }
            }
        }
        let total = (dw as usize) * (dh as usize);
        assert!(
            reds > total / 50 && blues > total / 50,
            "both checker texel colours must render (reds={reds}, blues={blues}, total={total})"
        );
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_every_generator_builds_a_pipeline() {
        let mut core = boot_core();
        for (i, name) in patch::generator_names().iter().enumerate() {
            let spec = patch::PatchSpec {
                generator: (*name).to_string(),
                warps: vec![patch::WarpSpec {
                    kind: "kaleido".into(),
                    amount: Some(6.0),
                    audio: Some("low".into()),
                }],
                post: patch::PostSpec {
                    trail: Some(0.8),
                    ..Default::default()
                },
                ..Default::default()
            };
            let composed = patch::compose(&spec).unwrap();
            core.set_deck_patch(i % SLOT_COUNT, composed)
                .unwrap_or_else(|e| panic!("generator {name} failed to build a pipeline:\n{e}"));
        }
    }

    #[test]
    #[ignore] // needs a GPU — run locally with `cargo test -- --ignored`
    fn gpu_glow_spills_past_quad_bounds_only_when_enabled() {
        let mut core = boot_core();
        // Small bright quad on black: slot 0 shader, full mix.
        core.set_deck_patch(
            0,
            custom_patch(
                "vec4<f32>(vec3<f32>(step(abs(uv.x - 0.5), 0.1) * step(abs(uv.y - 0.5), 0.1)), 1.0)",
            ),
        )
        .unwrap();
        let mut frame = EvaluatedFrame::default();
        frame.slots[0].uniforms.mix = 1.0;

        let (mw, mh) = DEFAULT_MASTER_SIZE;
        // The quad spans x 0.4..0.6 → right edge at 1152; probe just outside.
        let probe = |core: &GpuCore| -> (u64, u8) {
            let padded = read_texture(core, &core.master_target.texture, mw, mh);
            let master = unpad_rows(&padded, mw as usize, mh as usize);
            let mut outside = 0u64;
            for y in (mh as usize / 2 - 10)..(mh as usize / 2 + 10) {
                for x in 1156..1166usize {
                    let o = (y * mw as usize + x) * 4;
                    outside +=
                        u64::from(master[o]) + u64::from(master[o + 1]) + u64::from(master[o + 2]);
                }
            }
            let o = ((mh as usize / 2) * mw as usize + mw as usize / 2) * 4;
            (outside, master[o]) // (energy outside the quad, centre byte)
        };

        // glow OFF (default): zero passes, nothing outside the quad
        core.frame(&frame, 0.0, 0, 0, None);
        let (outside_off, centre_off) = probe(&core);
        assert!(centre_off > 200, "quad centre should be bright");
        assert_eq!(outside_off, 0, "no glow: outside the quad must be black");

        // glow ON: blurred highlights spill past the quad bounds
        core.glow_enabled = true;
        core.frame(&frame, 0.0, 0, 0, None);
        let (outside_on, centre_on) = probe(&core);
        assert!(centre_on > 200, "quad centre stays bright with glow");
        assert!(
            outside_on > 0,
            "glow on: pixels outside the quad bounds must be nonzero"
        );

        // toggling off again drops the chain and the spill
        core.glow_enabled = false;
        core.glow = None;
        core.frame(&frame, 0.0, 0, 0, None);
        let (outside_off2, _) = probe(&core);
        assert_eq!(outside_off2, 0, "glow off again: spill disappears");
    }
}
