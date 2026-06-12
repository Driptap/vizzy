// Electron host: window.require reaches Node + ipcRenderer directly
// (nodeIntegration build), same access pattern the app has always used.
import type { Platform, OllamaProgress } from './types';

export function createElectronPlatform(): Platform {
  const { ipcRenderer, webUtils } = window.require('electron');
  const fsp = window.require('fs/promises');
  const fsSync = window.require('fs');

  const memo = (make: () => Promise<string>) => {
    let p: Promise<string> | null = null;
    return () => (p ??= make());
  };

  const ensuredDir = (channel: string) =>
    memo(async () => {
      const dir: string = await ipcRenderer.invoke(channel);
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    });

  return {
    kind: 'electron',
    dirs: {
      userData: memo(() => ipcRenderer.invoke('vizzy:get-user-data-dir')),
      shaders: ensuredDir('vizzy:get-shaders-dir'),
      models: ensuredDir('vizzy:get-models-dir'),
      sprites: ensuredDir('vizzy:get-sprites-dir'),
    },
    fs: {
      readText: (p) => fsp.readFile(p, 'utf8'),
      writeText: (p, data) => fsp.writeFile(p, data),
      readBytes: async (p) => new Uint8Array(await fsp.readFile(p)),
      writeBytes: (p, data) => fsp.writeFile(p, data),
      readDir: (p) => fsp.readdir(p),
      remove: (p) => fsp.unlink(p).catch(() => {}),
      copy: (src, dest) => fsp.copyFile(src, dest),
      exists: (p) =>
        fsp.access(p).then(
          () => true,
          () => false,
        ),
      mkdir: (p) => fsp.mkdir(p, { recursive: true }).then(() => {}),
    },
    writeTextLastGasp: (p, data) => {
      try {
        fsSync.writeFileSync(p, data);
      } catch (err) {
        console.warn('[Vizzy] Sync flush failed:', err);
      }
    },
    pathForFile: (file) => webUtils.getPathForFile(file),
    pickFiles: async () => null,
    onFileDrop: () => () => {},
    ollama: {
      status: () => ipcRenderer.invoke('vizzy:ollama-status'),
      install: async (onProgress) => {
        const listener = (_evt: unknown, p: OllamaProgress) => onProgress(p);
        ipcRenderer.on('vizzy:ollama-progress', listener);
        try {
          await ipcRenderer.invoke('vizzy:ollama-install');
        } finally {
          ipcRenderer.removeListener('vizzy:ollama-progress', listener);
        }
      },
      start: () => ipcRenderer.invoke('vizzy:ollama-start'),
    },
  };
}
