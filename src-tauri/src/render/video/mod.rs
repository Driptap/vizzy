// Native video decoding. A `FrameSource` opens a clip and yields RGBA frames at
// arbitrary times — random-access so reverse / jumps / beat behaviours all work
// the same way. Frames come out row-flipped bottom-up and capped to
// `MAX_VIDEO_DIM`, matching `content::load_sprite_rgba`, so a video deck reuses
// the entire sprite upload + draw + effects pipeline.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

#[cfg(target_os = "linux")]
mod gst;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod mf;

/// Longest-side cap for decoded frames — bounds memory and per-frame upload cost.
pub const MAX_VIDEO_DIM: u32 = 1280;

#[derive(Clone, Copy)]
pub struct VideoMeta {
    pub width: u32,
    pub height: u32,
    pub duration_s: f64,
}

/// A decoded RGBA8 frame, rows bottom-up (texture v=0 is the image bottom).
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// A random-access source of video frames. Implementations decode the frame
/// nearest the requested time.
pub trait FrameSource {
    fn meta(&self) -> VideoMeta;
    fn frame_at(&mut self, t_secs: f64) -> Option<DecodedFrame>;
}

/// Open a clip for decoding. Errors (unsupported platform, unreadable file)
/// surface to the staging command.
#[cfg(target_os = "macos")]
pub fn open(path: &Path) -> Result<Box<dyn FrameSource>, String> {
    macos::MacVideo::open(path).map(|v| Box::new(v) as Box<dyn FrameSource>)
}

#[cfg(target_os = "linux")]
pub fn open(path: &Path) -> Result<Box<dyn FrameSource>, String> {
    gst::GstVideo::open(path).map(|v| Box::new(v) as Box<dyn FrameSource>)
}

#[cfg(target_os = "windows")]
pub fn open(path: &Path) -> Result<Box<dyn FrameSource>, String> {
    mf::MfVideo::open(path).map(|v| Box::new(v) as Box<dyn FrameSource>)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn open(_path: &Path) -> Result<Box<dyn FrameSource>, String> {
    Err("video playback is not supported on this platform".into())
}

/// A running video on a deck slot: a background decode thread that seeks toward
/// a target playhead the render thread keeps updating, plus the render-thread
/// playback state (playhead, direction, beat edge). The decoder lives entirely
/// on the decode thread, so non-Send native handles never cross threads.
pub struct VideoPlayer {
    running: Arc<AtomicBool>,
    /// Render thread writes the desired playhead (seconds); decode thread reads it.
    target: Arc<Mutex<f64>>,
    /// Decode thread writes the latest decoded frame; render thread takes it.
    frame: Arc<Mutex<Option<DecodedFrame>>>,
    handle: Option<JoinHandle<()>>,
    pub meta: VideoMeta,
    // Render-thread playback state:
    pub playhead: f64,
    pub dir: i8,
    pub prev_beat: f32,
}

impl VideoPlayer {
    /// Spawn the decode thread. `meta` is the clip metadata already probed by
    /// the staging command (so the render thread can loop immediately).
    pub fn spawn(path: PathBuf, meta: VideoMeta) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let target = Arc::new(Mutex::new(0.0));
        let frame = Arc::new(Mutex::new(None));
        let handle = {
            let running = Arc::clone(&running);
            let target = Arc::clone(&target);
            let frame = Arc::clone(&frame);
            std::thread::spawn(move || decode_loop(path, running, target, frame))
        };
        Self {
            running,
            target,
            frame,
            handle: Some(handle),
            meta,
            playhead: 0.0,
            dir: 1,
            prev_beat: 0.0,
        }
    }

    /// Tell the decode thread which time to seek toward.
    pub fn set_target(&self, t_secs: f64) {
        *lock(&self.target) = t_secs;
    }

    /// Take the most recently decoded frame, if a new one is ready.
    pub fn take_frame(&self) -> Option<DecodedFrame> {
        lock(&self.frame).take()
    }
}

impl Drop for VideoPlayer {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Background decode: open the clip on this thread (keeping the native decoder
/// thread-local) and keep the shared frame slot filled at the target playhead.
fn decode_loop(
    path: PathBuf,
    running: Arc<AtomicBool>,
    target: Arc<Mutex<f64>>,
    frame: Arc<Mutex<Option<DecodedFrame>>>,
) {
    let mut source = match open(&path) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("[vizzy video] decode thread: {err}");
            return;
        }
    };
    let mut last_t = f64::NAN;
    while running.load(Ordering::SeqCst) {
        let want = *lock(&target);
        // Re-decode only when the playhead has moved meaningfully (~half a frame
        // at 60fps), so a paused clip doesn't spin the decoder.
        if last_t.is_nan() || (want - last_t).abs() > 0.008 {
            if let Some(decoded) = source.frame_at(want) {
                *lock(&frame) = Some(decoded);
                last_t = want;
            }
        }
        std::thread::sleep(Duration::from_millis(3));
    }
}
