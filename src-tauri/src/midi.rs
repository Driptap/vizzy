use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use midir::{Ignore, MidiInput, MidiInputConnection};
use serde::Serialize;
use tauri::Emitter;

const MIDI_MESSAGE_EVENT: &str = "vizzy://midi-message";
const PORTS_CHANGED_EVENT: &str = "vizzy://midi-ports-changed";
const WATCH_INTERVAL: Duration = Duration::from_secs(2);
const STOP_POLL: Duration = Duration::from_millis(100);

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct MidiMessage {
    status: u8,
    data1: u8,
    data2: u8,
}

#[derive(Serialize, Clone)]
struct PortsChanged {
    count: usize,
}

/// Build an event payload from a raw MIDI byte slice; missing data bytes default to 0.
fn payload_from(bytes: &[u8]) -> Option<MidiMessage> {
    Some(MidiMessage {
        status: *bytes.first()?,
        data1: bytes.get(1).copied().unwrap_or(0),
        data2: bytes.get(2).copied().unwrap_or(0),
    })
}

struct Worker {
    stop: Arc<AtomicBool>,
    count: Arc<AtomicUsize>,
    handle: JoinHandle<()>,
}

impl Worker {
    fn shutdown(self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.handle.join();
    }
}

#[derive(Default)]
pub struct MidiState {
    worker: Mutex<Option<Worker>>,
}

fn current_port_names() -> BTreeSet<String> {
    match MidiInput::new("vizzy-watch") {
        Ok(probe) => probe
            .ports()
            .iter()
            .filter_map(|p| probe.port_name(p).ok())
            .collect(),
        Err(_) => BTreeSet::new(),
    }
}

/// Connect to every available input port. Returns the live connections plus the
/// set of port names seen at enumeration time (used by the watcher to detect
/// hot-plug changes; we record names even for ports that fail to connect so a
/// single bad port doesn't trigger a reconnect storm every poll).
fn connect_all(
    app: &tauri::AppHandle,
) -> Result<(Vec<MidiInputConnection<()>>, BTreeSet<String>), String> {
    let probe = MidiInput::new("vizzy-probe").map_err(|e| e.to_string())?;
    let mut conns = Vec::new();
    let mut names = BTreeSet::new();

    for port in probe.ports() {
        let name = probe.port_name(&port).ok();
        if let Some(n) = &name {
            names.insert(n.clone());
        }
        let display = name.unwrap_or_else(|| "vizzy-in".into());

        let mut input = match MidiInput::new("vizzy") {
            Ok(i) => i,
            Err(_) => continue,
        };
        input.ignore(Ignore::None);

        let app = app.clone();
        let callback = move |_ts: u64, bytes: &[u8], _: &mut ()| {
            if let Some(msg) = payload_from(bytes) {
                let _ = app.emit(MIDI_MESSAGE_EVENT, msg);
            }
        };
        // Port may vanish between enumeration and connect; skip it, the
        // watcher will pick up the change on its next poll.
        if let Ok(conn) = input.connect(&port, &display, callback, ()) {
            conns.push(conn);
        }
    }
    Ok((conns, names))
}

/// Owns all MIDI connections for its lifetime. midir's `MidiInputConnection`
/// is not `Send` on every platform, so the connections live entirely on this
/// thread and commands communicate via atomics + a one-shot ready channel.
/// midir also has no hot-plug callback (unlike Web MIDI's `statechange`), so
/// we poll the port-name set every 2 s and reconnect everything on change.
fn run_worker(
    app: tauri::AppHandle,
    stop: Arc<AtomicBool>,
    count: Arc<AtomicUsize>,
    ready: mpsc::Sender<Result<usize, String>>,
) {
    let (mut conns, mut known) = match connect_all(&app) {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    count.store(conns.len(), Ordering::SeqCst);
    let _ = ready.send(Ok(conns.len()));

    let mut elapsed = Duration::ZERO;
    while !stop.load(Ordering::SeqCst) {
        // Short sleeps so midi_stop never waits ~2 s for the join.
        std::thread::sleep(STOP_POLL);
        elapsed += STOP_POLL;
        if elapsed < WATCH_INTERVAL {
            continue;
        }
        elapsed = Duration::ZERO;

        if current_port_names() == known {
            continue;
        }
        drop(std::mem::take(&mut conns)); // release old handles before reconnecting
        (conns, known) = connect_all(&app).unwrap_or_default();
        count.store(conns.len(), Ordering::SeqCst);
        let _ = app.emit(PORTS_CHANGED_EVENT, PortsChanged { count: conns.len() });
    }

    drop(conns);
    count.store(0, Ordering::SeqCst);
}

#[tauri::command]
pub fn midi_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, MidiState>,
) -> Result<usize, String> {
    let mut guard = state.worker.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = guard.take() {
        old.shutdown();
    }

    let stop = Arc::new(AtomicBool::new(false));
    let count = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = mpsc::channel();

    let handle = {
        let (stop, count) = (stop.clone(), count.clone());
        std::thread::spawn(move || run_worker(app, stop, count, tx))
    };

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(n)) => {
            *guard = Some(Worker {
                stop,
                count,
                handle,
            });
            Ok(n)
        }
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            let _ = handle.join();
            Err("MIDI worker did not start in time".into())
        }
    }
}

#[tauri::command]
pub fn midi_stop(state: tauri::State<'_, MidiState>) {
    let mut guard = state.worker.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(worker) = guard.take() {
        worker.shutdown();
    }
}

#[tauri::command]
pub fn midi_input_count(state: tauri::State<'_, MidiState>) -> usize {
    state
        .worker
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|w| w.count.load(Ordering::SeqCst))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_from_empty_is_none() {
        assert_eq!(payload_from(&[]), None);
    }

    #[test]
    fn payload_from_full_cc_message() {
        assert_eq!(
            payload_from(&[0xb0, 21, 127]),
            Some(MidiMessage {
                status: 0xb0,
                data1: 21,
                data2: 127
            })
        );
    }

    #[test]
    fn payload_from_pads_missing_bytes_with_zero() {
        assert_eq!(
            payload_from(&[0xf8]),
            Some(MidiMessage {
                status: 0xf8,
                data1: 0,
                data2: 0
            })
        );
        assert_eq!(
            payload_from(&[0xc0, 5]),
            Some(MidiMessage {
                status: 0xc0,
                data1: 5,
                data2: 0
            })
        );
    }

    #[test]
    fn payload_from_ignores_extra_bytes() {
        assert_eq!(
            payload_from(&[0xb0, 1, 2, 3, 4]),
            Some(MidiMessage {
                status: 0xb0,
                data1: 1,
                data2: 2
            })
        );
    }
}
