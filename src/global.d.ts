// Electron's node integration: window.require reaches main-process modules
// directly, bypassing the Vite bundler (see lib/shaderLibrary, lib/session).
interface VizzyRequire {
  (module: 'electron'): {
    ipcRenderer: import('electron').IpcRenderer;
    webUtils: { getPathForFile(file: File): string };
  };
  (module: 'fs/promises'): typeof import('node:fs/promises');
  (module: 'fs'): typeof import('node:fs');
  (module: 'path'): typeof import('node:path');
}

interface Window {
  require: VizzyRequire;
}
