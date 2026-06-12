use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

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

#[derive(serde::Serialize, Clone)]
pub struct AudioDevice {
    pub id: String,
    pub label: String,
}

/// Raw band averages 0..1 — the TS side applies the 1.4 gain and per-frame lerp.
#[derive(serde::Serialize, Clone)]
struct AudioLevels {
    low: f32,
    mid: f32,
    high: f32,
    level: f32,
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
}

impl AudioState {
    pub fn stop(&self) {
        let capture = lock_ignore_poison(&self.capture).take();
        if let Some(capture) = capture {
            capture.running.store(false, Ordering::SeqCst);
            drop(capture.stop_tx);
            let _ = capture.stream_thread.join();
            let _ = capture.analysis_thread.join();
        }
    }
}

fn lock_ignore_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn audio_list_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let devices = host.input_devices().map_err(|e| e.to_string())?;
    // cpal has no stable device IDs, so the name doubles as the ID.
    Ok(devices
        .filter_map(|d| d.name().ok())
        .map(|name| AudioDevice {
            id: name.clone(),
            label: name,
        })
        .collect())
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
        std::thread::spawn(move || run_analysis_loop(app, ring, running, sample_rate))
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

fn build_stream(
    device_id: Option<String>,
    ring: Arc<Mutex<Ring>>,
) -> Result<(cpal::Stream, u32), String> {
    let host = cpal::default_host();
    let device = match device_id {
        Some(ref id) => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == *id).unwrap_or(false))
            .or_else(|| host.default_input_device()),
        None => host.default_input_device(),
    }
    .ok_or_else(|| "no audio input device available".to_string())?;

    let config = device.default_input_config().map_err(|e| e.to_string())?;
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
    sample_rate: u32,
) {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE).map(|n| blackman(n, FFT_SIZE)).collect();
    let mut buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];
    let mut bins = [0.0f32; NUM_BINS];

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

        let payload = AudioLevels {
            low: band_average(&bins, sample_rate, BAND_LOW.0, BAND_LOW.1),
            mid: band_average(&bins, sample_rate, BAND_MID.0, BAND_MID.1),
            high: band_average(&bins, sample_rate, BAND_HIGH.0, BAND_HIGH.1),
            level: band_average(&bins, sample_rate, BAND_LEVEL.0, BAND_LEVEL.1),
        };
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
