// Managed Ollama runtime: download the platform binary into userData on
// request, run `ollama serve` on a private port, and kill it with the app.
// If the user already runs their own Ollama on 11434 the renderer prefers
// that and none of this activates.
const { app, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

// Off the default 11434 so we never fight a user-installed Ollama.
const MANAGED_PORT = 11435;
const MANAGED_HOST = `127.0.0.1:${MANAGED_PORT}`;

let child = null;

function runtimeDir() {
  return path.join(app.getPath('userData'), 'ollama-runtime');
}

function binPath() {
  const dir = runtimeDir();
  return process.platform === 'win32'
    ? path.join(dir, 'ollama.exe')
    : path.join(dir, 'ollama');
}

function assetName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'darwin') return 'ollama-darwin.tgz'; // universal
  if (process.platform === 'win32') return `ollama-windows-${arch}.zip`;
  return `ollama-linux-${arch}.tgz`;
}

function downloadUrl() {
  return `https://github.com/ollama/ollama/releases/latest/download/${assetName()}`;
}

async function serverAlive(base) {
  try {
    const res = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function downloadAndExtract(sender) {
  const dir = runtimeDir();
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const archive = path.join(dir, assetName());

  const res = await fetch(downloadUrl(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;

  let received = 0;
  let lastSent = 0;
  const file = fs.createWriteStream(archive);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    await new Promise((resolve, reject) =>
      file.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())),
    );
    if (Date.now() - lastSent > 200) {
      lastSent = Date.now();
      sender.send('vizzy:ollama-progress', { phase: 'download', received, total });
    }
  }
  await new Promise((resolve) => file.end(resolve));
  sender.send('vizzy:ollama-progress', { phase: 'extract' });

  // tar handles .tgz everywhere; Windows 10+ bsdtar also unpacks .zip
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', archive, '-C', dir], { stdio: 'ignore' });
    tar.on('error', reject);
    tar.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)),
    );
  });
  await fsp.rm(archive, { force: true });

  // Some archives nest the binary (e.g. bin/ollama) — surface it.
  if (!fs.existsSync(binPath())) {
    const nested = ['bin/ollama', 'ollama/ollama', 'bin/ollama.exe'].find((p) =>
      fs.existsSync(path.join(dir, p)),
    );
    if (!nested) throw new Error('Ollama binary not found after extraction');
    await fsp.rename(path.join(dir, nested), binPath());
  }
  if (process.platform !== 'win32') await fsp.chmod(binPath(), 0o755);
}

async function startManaged() {
  if (child && child.exitCode === null) return true;
  if (!fs.existsSync(binPath())) return false;

  child = spawn(binPath(), ['serve'], {
    env: {
      ...process.env,
      OLLAMA_HOST: MANAGED_HOST,
      // models live alongside the runtime so uninstalling = deleting userData
      OLLAMA_MODELS: path.join(runtimeDir(), 'models'),
    },
    stdio: 'ignore',
  });
  child.on('exit', (code) => {
    console.log(`[Vizzy] Managed Ollama exited (${code})`);
    child = null;
  });

  const base = `http://${MANAGED_HOST}`;
  for (let i = 0; i < 60; i += 1) {
    if (await serverAlive(base)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function stopManaged() {
  if (child && child.exitCode === null) child.kill();
  child = null;
}

function registerOllamaIpc() {
  ipcMain.handle('vizzy:ollama-status', () => ({
    installed: fs.existsSync(binPath()),
    running: Boolean(child && child.exitCode === null),
    managedPort: MANAGED_PORT,
    platform: process.platform,
  }));

  ipcMain.handle('vizzy:ollama-install', async (event) => {
    await downloadAndExtract(event.sender);
    return true;
  });

  ipcMain.handle('vizzy:ollama-start', () => startManaged());

  app.on('will-quit', stopManaged);
}

module.exports = { registerOllamaIpc, MANAGED_PORT };
