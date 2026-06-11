// File-backed shader library: one JSON file per shader in <userData>/shaders/.
// window.require reaches Electron's node integration directly, bypassing the
// Vite bundler (these modules don't exist in a browser build).
const { ipcRenderer } = window.require('electron');
const fs = window.require('fs/promises');
const path = window.require('path');

let dirPromise = null;

function shadersDir() {
  if (!dirPromise) {
    dirPromise = ipcRenderer.invoke('promptvj:get-shaders-dir').then(async (dir) => {
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
  }
  return dirPromise;
}

async function writeEntry(entry) {
  const dir = await shadersDir();
  await fs.writeFile(path.join(dir, `${entry.id}.json`), JSON.stringify(entry));
}

/** @returns newest-first array of {id, name, code, screenshot, createdAt} */
export async function listShaders() {
  const dir = await shadersDir();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  const entries = await Promise.all(
    files.map(async (file) => {
      try {
        return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      } catch (err) {
        console.warn('[PromptVJ] Skipping unreadable library file:', file, err);
        return null;
      }
    }),
  );
  return entries.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveShader({ name = '', code, screenshot = null }) {
  const entry = {
    id: `shader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    code,
    screenshot,
    createdAt: Date.now(),
  };
  await writeEntry(entry);
  return entry;
}

export async function renameShader(entry, name) {
  const updated = { ...entry, name };
  await writeEntry(updated);
  return updated;
}

export async function deleteShader(id) {
  const dir = await shadersDir();
  await fs.unlink(path.join(dir, `${id}.json`)).catch(() => {});
}
