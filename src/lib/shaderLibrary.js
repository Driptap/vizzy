// File-backed shader library: one JSON file per shader in <userData>/shaders/.
// window.require reaches Electron's node integration directly, bypassing the
// Vite bundler (these modules don't exist in a browser build).
const { ipcRenderer, webUtils } = window.require('electron');
const fs = window.require('fs/promises');
const path = window.require('path');

let dirPromise = null;
let modelsDirPromise = null;

function shadersDir() {
  if (!dirPromise) {
    dirPromise = ipcRenderer.invoke('vizzy:get-shaders-dir').then(async (dir) => {
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
  }
  return dirPromise;
}

function modelsDir() {
  if (!modelsDirPromise) {
    modelsDirPromise = ipcRenderer.invoke('vizzy:get-models-dir').then(async (dir) => {
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
  }
  return modelsDirPromise;
}

let spritesDirPromise = null;

function spritesDir() {
  if (!spritesDirPromise) {
    spritesDirPromise = ipcRenderer.invoke('vizzy:get-sprites-dir').then(async (dir) => {
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
  }
  return spritesDirPromise;
}

// Absolute path of a dropped/picked File (File.path was removed in Electron)
export function filePathOf(file) {
  return webUtils.getPathForFile(file);
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
        console.warn('[Vizzy] Skipping unreadable library file:', file, err);
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

/**
 * A deck preset: a whole scene's 4 channels. Each channel references a saved
 * shader by id and carries the channel config (opacity, mute, scale, size,
 * fx, prompt). Stored in the same folder, distinguished by kind: 'deck'.
 */
export async function saveDeck({ name = '', channels, screenshot = null }) {
  const entry = {
    id: `deck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'deck',
    name,
    channels,
    screenshot,
    createdAt: Date.now(),
  };
  await writeEntry(entry);
  return entry;
}

/**
 * A model entry: the source file is COPIED into <userData>/models/ so the
 * library owns its assets; the JSON entry (kind: 'model') references it.
 */
export async function saveModel({ sourcePath, name = '' }) {
  const dir = await modelsDir();
  const ext = path.extname(sourcePath).toLowerCase();
  const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}${ext}`;
  await fs.copyFile(sourcePath, path.join(dir, file));
  const entry = { id, kind: 'model', name, file, screenshot: null, createdAt: Date.now() };
  await writeEntry(entry);
  return entry;
}

export async function getModelFilePath(entry) {
  const dir = await modelsDir();
  return path.join(dir, entry.file);
}

/** A sprite entry: an image file copied into <userData>/sprites/. */
export async function saveSprite({ sourcePath, name = '', screenshot = null }) {
  const dir = await spritesDir();
  const ext = path.extname(sourcePath).toLowerCase();
  const id = `sprite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}${ext}`;
  await fs.copyFile(sourcePath, path.join(dir, file));
  const entry = { id, kind: 'sprite', name, file, screenshot, createdAt: Date.now() };
  await writeEntry(entry);
  return entry;
}

export async function getSpriteFilePath(entry) {
  const dir = await spritesDir();
  return path.join(dir, entry.file);
}

/** Model/sprite entry from in-memory bytes (used by the first-run seeder). */
export async function saveAssetFromBuffer({ kind, name = '', bytes, ext, screenshot = null }) {
  const dir = kind === 'model' ? await modelsDir() : await spritesDir();
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}${ext}`;
  await fs.writeFile(path.join(dir, file), bytes);
  const entry = { id, kind, name, file, screenshot, createdAt: Date.now() };
  await writeEntry(entry);
  return entry;
}

export async function renameShader(entry, name) {
  const updated = { ...entry, name };
  await writeEntry(updated);
  return updated;
}

export async function updateEntry(entry) {
  await writeEntry(entry);
  return entry;
}

export async function deleteEntry(entry) {
  const dir = await shadersDir();
  await fs.unlink(path.join(dir, `${entry.id}.json`)).catch(() => {});
  if (entry.file && (entry.kind === 'model' || entry.kind === 'sprite')) {
    const assetDir = entry.kind === 'model' ? await modelsDir() : await spritesDir();
    await fs.unlink(path.join(assetDir, entry.file)).catch(() => {});
  }
}
