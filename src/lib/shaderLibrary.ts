// File-backed shader library: one JSON file per shader in <userData>/shaders/.
// All host access (file IO, data dirs) goes through the platform layer.
import type {
  AssetEntry,
  DeckChannelConfig,
  DeckEntry,
  LibraryEntry,
  ModelEntry,
  SceneEntry,
  SceneSpec,
  ShaderEntry,
  SpriteEntry,
} from '../types';
import { getPlatform, joinPath, extname } from '../platform';

const makeId = (kind: string): string =>
  `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// First-run marker as a FILE next to the library data — localStorage is
// per-origin (dev server vs file://), so a localStorage-only flag re-seeds
// whenever the app is launched a different way.
export async function hasSeededMarker(): Promise<boolean> {
  const p = getPlatform();
  return p.fs.exists(joinPath(await p.dirs.userData(), '.vizzy-seeded'));
}

export async function writeSeededMarker(): Promise<void> {
  const p = getPlatform();
  await p.fs
    .writeText(joinPath(await p.dirs.userData(), '.vizzy-seeded'), String(Date.now()))
    .catch(() => {});
}

async function writeEntry(entry: LibraryEntry): Promise<void> {
  const p = getPlatform();
  const dir = await p.dirs.shaders();
  await p.fs.writeText(joinPath(dir, `${entry.id}.json`), JSON.stringify(entry));
}

/** @returns newest-first array of library entries */
export async function listShaders(): Promise<LibraryEntry[]> {
  const p = getPlatform();
  const dir = await p.dirs.shaders();
  const files = (await p.fs.readDir(dir)).filter((f) => f.endsWith('.json'));
  const entries = await Promise.all(
    files.map(async (file): Promise<LibraryEntry | null> => {
      try {
        return JSON.parse(await p.fs.readText(joinPath(dir, file)));
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

/** A procedural fly-through scene: the generating spec, stored as JSON. */
export async function saveScene({
  name = '',
  spec,
  prompt = '',
  screenshot = null,
}: {
  name?: string;
  spec: SceneSpec;
  prompt?: string;
  screenshot?: string | null;
}): Promise<SceneEntry> {
  const entry: SceneEntry = {
    id: makeId('scene'),
    kind: 'scene',
    name,
    spec,
    prompt,
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
  const p = getPlatform();
  const dir = await p.dirs.models();
  const ext = extname(sourcePath).toLowerCase();
  const id = makeId('model');
  const file = `${id}${ext}`;
  await p.fs.copy(sourcePath, joinPath(dir, file));
  const entry: ModelEntry = { id, kind: 'model', name, file, screenshot: null, createdAt: Date.now() };
  await writeEntry(entry);
  return entry;
}

export async function getModelFilePath(entry: ModelEntry): Promise<string> {
  const dir = await getPlatform().dirs.models();
  return joinPath(dir, entry.file);
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
  const p = getPlatform();
  const dir = await p.dirs.sprites();
  const ext = extname(sourcePath).toLowerCase();
  const id = makeId('sprite');
  const file = `${id}${ext}`;
  await p.fs.copy(sourcePath, joinPath(dir, file));
  const entry: SpriteEntry = { id, kind: 'sprite', name, file, screenshot, createdAt: Date.now() };
  await writeEntry(entry);
  return entry;
}

export async function getSpriteFilePath(entry: SpriteEntry): Promise<string> {
  const dir = await getPlatform().dirs.sprites();
  return joinPath(dir, entry.file);
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
  const p = getPlatform();
  const dir = kind === 'model' ? await p.dirs.models() : await p.dirs.sprites();
  const id = makeId(kind);
  const file = `${id}${ext}`;
  await p.fs.writeBytes(joinPath(dir, file), bytes);
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
  const p = getPlatform();
  const dir = await p.dirs.shaders();
  await p.fs.remove(joinPath(dir, `${entry.id}.json`));
  if (entry.file && (entry.kind === 'model' || entry.kind === 'sprite')) {
    const assetDir = entry.kind === 'model' ? await p.dirs.models() : await p.dirs.sprites();
    await p.fs.remove(joinPath(assetDir, entry.file));
  }
}
