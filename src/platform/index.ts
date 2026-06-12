import type { Platform } from './types';
import { createTauriPlatform } from './tauri';

export type { Platform, OllamaStatus, OllamaProgress } from './types';
export { joinPath, extname } from './types';

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Plain-browser fallback (vite dev server in a browser tab, jsdom tests):
// file IO and the managed runtime are unavailable, but nothing throws at
// construction.
const unavailable = (): Promise<never> =>
  Promise.reject(new Error('No desktop host — file access unavailable'));

function createBrowserPlatform(): Platform {
  return {
    kind: 'browser',
    dirs: {
      userData: unavailable,
      shaders: unavailable,
      models: unavailable,
      sprites: unavailable,
    },
    fs: {
      readText: unavailable,
      writeText: unavailable,
      readBytes: unavailable,
      writeBytes: unavailable,
      readDir: unavailable,
      remove: unavailable,
      copy: unavailable,
      exists: async () => false,
      mkdir: unavailable,
    },
    writeTextLastGasp: () => {},
    pickFiles: async () => null,
    onFileDrop: () => () => {},
    ollama: {
      status: unavailable,
      install: unavailable,
      start: unavailable,
    },
  };
}

let platform: Platform | null = null;

export function getPlatform(): Platform {
  platform ??= isTauri() ? createTauriPlatform() : createBrowserPlatform();
  return platform;
}
