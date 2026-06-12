// File-backed shader library: one JSON file per shader in <userData>/shaders/.
// window.require reaches Electron's node integration directly, bypassing the
// Vite bundler (these modules don't exist in a browser build).
import type {
  AssetEntry,
  DeckChannelConfig,
  DeckEntry,
  LibraryEntry,
  ModelEntry,
  ShaderEntry,
  SpriteEntry,
} from '../types';

const { ipcRenderer, webUtils } = window.require('electron');
const fs = window.require('fs/promises');
const path = window.require('path');

let dirPromise: Promise<string> | null = null;
let modelsDirPromise: Promise<string> | null = null;

function shadersDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = ipcRenderer.invoke('vizzy:get-shaders-dir').then(async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
  }
  return dirPromise;
}

function modelsDir(): Promise<string> {
  if (!modelsDirPromise) {
    modelsDirPromise = ipcRenderer.invoke('vizzy:get-models-dir').then(async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
  }
  return modelsDirPromise;
}

let spritesDirPromise: Promise<string> | null = null;

function spritesDir(): Promise<string> {
  if (!spritesDirPromise) {
    spritesDirPromise = ipcRenderer.invoke('vizzy:get-sprites-dir').then(async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
  }
  return spritesDirPromise;
}

const makeId = (kind: string): string =>
  `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Absolute path of a dropped/picked File (File.path was removed in Electron)
export function filePathOf(file: File): string {
  return webUtils.getPathForFile(file);
}

let userDataDirPromise: Promise<string> | null = null;

function userDataDir(): Promise<string> {
  if (!userDataDirPromise) {
    userDataDirPromise = ipcRenderer.invoke('vizzy:get-user-data-dir');
  }
  return userDataDirPromise;
}

// First-run marker as a FILE next to the library data — localStorage is
// per-origin (dev server vs file://), so a localStorage-only flag re-seeds
// whenever the app is launched a different way.
export async function hasSeededMarker(): Promise<boolean> {
  try {
    await fs.access(path.join(await userDataDir(), '.vizzy-seeded'));
    return true;
  } catch {
    return false;
  }
}

export async function writeSeededMarker(): Promise<void> {
  await fs
    .writeFile(path.join(await userDataDir(), '.vizzy-seeded'), String(Date.now()))
    .catch(() => {});
}

async function writeEntry(entry: LibraryEntry): Promise<void> {
  const dir = await shadersDir();
  await fs.writeFile(path.join(dir, `${entry.id}.json`), JSON.stringify(entry));
}

/** @returns newest-first array of library entries */
export async function listShaders(): Promise<LibraryEntry[]> {
  const dir = await shadersDir();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  const entries = await Promise.all(
    files.map(async (file): Promise<LibraryEntry | null> => {
      try {
        return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      } catch (err) {
        console.warn('[Vizzy] Skipping unreadable library file:', file, err);
        return null;
      }
    }),
  );
  return entries
    .filter((entry): entry is LibraryEntry => entry !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveShader({
  name = '',
  code,
  screenshot = null,
}: {
  name?: string;
  code: string;
  screenshot?: string | null;
}): Promise<ShaderEntry> {
  const entry: ShaderEntry = {
    id: makeId('shader'),
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
export async function saveDeck({
  name = '',
  channels,
  screenshot = null,
}: {
  name?: string;
  channels: DeckChannelConfig[];
  screenshot?: string | null;
}): Promise<DeckEntry> {
  const entry: DeckEntry = {
    id: makeId('deck'),
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
export async function saveModel({
  sourcePath,
  name = '',
}: {
  sourcePath: string;
  name?: string;
}): Promise<ModelEntry> {
  const dir = await modelsDir();
  const ext = path.extname(sourcePath).toLowerCase();
  const id = makeId('model');
  const file = `${id}${ext}`;
  await fs.copyFile(sourcePath, path.join(dir, file));
  const entry: ModelEntry = { id, kind: 'model', name, file, screenshot: null, createdAt: Date.now() };
  await writeEntry(entry);
  return entry;
}

export async function getModelFilePath(entry: ModelEntry): Promise<string> {
  const dir = await modelsDir();
  return path.join(dir, entry.file);
}

/** A sprite entry: an image file copied into <userData>/sprites/. */
export async function saveSprite({
  sourcePath,
  name = '',
  screenshot = null,
}: {
  sourcePath: string;
  name?: string;
  screenshot?: string | null;
}): Promise<SpriteEntry> {
  const dir = await spritesDir();
  const ext = path.extname(sourcePath).toLowerCase();
  const id = makeId('sprite');
  const file = `${id}${ext}`;
  await fs.copyFile(sourcePath, path.join(dir, file));
  const entry: SpriteEntry = { id, kind: 'sprite', name, file, screenshot, createdAt: Date.now() };
  await writeEntry(entry);
  return entry;
}

export async function getSpriteFilePath(entry: SpriteEntry): Promise<string> {
  const dir = await spritesDir();
  return path.join(dir, entry.file);
}

/** Model/sprite entry from in-memory bytes (used by the first-run seeder). */
export async function saveAssetFromBuffer({
  kind,
  name = '',
  bytes,
  ext,
  screenshot = null,
}: {
  kind: 'model' | 'sprite';
  name?: string;
  bytes: Uint8Array;
  ext: string;
  screenshot?: string | null;
}): Promise<AssetEntry> {
  const dir = kind === 'model' ? await modelsDir() : await spritesDir();
  const id = makeId(kind);
  const file = `${id}${ext}`;
  await fs.writeFile(path.join(dir, file), bytes);
  const entry = { id, kind, name, file, screenshot, createdAt: Date.now() } as AssetEntry;
  await writeEntry(entry);
  return entry;
}

export async function renameShader<T extends LibraryEntry>(entry: T, name: string): Promise<T> {
  const updated = { ...entry, name };
  await writeEntry(updated);
  return updated;
}

export async function updateEntry<T extends LibraryEntry>(entry: T): Promise<T> {
  await writeEntry(entry);
  return entry;
}

export async function deleteEntry(
  entry: { id: string; kind?: string; file?: string },
): Promise<void> {
  const dir = await shadersDir();
  await fs.unlink(path.join(dir, `${entry.id}.json`)).catch(() => {});
  if (entry.file && (entry.kind === 'model' || entry.kind === 'sprite')) {
    const assetDir = entry.kind === 'model' ? await modelsDir() : await spritesDir();
    await fs.unlink(path.join(assetDir, entry.file)).catch(() => {});
  }
}
