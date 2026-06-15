// Performance-session persistence: the full mixer/deck state is written to
// <userData>/session.json (debounced from App) and restored on boot, so the
// app reopens exactly as it was left.
import type { SessionSnapshot } from '../types';
import { getPlatform, joinPath } from '../platform';

let filePromise: Promise<string> | null = null;
let resolvedPath: string | null = null;

function sessionFile(): Promise<string> {
  if (!filePromise) {
    filePromise = getPlatform()
      .dirs.userData()
      .then((dir) => {
        resolvedPath = joinPath(dir, 'session.json');
        return resolvedPath;
      });
  }
  return filePromise;
}

export async function saveSession(data: SessionSnapshot): Promise<void> {
  const file = await sessionFile();
  await getPlatform().fs.writeText(file, JSON.stringify(data));
}

// last-gasp flush for beforeunload — only works once the path has resolved,
// which it will have long before any unload
export function saveSessionSync(data: SessionSnapshot): void {
  if (!resolvedPath) return;
  getPlatform().writeTextLastGasp(resolvedPath, JSON.stringify(data));
}

export async function loadSession(): Promise<SessionSnapshot | null> {
  try {
    const file = await sessionFile();
    return JSON.parse(await getPlatform().fs.readText(file));
  } catch {
    return null;
  }
}

// Drop session.json (used when importing a workspace bundle that carried no
// session, so the next boot starts blank instead of restoring stale state).
export async function clearSession(): Promise<void> {
  const file = await sessionFile();
  await getPlatform().fs.remove(file);
}
