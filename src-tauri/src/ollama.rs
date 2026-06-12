// Managed Ollama runtime: download the platform binary into app data on
// request, run `ollama serve` on a private port, and kill it with the app.
// If the user already runs their own Ollama on 11434 the frontend prefers
// that and none of this activates. Direct port of electron/ollama-manager.cjs.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::json;
use tauri::{Emitter, Manager};

// Off the default 11434 so we never fight a user-installed Ollama.
const MANAGED_PORT: u16 = 11435;

// Node's process.platform values — the UI branches on these.
#[cfg(target_os = "macos")]
const PLATFORM: &str = "darwin";
#[cfg(target_os = "windows")]
const PLATFORM: &str = "win32";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const PLATFORM: &str = "linux";

const ARCH: &str = if cfg!(target_arch = "aarch64") {
    "arm64"
} else {
    "amd64"
};

const BIN_NAME: &str = if cfg!(windows) {
    "ollama.exe"
} else {
    "ollama"
};

// Some archives nest the binary (e.g. bin/ollama) — surface it.
const NESTED_BIN_CANDIDATES: [&str; 3] = ["bin/ollama", "ollama/ollama", "bin/ollama.exe"];

const PROGRESS_EVENT: &str = "vizzy://ollama-progress";

fn asset_name_for(platform: &str, arch: &str) -> String {
    match platform {
        "darwin" => "ollama-darwin.tgz".into(), // universal
        "win32" => format!("ollama-windows-{arch}.zip"),
        _ => format!("ollama-linux-{arch}.tgz"),
    }
}

fn asset_name() -> String {
    asset_name_for(PLATFORM, ARCH)
}

fn download_url() -> String {
    format!(
        "https://github.com/ollama/ollama/releases/latest/download/{}",
        asset_name()
    )
}

fn runtime_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ollama-runtime"))
}

fn bin_path(dir: &Path) -> PathBuf {
    dir.join(BIN_NAME)
}

/// True if the slot holds a live child; reaps and clears it otherwise.
fn child_alive(slot: &mut Option<Child>) -> bool {
    match slot.as_mut().map(Child::try_wait) {
        Some(Ok(None)) => true,
        Some(_) => {
            *slot = None;
            false
        }
        None => false,
    }
}

#[derive(Default)]
pub struct OllamaState {
    child: Mutex<Option<Child>>,
}

impl OllamaState {
    pub fn stop(&self) {
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub managed_port: u16,
    pub platform: &'static str,
}

#[tauri::command]
pub fn ollama_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    let installed = bin_path(&runtime_dir(&app)?).exists();
    let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
    Ok(OllamaStatus {
        installed,
        running: child_alive(&mut guard),
        managed_port: MANAGED_PORT,
        platform: PLATFORM,
    })
}

#[tauri::command]
pub async fn ollama_install(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = runtime_dir(&app)?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let archive = dir.join(asset_name());

    let res = reqwest::get(download_url())
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Download failed: HTTP {}", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);

    {
        use std::io::Write;
        let mut file = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
        let mut received: u64 = 0;
        let mut last_sent: Option<Instant> = None;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            if last_sent.is_none_or(|t| t.elapsed() > Duration::from_millis(200)) {
                last_sent = Some(Instant::now());
                let _ = app.emit(
                    PROGRESS_EVENT,
                    json!({ "phase": "download", "received": received, "total": total }),
                );
            }
        }
    }
    let _ = app.emit(PROGRESS_EVENT, json!({ "phase": "extract" }));

    // tar handles .tgz everywhere; Windows 10+ bsdtar also unpacks .zip
    let status = Command::new("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("tar exited with {:?}", status.code()));
    }
    let _ = std::fs::remove_file(&archive);

    let bin = bin_path(&dir);
    if !bin.exists() {
        let nested = NESTED_BIN_CANDIDATES
            .iter()
            .map(|p| dir.join(p))
            .find(|p| p.exists())
            .ok_or_else(|| "Ollama binary not found after extraction".to_string())?;
        std::fs::rename(&nested, &bin).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(true)
}

#[tauri::command]
pub async fn ollama_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, OllamaState>,
) -> Result<bool, String> {
    {
        let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
        if child_alive(&mut guard) {
            return Ok(true);
        }
    }
    let dir = runtime_dir(&app)?;
    let bin = bin_path(&dir);
    if !bin.exists() {
        return Ok(false);
    }

    let child = Command::new(&bin)
        .arg("serve")
        .env("OLLAMA_HOST", format!("127.0.0.1:{MANAGED_PORT}"))
        // models live alongside the runtime so uninstalling = deleting app data
        .env("OLLAMA_MODELS", dir.join("models"))
        // The Tauri webview origin isn't http://localhost (unlike Electron's
        // dev server), so the managed server must accept any origin or every
        // frontend fetch fails CORS.
        .env("OLLAMA_ORIGINS", "*")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(child);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{MANAGED_PORT}/api/version");
    for _ in 0..60 {
        if matches!(client.get(&url).send().await, Ok(r) if r.status().is_success()) {
            return Ok(true);
        }
        sleep_ms(500).await;
    }
    Ok(false)
}

// tokio isn't a direct dependency, so park a blocking-pool thread instead of
// reaching for tokio::time::sleep.
async fn sleep_ms(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(ms));
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_match_release_assets() {
        assert_eq!(asset_name_for("darwin", "arm64"), "ollama-darwin.tgz");
        assert_eq!(asset_name_for("darwin", "amd64"), "ollama-darwin.tgz");
        assert_eq!(asset_name_for("win32", "amd64"), "ollama-windows-amd64.zip");
        assert_eq!(asset_name_for("win32", "arm64"), "ollama-windows-arm64.zip");
        assert_eq!(asset_name_for("linux", "amd64"), "ollama-linux-amd64.tgz");
        assert_eq!(asset_name_for("linux", "arm64"), "ollama-linux-arm64.tgz");
    }

    #[test]
    fn nested_candidates_match_cjs_list() {
        assert_eq!(
            NESTED_BIN_CANDIDATES,
            ["bin/ollama", "ollama/ollama", "bin/ollama.exe"]
        );
    }
}
