// Performance-session persistence: the full mixer/deck state is written to
// <userData>/session.json (debounced from App) and restored on boot, so the
// app reopens exactly as it was left.
import type { SessionSnapshot } from '../types';

const { ipcRenderer } = window.require('electron');
const fs = window.require('fs/promises');
const fsSync = window.require('fs');
const path = window.require('path');

let filePromise: Promise<string> | null = null;
let resolvedPath: string | null = null;

function sessionFile(): Promise<string> {
  if (!filePromise) {
    filePromise = ipcRenderer.invoke('vizzy:get-user-data-dir').then((dir: string) => {
      resolvedPath = path.join(dir, 'session.json');
      return resolvedPath;
    });
  }
  return filePromise;
}

export async function saveSession(data: SessionSnapshot): Promise<void> {
  const file = await sessionFile();
  await fs.writeFile(file, JSON.stringify(data));
}

// last-gasp flush for beforeunload — only works once the path has resolved,
// which it will have long before any unload
export function saveSessionSync(data: SessionSnapshot): void {
  if (!resolvedPath) return;
  try {
    fsSync.writeFileSync(resolvedPath, JSON.stringify(data));
  } catch (err) {
    console.warn('[Vizzy] Sync session flush failed:', err);
  }
}

export async function loadSession(): Promise<SessionSnapshot | null> {
  try {
    const file = await sessionFile();
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
