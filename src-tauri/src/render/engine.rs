// Native render engine: 8 GLSL deck pipelines into offscreen targets, a WGSL
// compositor for the scene/preview/master passes, JPEG readback events, and
// an optional master-output surface — all driven by one render thread.
use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use tauri::Emitter;
use wgpu::naga;

use super::ingest;
use super::params::{
    floats_to_bytes, pack_compositor_uniform, pack_deck_uniform, unpack_slot, unpad_and_flip_rows,
    RenderParams, SLOT_COUNT, UNIFORM_FLOATS,
};

const DECK_WIDTH: u32 = 960;
const SCENE_SIZE: (u32, u32) = (480, 270);
const PREVIEW_SIZE: (u32, u32) = (160, 90);
const FRAME_INTERVAL: Duration = Duration::from_nanos(16_666_667);
const JPEG_QUALITY: u8 = 70;
const FRAME_EVENT: &str = "vizzy://render-frame";

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

pub(crate) enum Job {
    Stage {
        slot: usize,
        module: Box<naga::Module>,
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
    Stop,
}

struct Engine {
    job_tx: Sender<Job>,
    thread: Option<JoinHandle<()>>,
    params: Arc<Mutex<RenderParams>>,
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
) -> Result<(), String> {
    let mut guard = lock(&state.inner);
    if guard.is_some() {
        return Ok(());
    }

    let instance = Arc::new(wgpu::Instance::new(
        wgpu::InstanceDescriptor::new_without_display_handle(),
    ));
    let adapter = tauri::async_runtime::block_on(
        instance.request_adapter(&wgpu::RequestAdapterOptions::default()),
    )
    .map_err(|e| format!("no compatible GPU adapter: {e}"))?;
    let (device, queue) =
        tauri::async_runtime::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .map_err(|e| format!("GPU device request failed: {e}"))?;
    // Late validation errors (e.g. a deck shader misbehaving at draw time)
    // must never abort the process.
    device.on_uncaptured_error(Arc::new(|e: wgpu::Error| {
        eprintln!("[vizzy render] uncaptured wgpu error: {e}");
    }));

    let params = Arc::new(Mutex::new(RenderParams::default()));
    let aspect = lock(&params).aspect;
    let mut core = GpuCore::new(adapter, device, queue, aspect)?;
    for (slot, phase) in ingest::DEFAULT_DECK_PHASES.iter().enumerate() {
        let module = ingest::validate_deck_shader(&ingest::default_deck_body(*phase))?;
        core.set_deck_pipeline(slot, module)?;
    }

    let (job_tx, job_rx) = mpsc::channel();
    let thread_params = params.clone();
    let thread = std::thread::Builder::new()
        .name("vizzy-render".into())
        .spawn(move || render_loop(core, app, thread_params, job_rx))
        .map_err(|e| format!("failed to spawn render thread: {e}"))?;

    *guard = Some(Engine {
        job_tx,
        thread: Some(thread),
        params,
        instance,
    });
    Ok(())
}

#[tauri::command]
pub fn render_params(state: tauri::State<'_, RenderState>, params: RenderParams) {
    if let Some(engine) = lock(&state.inner).as_ref() {
        *lock(&engine.params) = params;
    }
}

#[tauri::command]
pub async fn render_stage_shader(
    state: tauri::State<'_, RenderState>,
    slot: u32,
    body: String,
) -> Result<(), String> {
    if slot as usize >= SLOT_COUNT {
        return Err(format!("invalid deck slot {slot} (expected 0..7)"));
    }
    // Cheap naga parse/validate first — same frontend wgpu compiles with, so
    // most failures are caught here with good errors for the repair loop.
    let module = ingest::validate_deck_shader(&body)?;
    let job_tx = state
        .job_sender()
        .ok_or_else(|| "render engine not started".to_string())?;
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    job_tx
        .send(Job::Stage {
            slot: slot as usize,
            module: Box::new(module),
            reply: reply_tx,
        })
        .map_err(|_| "render thread stopped".to_string())?;
    reply_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "render thread did not respond".to_string())?
}

struct ReadTarget {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    staging: wgpu::Buffer,
    width: u32,
    height: u32,
    padded_row: u32,
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

pub(crate) struct GpuCore {
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,

    compositor: wgpu::ShaderModule,
    deck_pipeline_layout: wgpu::PipelineLayout,
    comp_bind_layout: wgpu::BindGroupLayout,
    comp_pipeline_layout: wgpu::PipelineLayout,
    scene_pipeline: wgpu::RenderPipeline,
    preview_pipeline: wgpu::RenderPipeline,
    master_pipeline: Option<(wgpu::TextureFormat, wgpu::RenderPipeline)>,

    deck_pipelines: Vec<Option<wgpu::RenderPipeline>>,
    deck_uniforms: Vec<wgpu::Buffer>,
    deck_bind_groups: Vec<wgpu::BindGroup>,
    deck_views: Vec<wgpu::TextureView>,
    deck_textures: Vec<wgpu::Texture>,
    deck_size: (u32, u32),
    aspect: f32,

    sampler: wgpu::Sampler,
    comp_uniform: wgpu::Buffer,
    comp_bind_group: wgpu::BindGroup,
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
        let deck_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("vizzy-deck-layout"),
            bind_group_layouts: &[Some(&deck_bind_layout)],
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

        let deck_size = deck_size_for_aspect(aspect);
        let (deck_textures, deck_views) = Self::build_deck_textures(&device, deck_size);
        let comp_bind_group = Self::build_comp_bind_group(
            &device,
            &comp_bind_layout,
            &sampler,
            &comp_uniform,
            &deck_views,
        );

        Ok(Self {
            adapter,
            device,
            queue,
            compositor,
            deck_pipeline_layout,
            comp_bind_layout,
            comp_pipeline_layout,
            scene_pipeline,
            preview_pipeline,
            master_pipeline: None,
            deck_pipelines: (0..SLOT_COUNT).map(|_| None).collect(),
            deck_uniforms,
            deck_bind_groups,
            deck_views,
            deck_textures,
            deck_size,
            aspect,
            sampler,
            comp_uniform,
            comp_bind_group,
            scene_target,
            preview_target,
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
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            views.push(texture.create_view(&wgpu::TextureViewDescriptor::default()));
            textures.push(texture);
        }
        (textures, views)
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
        self.comp_bind_group = Self::build_comp_bind_group(
            &self.device,
            &self.comp_bind_layout,
            &self.sampler,
            &self.comp_uniform,
            &self.deck_views,
        );
    }

    /// Build (or replace) a deck pipeline from a validated naga module. Device
    /// level failures are caught with an error scope and returned verbatim —
    /// they feed the LLM repair loop.
    pub(crate) fn set_deck_pipeline(
        &mut self,
        slot: usize,
        module: naga::Module,
    ) -> Result<(), String> {
        if slot >= SLOT_COUNT {
            return Err(format!("invalid deck slot {slot} (expected 0..7)"));
        }
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("vizzy-deck-shader"),
                source: wgpu::ShaderSource::Naga(Cow::Owned(module)),
            });
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("vizzy-deck-pipeline"),
                layout: Some(&self.deck_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &self.compositor,
                    entry_point: Some("vs_fullscreen"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("main"),
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
        self.deck_pipelines[slot] = Some(pipeline);
        Ok(())
    }

    fn master_pipeline_for(&mut self, format: wgpu::TextureFormat) -> &wgpu::RenderPipeline {
        let stale = !matches!(&self.master_pipeline, Some((f, _)) if *f == format);
        if stale {
            let pipeline = Self::comp_pipeline(
                &self.device,
                &self.comp_pipeline_layout,
                &self.compositor,
                "fs_master",
                "vs_present",
                format,
            );
            self.master_pipeline = Some((format, pipeline));
        }
        &self.master_pipeline.as_ref().expect("just set").1
    }

    /// Encode and submit one full frame: 8 deck passes, the scene + preview
    /// passes with their staging copies, and optionally the master pass.
    fn frame(
        &mut self,
        params: &RenderParams,
        time: f32,
        scene: u32,
        preview_slot: u32,
        master_view: Option<(&wgpu::TextureView, wgpu::TextureFormat)>,
    ) {
        let (dw, dh) = self.deck_size;
        for i in 0..SLOT_COUNT {
            let slot = unpack_slot(&params.slots, i);
            let uniform = pack_deck_uniform(dw as f32, dh as f32, time, slot.audio);
            self.queue
                .write_buffer(&self.deck_uniforms[i], 0, &floats_to_bytes(&uniform));
        }
        let comp = pack_compositor_uniform(params, time, scene, preview_slot);
        self.queue
            .write_buffer(&self.comp_uniform, 0, &floats_to_bytes(&comp));

        // The master pipeline borrow must end before encoding starts.
        if let Some((_, format)) = master_view {
            self.master_pipeline_for(format);
        }

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("vizzy-frame"),
            });

        for i in 0..SLOT_COUNT {
            // Cleared to transparent black each frame — alpha is coverage.
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("vizzy-deck-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.deck_views[i],
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
            if let Some(pipeline) = &self.deck_pipelines[i] {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &self.deck_bind_groups[i], &[]);
                pass.draw(0..3, 0..1);
            }
        }

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
            pass.set_bind_group(0, &self.comp_bind_group, &[]);
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

        if let Some((view, format)) = master_view {
            let pipeline = match &self.master_pipeline {
                Some((f, p)) if *f == format => p,
                _ => unreachable!("master pipeline prepared above"),
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("vizzy-master-pass"),
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
            pass.set_bind_group(0, &self.comp_bind_group, &[]);
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

fn render_loop(
    mut core: GpuCore,
    app: tauri::AppHandle,
    params: Arc<Mutex<RenderParams>>,
    jobs: Receiver<Job>,
) {
    let start = Instant::now();
    let mut master: Option<MasterOut> = None;
    let mut frame: u64 = 0;
    let mut next_frame = Instant::now();

    loop {
        loop {
            match jobs.try_recv() {
                Ok(Job::Stage {
                    slot,
                    module,
                    reply,
                }) => {
                    let _ = reply.send(core.set_deck_pipeline(slot, *module));
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
                Ok(Job::Stop) | Err(TryRecvError::Disconnected) => return,
                Err(TryRecvError::Empty) => break,
            }
        }

        let p = lock(&params).clone();
        core.ensure_aspect(p.aspect);
        let time = start.elapsed().as_secs_f32();
        let scene = (frame % 2) as u32;
        let channel = (frame % 4) as u32;
        let preview_slot = p.cue_scene.min(1) * 4 + channel;

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
            &p,
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
        ] {
            assert!(entries.contains(&entry), "missing entry point {entry}");
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
        for (slot, phase) in ingest::DEFAULT_DECK_PHASES.iter().enumerate() {
            let module = ingest::validate_deck_shader(&ingest::default_deck_body(*phase)).unwrap();
            core.set_deck_pipeline(slot, module).unwrap();
        }
        // Orientation probe in slot 0: brightness rises with vUv.y, so the
        // TOP of the upright image is the bright end.
        let module =
            ingest::validate_deck_shader("void main() { gl_FragColor = vec4(vec3(vUv.y), 1.0); }")
                .unwrap();
        core.set_deck_pipeline(0, module).unwrap();

        let mut params = RenderParams::default();
        params.slots[0] = 1.0; // slot 0 mix full; all other mixes default to 0

        // Offscreen stand-in for the master surface.
        let (mw, mh) = (640u32, 360u32);
        let master_tex = core.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test-master"),
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
        let master_view = master_tex.create_view(&wgpu::TextureViewDescriptor::default());

        core.frame(
            &params,
            0.5,
            0,
            0,
            Some((&master_view, wgpu::TextureFormat::Rgba8Unorm)),
        );

        // Master pass (vs_present): stored top-down, so no flip — the top of
        // the image is the first rows.
        let padded = read_texture(&core, &master_tex, mw, mh);
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

    fn unpad_rows(data: &[u8], width: usize, height: usize) -> Vec<u8> {
        let padded = padded_bytes_per_row(width as u32) as usize;
        let mut out = Vec::with_capacity(width * 4 * height);
        for y in 0..height {
            out.extend_from_slice(&data[y * padded..y * padded + width * 4]);
        }
        out
    }
}
