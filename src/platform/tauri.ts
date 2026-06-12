// Tauri host: file IO via the fs plugin, the managed Ollama runtime and
// native drops via custom commands/events on the Rust core (src-tauri).
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { appDataDir } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import * as tfs from '@tauri-apps/plugin-fs';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { Platform, OllamaProgress } from './types';
import { joinPath } from './types';

export function createTauriPlatform(): Platform {
  const memo = (make: () => Promise<string>) => {
    let p: Promise<string> | null = null;
    return () => (p ??= make());
  };

  const userData = memo(async () => {
    const dir = await appDataDir();
    if (!(await tfs.exists(dir))) await tfs.mkdir(dir, { recursive: true });
    return dir;
  });

  const ensuredDir = (name: string) =>
    memo(async () => {
      const dir = joinPath(await userData(), name);
      if (!(await tfs.exists(dir))) await tfs.mkdir(dir, { recursive: true });
      return dir;
    });

  return {
    kind: 'tauri',
    dirs: {
      userData,
      shaders: ensuredDir('shaders'),
      models: ensuredDir('models'),
      sprites: ensuredDir('sprites'),
    },
    fs: {
      readText: (p) => tfs.readTextFile(p),
      writeText: (p, data) => tfs.writeTextFile(p, data),
      readBytes: (p) => tfs.readFile(p),
      writeBytes: (p, data) => tfs.writeFile(p, data),
      readDir: async (p) => (await tfs.readDir(p)).map((e) => e.name),
      remove: (p) => tfs.remove(p).catch(() => {}),
      copy: (src, dest) => tfs.copyFile(src, dest),
      exists: (p) => tfs.exists(p),
      mkdir: (p) => tfs.mkdir(p, { recursive: true }),
    },
    writeTextLastGasp: (p, data) => {
      void tfs.writeTextFile(p, data).catch(() => {});
    },
    pickFiles: async (extensions) => {
      const picked = await openDialog({
        multiple: true,
        filters: [
          { name: 'Supported files', extensions: extensions.map((e) => e.replace(/^\./, '')) },
        ],
      });
      if (!picked) return [];
      return Array.isArray(picked) ? picked : [picked];
    },
    onFileDrop: (cb) => {
      let unlisten: UnlistenFn | null = null;
      let cancelled = false;
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === 'drop' && event.payload.paths.length) {
            cb(event.payload.paths);
          }
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
    ollama: {
      status: () => invoke('ollama_status'),
      install: async (onProgress) => {
        const unlisten = await listen<OllamaProgress>('vizzy://ollama-progress', (e) =>
          onProgress(e.payload),
        );
        try {
          await invoke('ollama_install');
        } finally {
          unlisten();
        }
      },
      start: () => invoke('ollama_start'),
    },
  };
}
