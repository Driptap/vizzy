use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use tauri::Emitter;

const FFT_SIZE: usize = 512;
const NUM_BINS: usize = FFT_SIZE / 2;
// AnalyserNode defaults: minDecibels -100, maxDecibels -30.
const MIN_DB: f32 = -100.0;
const MAX_DB: f32 = -30.0;
const ANALYSIS_INTERVAL: Duration = Duration::from_millis(16);

const BAND_LOW: (f32, f32) = (20.0, 250.0);
const BAND_MID: (f32, f32) = (250.0, 2000.0);
const BAND_HIGH: (f32, f32) = (2000.0, 8000.0);
const BAND_LEVEL: (f32, f32) = (20.0, 16000.0);

// Beat detection (multi-band spectral flux). Tuned for the 16 ms analysis tick.
const FLUX_WINDOW: usize = 43; // ~0.7 s of flux history for the adaptive median
const FLUX_FLOOR: f32 = 0.008; // absolute floor so near-silence can't trigger
const ONSET_DEBOUNCE_MS: f64 = 110.0; // ignore retriggers within one transient
const IOI_MIN_S: f32 = 0.27; // 220 BPM — fastest accepted inter-onset interval
const IOI_MAX_S: f32 = 1.5; //  40 BPM — slowest accepted inter-onset interval
const IOI_HISTORY: usize = 8; // inter-onset intervals kept for the tempo estimate
const BPM_FOLD_LO: f32 = 80.0; // octave-fold detected tempo into [80, 180)
const BPM_FOLD_HI: f32 = 180.0;

/// Sentinel device id for the synthetic "Computer audio" entry — capture the
/// machine's own output. Resolved per-OS in `resolve_target`: WASAPI loopback
/// on Windows, the PipeWire/PulseAudio monitor source on Linux, a virtual
/// loopback device (BlackHole etc.) on macOS.
const SYSTEM_ID: &str = "@system";

#[derive(serde::Serialize, Clone)]
pub struct AudioDevice {
    pub id: String,
    pub label: String,
}

/// Raw audio drivers shared with the render thread: `[low, mid, high, level,
/// beat]`. The first four are band averages 0..1 — the render thread applies
/// the 1.4 gain and per-frame 0.15 lerp itself. `beat` (index 4) is the already
/// shaped onset envelope and is passed through **un-smoothed** on both sides.
pub type RawLevels = Arc<Mutex<[f32; 5]>>;

/// Beat-detector tuning, mutated live from the UI via `audio_set_beat_config`.
#[derive(Clone, Copy)]
pub struct BeatConfig {
    /// Scales the adaptive onset threshold (higher = fewer beats). 0.5..3.0.
    pub sensitivity: f32,
    /// Per-tick fall of the beat envelope (higher = tighter flash). 0.02..0.5.
    pub decay: f32,
}

impl Default for BeatConfig {
    fn default() -> Self {
        Self {
            sensitivity: 1.4,
            decay: 0.12,
        }
    }
}

impl BeatConfig {
    /// Copy the values out so the mutex is released before the per-tick work.
    fn clone_values(&self) -> Self {
        *self
    }
}

/// Shared handle to the live beat config.
pub type BeatCfg = Arc<Mutex<BeatConfig>>;

/// Raw band averages 0..1 plus beat/tempo — emitted to the webview for the UI
/// meters and the BPM-sync path.
#[derive(serde::Serialize, Clone)]
struct AudioLevels {
    low: f32,
    mid: f32,
    high: f32,
    level: f32,
    /// Onset envelope 0..1 (snaps to 1 on a beat, decays). Not smoothed downstream.
    beat: f32,
    /// Detected tempo; 0 until enough onsets have accumulated.
    bpm: f32,
    /// True when the recent inter-onset intervals are consistent enough to trust.
    #[serde(rename = "bpmStable")]
    bpm_stable: bool,
}

/// Per-band spectral-flux onset detector with an inter-onset-interval tempo
/// estimate. Lives on the analysis thread; one instance per capture session.
struct BeatDetector {
    prev_bins: [f32; NUM_BINS],
    /// Recent normalized flux per detection band (low, mid, high).
    flux_hist: [VecDeque<f32>; 3],
    prev_flux: [f32; 3],
    envelope: f32,
    last_onset_ms: f64,
    /// Inter-onset intervals in seconds, newest last.
    ioi: VecDeque<f32>,
    bpm: f32,
}

impl BeatDetector {
    fn new() -> Self {
        Self {
            prev_bins: [0.0; NUM_BINS],
            flux_hist: [VecDeque::new(), VecDeque::new(), VecDeque::new()],
            prev_flux: [0.0; 3],
            envelope: 0.0,
            last_onset_ms: 0.0,
            ioi: VecDeque::new(),
            bpm: 0.0,
        }
    }

    /// Advance one analysis tick. `now_ms` is the elapsed capture time.
    fn process(&mut self, bins: &[f32; NUM_BINS], sample_rate: u32, cfg: &BeatConfig, now_ms: f64) {
        let ranges = [
            band_range(sample_rate, BAND_LOW.0, BAND_LOW.1),
            band_range(sample_rate, BAND_MID.0, BAND_MID.1),
            band_range(sample_rate, BAND_HIGH.0, BAND_HIGH.1),
        ];

        // Positive spectral flux per band, normalized by bin count so the bands
        // (and a single threshold floor) are comparable despite differing widths.
        let mut onset = false;
        for (b, &(start, end)) in ranges.iter().enumerate() {
            let mut sum = 0.0f32;
            for (cur, prev) in bins[start..=end].iter().zip(&self.prev_bins[start..=end]) {
                let d = cur - prev;
                if d > 0.0 {
                    sum += d;
                }
            }
            let flux = sum / (end - start + 1).max(1) as f32;
            let threshold = median(&self.flux_hist[b]) * cfg.sensitivity + FLUX_FLOOR;
            // A rising flux above the adaptive threshold is an onset in this band.
            if flux > threshold && flux > self.prev_flux[b] {
                onset = true;
            }
            self.prev_flux[b] = flux;
            self.flux_hist[b].push_back(flux);
            if self.flux_hist[b].len() > FLUX_WINDOW {
                self.flux_hist[b].pop_front();
            }
        }
        self.prev_bins.copy_from_slice(bins);

        // Envelope decays every tick; an accepted onset snaps it back to 1.
        self.envelope = (self.envelope - cfg.decay).max(0.0);
        if onset && now_ms - self.last_onset_ms > ONSET_DEBOUNCE_MS {
            if self.last_onset_ms > 0.0 {
                let ioi = ((now_ms - self.last_onset_ms) / 1000.0) as f32;
                if (IOI_MIN_S..=IOI_MAX_S).contains(&ioi) {
                    self.ioi.push_back(ioi);
                    if self.ioi.len() > IOI_HISTORY {
                        self.ioi.pop_front();
                    }
                    self.update_bpm();
                }
            }
            self.last_onset_ms = now_ms;
            self.envelope = 1.0;
        }
    }

    /// Re-estimate tempo from the median inter-onset interval, octave-folded into
    /// a musical range and smoothed to damp jitter.
    fn update_bpm(&mut self) {
        let med = median(&self.ioi);
        if med <= 0.0 {
            return;
        }
        let mut candidate = 60.0 / med;
        while candidate < BPM_FOLD_LO {
            candidate *= 2.0;
        }
        while candidate >= BPM_FOLD_HI {
            candidate /= 2.0;
        }
        if self.bpm <= 0.0 {
            self.bpm = candidate;
        } else {
            self.bpm += (candidate - self.bpm) * 0.1;
        }
    }

    /// Tempo is trustworthy once several recent intervals agree closely.
    fn bpm_stable(&self) -> bool {
        if self.ioi.len() < 4 {
            return false;
        }
        let mean = self.ioi.iter().sum::<f32>() / self.ioi.len() as f32;
        if mean <= 0.0 {
            return false;
        }
        let var = self
            .ioi
            .iter()
            .map(|x| (x - mean) * (x - mean))
            .sum::<f32>()
            / self.ioi.len() as f32;
        var.sqrt() / mean < 0.1
    }
}

/// Median of a small sample (used for the adaptive flux threshold and tempo).
fn median(vals: &VecDeque<f32>) -> f32 {
    if vals.is_empty() {
        return 0.0;
    }
    let mut v: Vec<f32> = vals.iter().copied().collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// Circular buffer of the most recent FFT_SIZE mono samples.
struct Ring {
    samples: [f32; FFT_SIZE],
    pos: usize,
}

impl Default for Ring {
    fn default() -> Self {
        Self {
            samples: [0.0; FFT_SIZE],
            pos: 0,
        }
    }
}

impl Ring {
    fn push(&mut self, sample: f32) {
        self.samples[self.pos] = sample;
        self.pos = (self.pos + 1) % FFT_SIZE;
    }

    /// Oldest-to-newest copy of the buffer.
    fn snapshot(&self) -> [f32; FFT_SIZE] {
        let mut out = [0.0; FFT_SIZE];
        let tail = FFT_SIZE - self.pos;
        out[..tail].copy_from_slice(&self.samples[self.pos..]);
        out[tail..].copy_from_slice(&self.samples[..self.pos]);
        out
    }
}

struct Capture {
    running: Arc<AtomicBool>,
    /// Dropping this unblocks the stream thread's recv(), letting it drop the stream.
    stop_tx: mpsc::Sender<()>,
    stream_thread: JoinHandle<()>,
    analysis_thread: JoinHandle<()>,
}

#[derive(Default)]
pub struct AudioState {
    capture: Mutex<Option<Capture>>,
    /// Latest raw audio drivers, read in-process by the render thread.
    raw: RawLevels,
    /// Live beat-detector tuning, shared with the analysis thread.
    beat_config: BeatCfg,
}

impl AudioState {
    /// Handle for the render thread; zeroed whenever capture stops, so deck
    /// audio reactivity decays to silence through the render-side lerp.
    pub fn raw_levels(&self) -> RawLevels {
        Arc::clone(&self.raw)
    }

    /// Shared beat config, cloned into the analysis thread on capture start.
    pub fn beat_config(&self) -> BeatCfg {
        Arc::clone(&self.beat_config)
    }

    pub fn stop(&self) {
        let capture = lock_ignore_poison(&self.capture).take();
        if let Some(capture) = capture {
            capture.running.store(false, Ordering::SeqCst);
            drop(capture.stop_tx);
            let _ = capture.stream_thread.join();
            let _ = capture.analysis_thread.join();
        }
        *lock_ignore_poison(&self.raw) = [0.0; 5];
    }
}

fn lock_ignore_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn audio_list_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let inputs = host.input_devices().map_err(|e| e.to_string())?;
    // "Computer audio" first, then the real capture devices. cpal has no stable
    // device IDs, so a name doubles as the ID.
    let mut devices = vec![system_entry(&host)];
    devices.extend(
        inputs
            .filter_map(|d| d.name().ok())
            .map(|name| AudioDevice {
                id: name.clone(),
                label: name,
            }),
    );
    Ok(devices)
}

#[tauri::command]
pub fn audio_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioState>,
    device_id: Option<String>,
) -> Result<(), String> {
    state.stop();

    let ring = Arc::new(Mutex::new(Ring::default()));
    let running = Arc::new(AtomicBool::new(true));
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

    // cpal::Stream is !Send on some platforms, so it must live entirely on one thread.
    let stream_thread = {
        let ring = Arc::clone(&ring);
        std::thread::spawn(move || run_stream_thread(device_id, ring, ready_tx, stop_rx))
    };

    let sample_rate = match ready_rx.recv() {
        Ok(Ok(rate)) => rate,
        Ok(Err(err)) => {
            let _ = stream_thread.join();
            return Err(err);
        }
        Err(_) => {
            let _ = stream_thread.join();
            return Err("audio stream thread exited unexpectedly".into());
        }
    };

    let analysis_thread = {
        let ring = Arc::clone(&ring);
        let running = Arc::clone(&running);
        let raw = state.raw_levels();
        let beat_config = state.beat_config();
        std::thread::spawn(move || {
            run_analysis_loop(app, ring, running, raw, beat_config, sample_rate)
        })
    };

    *lock_ignore_poison(&state.capture) = Some(Capture {
        running,
        stop_tx,
        stream_thread,
        analysis_thread,
    });
    Ok(())
}

#[tauri::command]
pub fn audio_stop(state: tauri::State<'_, AudioState>) {
    state.stop();
}

/// Live-tune the beat detector. Safe to call whether or not capture is running;
/// the analysis loop reads this every tick.
#[tauri::command]
pub fn audio_set_beat_config(state: tauri::State<'_, AudioState>, sensitivity: f32, decay: f32) {
    let mut cfg = lock_ignore_poison(&state.beat_config);
    cfg.sensitivity = sensitivity.clamp(0.5, 3.0);
    cfg.decay = decay.clamp(0.02, 0.5);
}

fn run_stream_thread(
    device_id: Option<String>,
    ring: Arc<Mutex<Ring>>,
    ready_tx: mpsc::Sender<Result<u32, String>>,
    stop_rx: mpsc::Receiver<()>,
) {
    match build_stream(device_id, ring) {
        Ok((stream, sample_rate)) => {
            let _ = ready_tx.send(Ok(sample_rate));
            // Blocks until AudioState::stop drops the sender.
            let _ = stop_rx.recv();
            drop(stream);
        }
        Err(err) => {
            let _ = ready_tx.send(Err(err));
        }
    }
}

/// What to open and how to configure it.
enum CaptureTarget {
    /// A normal capture device — opened with its default input config.
    Input(cpal::Device),
    /// A render endpoint opened in loopback. cpal's WASAPI backend sets the
    /// loopback flag automatically when an input stream is built on an output
    /// device, so it's configured with the output (render mix) format.
    #[allow(dead_code)] // only constructed on Windows
    Loopback(cpal::Device),
}

/// Resolve a UI device id to a concrete device plus the config to open it with.
fn resolve_target(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let target = match device_id {
        Some(SYSTEM_ID) => resolve_system(host)?,
        Some(id) => CaptureTarget::Input(
            host.input_devices()
                .map_err(|e| e.to_string())?
                .find(|d| d.name().map(|n| n == id).unwrap_or(false))
                .or_else(|| host.default_input_device())
                .ok_or_else(|| "no audio input device available".to_string())?,
        ),
        None => CaptureTarget::Input(
            host.default_input_device()
                .ok_or_else(|| "no audio input device available".to_string())?,
        ),
    };
    match target {
        CaptureTarget::Input(d) => {
            let c = d.default_input_config().map_err(|e| e.to_string())?;
            Ok((d, c))
        }
        CaptureTarget::Loopback(d) => {
            let c = d.default_output_config().map_err(|e| e.to_string())?;
            Ok((d, c))
        }
    }
}

/// Windows: loopback-capture the default output (WASAPI sets the loopback flag).
#[cfg(target_os = "windows")]
fn resolve_system(host: &cpal::Host) -> Result<CaptureTarget, String> {
    host.default_output_device()
        .map(CaptureTarget::Loopback)
        .ok_or_else(|| "no output device available to capture".to_string())
}

/// macOS: CoreAudio has no native loopback, so route to a virtual loopback
/// device (BlackHole / Loopback / an Aggregate) if the user has one installed.
#[cfg(target_os = "macos")]
fn resolve_system(host: &cpal::Host) -> Result<CaptureTarget, String> {
    host.input_devices()
        .map_err(|e| e.to_string())?
        .find(|d| d.name().map(|n| is_mac_loopback(&n)).unwrap_or(false))
        .map(CaptureTarget::Input)
        .ok_or_else(|| {
            "No loopback device found. Install BlackHole (free) — or use a Loopback/Aggregate \
             device — to capture computer audio on macOS."
                .to_string()
        })
}

/// macOS virtual loopback devices appear as ordinary capture devices; match the
/// common ones by name.
#[cfg(target_os = "macos")]
fn is_mac_loopback(name: &str) -> bool {
    let n = name.to_lowercase();
    [
        "blackhole",
        "loopback",
        "soundflower",
        "aggregate",
        "multi-output",
        "vb-audio",
        "vb-cable",
    ]
    .iter()
    .any(|k| n.contains(k))
}

/// Linux/other: PipeWire & PulseAudio expose each output's monitor as a capture
/// source, so the system mix is just another input device.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn resolve_system(host: &cpal::Host) -> Result<CaptureTarget, String> {
    host.input_devices()
        .map_err(|e| e.to_string())?
        .find(|d| {
            d.name()
                .map(|n| n.to_lowercase().contains("monitor"))
                .unwrap_or(false)
        })
        .map(CaptureTarget::Input)
        .ok_or_else(|| {
            "No monitor source found. Enable a PipeWire/PulseAudio monitor for your output \
             to capture computer audio."
                .to_string()
        })
}

/// The synthetic "Computer audio" entry. The label carries a short hint when
/// system capture isn't available on this machine, so the dropdown itself tells
/// the user what to do.
fn system_entry(host: &cpal::Host) -> AudioDevice {
    let label = if resolve_system(host).is_ok() {
        "Computer audio"
    } else if cfg!(target_os = "macos") {
        "Computer audio (install BlackHole)"
    } else if cfg!(target_os = "windows") {
        "Computer audio (unavailable)"
    } else {
        "Computer audio (enable a monitor source)"
    };
    AudioDevice {
        id: SYSTEM_ID.to_string(),
        label: label.to_string(),
    }
}

fn build_stream(
    device_id: Option<String>,
    ring: Arc<Mutex<Ring>>,
) -> Result<(cpal::Stream, u32), String> {
    let host = cpal::default_host();
    let (device, config) = resolve_target(&host, device_id.as_deref())?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let stream_config: cpal::StreamConfig = config.config();
    let err_fn = |err: cpal::StreamError| eprintln!("vizzy audio stream error: {err}");

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            build_input::<f32>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::F64 => {
            build_input::<f64>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::I8 => {
            build_input::<i8>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::I16 => {
            build_input::<i16>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::I32 => {
            build_input::<i32>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::I64 => {
            build_input::<i64>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::U8 => {
            build_input::<u8>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::U16 => {
            build_input::<u16>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::U32 => {
            build_input::<u32>(&device, &stream_config, channels, ring, err_fn)
        }
        cpal::SampleFormat::U64 => {
            build_input::<u64>(&device, &stream_config, channels, ring, err_fn)
        }
        other => return Err(format!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, sample_rate))
}

fn build_input<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    ring: Arc<Mutex<Ring>>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    let channels = channels.max(1);
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            let mut ring = lock_ignore_poison(&ring);
            for frame in data.chunks(channels) {
                let sum: f32 = frame.iter().map(|s| f32::from_sample(*s)).sum();
                ring.push(sum / frame.len() as f32);
            }
        },
        err_fn,
        None,
    )
}

fn run_analysis_loop(
    app: tauri::AppHandle,
    ring: Arc<Mutex<Ring>>,
    running: Arc<AtomicBool>,
    raw: RawLevels,
    beat_config: BeatCfg,
    sample_rate: u32,
) {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE).map(|n| blackman(n, FFT_SIZE)).collect();
    let mut buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];
    let mut bins = [0.0f32; NUM_BINS];
    let mut detector = BeatDetector::new();
    // Wall-clock onset timing — sleep drift would bias inter-onset intervals.
    let started = Instant::now();

    while running.load(Ordering::SeqCst) {
        std::thread::sleep(ANALYSIS_INTERVAL);
        let samples = lock_ignore_poison(&ring).snapshot();
        for (i, (&s, &w)) in samples.iter().zip(window.iter()).enumerate() {
            buf[i] = Complex::new(s * w, 0.0);
        }
        fft.process(&mut buf);
        for (i, bin) in bins.iter_mut().enumerate() {
            // getByteFrequencyData: |X[k]|/N -> dB -> map through [minDecibels, maxDecibels].
            let mag = buf[i].norm() / FFT_SIZE as f32;
            *bin = normalize_db(20.0 * mag.log10());
        }

        let now_ms = started.elapsed().as_secs_f64() * 1000.0;
        let cfg = lock_ignore_poison(&beat_config).clone_values();
        detector.process(&bins, sample_rate, &cfg, now_ms);

        let payload = AudioLevels {
            low: band_average(&bins, sample_rate, BAND_LOW.0, BAND_LOW.1),
            mid: band_average(&bins, sample_rate, BAND_MID.0, BAND_MID.1),
            high: band_average(&bins, sample_rate, BAND_HIGH.0, BAND_HIGH.1),
            level: band_average(&bins, sample_rate, BAND_LEVEL.0, BAND_LEVEL.1),
            beat: detector.envelope,
            bpm: detector.bpm,
            bpm_stable: detector.bpm_stable(),
        };
        // render thread reads in-process; the event feeds the UI meters + BPM sync.
        // `bpm` is intentionally omitted from `raw`: the looper gets BPM from the
        // frontend, so the render thread never needs the detected value.
        *lock_ignore_poison(&raw) = [
            payload.low,
            payload.mid,
            payload.high,
            payload.level,
            payload.beat,
        ];
        let _ = app.emit("vizzy://audio-levels", payload);
    }
}

/// Blackman window as specified for AnalyserNode (note: divides by N, not N-1).
fn blackman(n: usize, size: usize) -> f32 {
    let x = std::f32::consts::TAU * n as f32 / size as f32;
    0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos()
}

// not f32::clamp: a NaN magnitude must normalize to silence (0), not propagate
#[allow(clippy::manual_clamp)]
fn normalize_db(db: f32) -> f32 {
    ((db - MIN_DB) / (MAX_DB - MIN_DB)).max(0.0).min(1.0)
}

/// Inclusive bin range for a frequency band, mirroring AudioEngine.bandAverage.
fn band_range(sample_rate: u32, from_hz: f32, to_hz: f32) -> (usize, usize) {
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let start = (from_hz / bin_hz).floor().max(0.0) as usize;
    let end = (((to_hz / bin_hz).ceil()) as usize).min(NUM_BINS - 1);
    (start, end)
}

fn band_average(bins: &[f32; NUM_BINS], sample_rate: u32, from_hz: f32, to_hz: f32) -> f32 {
    let (start, end) = band_range(sample_rate, from_hz, to_hz);
    if start > end {
        return 0.0;
    }
    let count = (end - start + 1) as f32;
    bins[start..=end].iter().sum::<f32>() / count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blackman_endpoints() {
        // n=0: 0.42 - 0.5 + 0.08 = 0
        assert!(blackman(0, FFT_SIZE).abs() < 1e-6);
        // n=N/2: 0.42 + 0.5 + 0.08 = 1
        assert!((blackman(FFT_SIZE / 2, FFT_SIZE) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn band_ranges_at_48k() {
        // binHz = 48000 / 512 = 93.75
        assert_eq!(band_range(48000, 20.0, 250.0), (0, 3));
        assert_eq!(band_range(48000, 250.0, 2000.0), (2, 22));
        assert_eq!(band_range(48000, 2000.0, 8000.0), (21, 86));
        assert_eq!(band_range(48000, 20.0, 16000.0), (0, 171));
    }

    #[test]
    fn band_average_empty_range_is_zero() {
        let bins = [1.0f32; NUM_BINS];
        // 30 kHz at 48 kHz: start bin 320 > clamped end bin 255 -> empty -> 0.
        assert_eq!(band_average(&bins, 48000, 30000.0, 40000.0), 0.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detects_mac_loopback_devices() {
        assert!(is_mac_loopback("BlackHole 2ch"));
        assert!(is_mac_loopback("Loopback Audio"));
        assert!(is_mac_loopback("My Aggregate Device"));
        assert!(!is_mac_loopback("MacBook Pro Microphone"));
        assert!(!is_mac_loopback("External Headphones"));
    }

    #[test]
    fn db_normalization_clamps() {
        assert_eq!(normalize_db(-100.0), 0.0);
        assert_eq!(normalize_db(-30.0), 1.0);
        assert_eq!(normalize_db(-200.0), 0.0);
        assert_eq!(normalize_db(0.0), 1.0);
        assert!((normalize_db(-65.0) - 0.5).abs() < 1e-6);
        // Silence: mag 0 -> -inf dB -> clamps to 0 rather than NaN.
        assert_eq!(normalize_db(f32::NEG_INFINITY), 0.0);
    }
}
