// Tauri host: file IO via the fs plugin, the managed Ollama runtime and
// native drops via custom commands/events on the Rust core (src-tauri).
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { appDataDir } from '@tauri-apps/api/path';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import * as tfs from '@tauri-apps/plugin-fs';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
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
    appVersion: () => getVersion(),
    dirs: {
      userData,
      shaders: ensuredDir('shaders'),
      models: ensuredDir('models'),
      sprites: ensuredDir('sprites'),
      videos: ensuredDir('videos'),
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
    saveFileDialog: async ({ defaultName, extensions }) => {
      const path = await saveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'Vizzy workspace', extensions: extensions.map((e) => e.replace(/^\./, '')) }],
      });
      return path ?? null;
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
    onMenuAction: (cb) => {
      let unlisten: UnlistenFn | null = null;
      let cancelled = false;
      listen<string>('vizzy://menu', (e) => cb(e.payload)).then((fn) => {
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
    updater: (() => {
      // check() returns an Update handle that downloadAndInstall() needs; hold
      // the last one so the UI can split "is there an update?" from "install it".
      let pending: Update | null = null;
      return {
        check: async () => {
          pending = await checkUpdate();
          if (!pending) return null;
          return { version: pending.version, notes: pending.body, date: pending.date };
        },
        install: async (onProgress) => {
          if (!pending) throw new Error('No update pending — call check() first');
          let total = 0;
          let received = 0;
          await pending.downloadAndInstall((e) => {
            if (e.event === 'Started') total = e.data.contentLength ?? 0;
            else if (e.event === 'Progress') {
              received += e.data.chunkLength;
              if (total > 0) onProgress?.(received / total);
            } else if (e.event === 'Finished') onProgress?.(1);
          });
          await relaunch();
        },
      };
    })(),
  };
}
