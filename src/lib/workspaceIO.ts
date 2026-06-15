// Portable workspace bundles (Save As / Open): pack the whole library + live
// session into one compressed `.vizzy` zip that opens identically on another
// computer, and replace the current workspace from such a bundle.
//
// The on-disk library stores asset bytes (models/sprites/videos) separately
// from the JSON entries that reference them by `file`, so a bundle must carry
// both — the manifest (entries + session) and every asset blob under
// `assets/<file>` — or the import would leave dangling references.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { AssetEntry, LibraryEntry, WorkspaceManifest } from '../types';
import { getPlatform, joinPath } from '../platform';
import {
  assetDirFor,
  clearLibrary,
  listShaders,
  writeAssetBytes,
  writeEntry,
} from './shaderLibrary';
import { clearSession, loadSession, saveSession } from './session';

const MANIFEST_NAME = 'manifest.json';
const ASSET_PREFIX = 'assets/';

const isAssetEntry = (entry: LibraryEntry): entry is AssetEntry =>
  entry.kind === 'model' || entry.kind === 'sprite' || entry.kind === 'video';

export interface WorkspaceBundle {
  manifest: WorkspaceManifest;
  /** asset bytes keyed by AssetEntry.file (basename, e.g. "model-…-x.stl") */
  assets: Record<string, Uint8Array>;
}

/** Progress for a long export: read each asset, then pack, then write. */
export interface ExportProgress {
  phase: 'reading' | 'packing' | 'writing';
  /** assets read so far / total assets (0/0 when there are none) */
  done: number;
  total: number;
}

/** Serialize a workspace into the `.vizzy` zip bytes. Pure — no host IO. */
export function packWorkspace(manifest: WorkspaceManifest, assets: Record<string, Uint8Array>): Uint8Array {
  // The manifest (JSON) compresses well; assets are already-compressed media
  // (png/mp4/stl) so deflating them again wastes time for ~no size win —
  // store those at level 0 so packing stays near memcpy-fast even with video.
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)),
  };
  for (const [file, bytes] of Object.entries(assets)) {
    files[`${ASSET_PREFIX}${file}`] = [bytes, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
}

// Yield to the event loop so a just-emitted progress phase can paint before
// the synchronous zip/write blocks the main thread.
const repaint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Parse `.vizzy` zip bytes back into a validated bundle. Pure — no host IO.
 *  @throws if the file isn't a recognizable Vizzy workspace. */
export function unpackWorkspace(bytes: Uint8Array): WorkspaceBundle {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('Not a valid .vizzy workspace file (could not read the archive)');
  }
  const manifestBytes = entries[MANIFEST_NAME];
  if (!manifestBytes) throw new Error('Not a Vizzy workspace: missing manifest');

  let manifest: WorkspaceManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error('Workspace manifest is corrupt');
  }
  if (manifest.format !== 'vizzy-workspace') {
    throw new Error('This file is not a Vizzy workspace');
  }
  if (manifest.version !== 1) {
    throw new Error(`Unsupported workspace version ${String(manifest.version)}`);
  }
  if (!Array.isArray(manifest.library)) {
    throw new Error('Workspace manifest has no library');
  }

  const assets: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path.startsWith(ASSET_PREFIX)) assets[path.slice(ASSET_PREFIX.length)] = data;
  }
  return { manifest, assets };
}

/**
 * Bundle the current workspace and write it to `filePath` (a user-chosen path
 * from the save dialog). Reads the library + session straight from disk, so
 * callers should flush any pending session autosave first for an up-to-date
 * capture. Missing asset blobs are skipped with a warning rather than failing
 * the whole export.
 */
export async function exportWorkspace(
  filePath: string,
  onProgress?: (p: ExportProgress) => void,
): Promise<{ entries: number; assets: number }> {
  const p = getPlatform();
  const library = await listShaders();
  const session = await loadSession();

  const assetEntries = library.filter(isAssetEntry);
  const total = assetEntries.length;
  let done = 0;
  onProgress?.({ phase: 'reading', done, total });

  const assets: Record<string, Uint8Array> = {};
  await Promise.all(
    assetEntries.map(async (entry) => {
      const path = joinPath(await assetDirFor(entry.kind), entry.file);
      try {
        assets[entry.file] = await p.fs.readBytes(path);
      } catch (err) {
        console.warn('[Vizzy] Skipping missing asset on export:', entry.file, err);
      }
      done += 1;
      onProgress?.({ phase: 'reading', done, total });
    }),
  );

  const manifest: WorkspaceManifest = {
    format: 'vizzy-workspace',
    version: 1,
    exportedAt: Date.now(),
    library,
    session,
  };

  onProgress?.({ phase: 'packing', done, total });
  await repaint();
  const bytes = packWorkspace(manifest, assets);

  onProgress?.({ phase: 'writing', done, total });
  await repaint();
  await p.fs.writeBytes(filePath, bytes);

  return { entries: library.length, assets: Object.keys(assets).length };
}

/** Read + validate a `.vizzy` file from disk into a bundle. */
export async function readWorkspaceFile(filePath: string): Promise<WorkspaceBundle> {
  const bytes = await getPlatform().fs.readBytes(filePath);
  return unpackWorkspace(bytes);
}

/**
 * Replace the entire on-disk workspace with a bundle: wipe the current library
 * + assets, write the bundle's asset blobs and entry JSONs, then install (or
 * clear) the session. Returns the imported entries so the caller can restore
 * them into the running app. Does not touch the seeded marker.
 */
export async function replaceWorkspace({ manifest, assets }: WorkspaceBundle): Promise<LibraryEntry[]> {
  await clearLibrary();

  for (const entry of manifest.library) {
    if (isAssetEntry(entry)) {
      const bytes = assets[entry.file];
      if (!bytes) {
        // entry references a blob the bundle didn't carry — skip it whole so
        // the library never lists an asset whose file can't be staged
        console.warn('[Vizzy] Dropping asset entry with no bytes in bundle:', entry.file);
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await writeAssetBytes(entry, bytes);
    }
    // eslint-disable-next-line no-await-in-loop
    await writeEntry(entry);
  }

  if (manifest.session) await saveSession(manifest.session);
  else await clearSession();

  // re-read from disk so the returned list reflects exactly what persisted
  // (dropped asset entries excluded) and is sorted the same as boot
  return listShaders();
}
