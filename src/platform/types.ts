// The desktop-shell boundary: everything the renderer needs from the host
// (file IO, data dirs, the managed Ollama runtime, native file drops) behind
// one interface so Electron and Tauri builds share the entire app on top.

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  managedPort: number;
  platform: string;
}

export interface OllamaProgress {
  phase: 'download' | 'extract';
  received?: number;
  total?: number;
}

export interface PlatformDirs {
  userData(): Promise<string>;
  /** Library dirs are created on first use. */
  shaders(): Promise<string>;
  models(): Promise<string>;
  sprites(): Promise<string>;
}

export interface PlatformFs {
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** File names (not paths) in a directory. */
  readDir(path: string): Promise<string[]>;
  /** Missing files are not an error. */
  remove(path: string): Promise<void>;
  copy(src: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export interface Platform {
  kind: 'electron' | 'tauri' | 'browser';
  dirs: PlatformDirs;
  fs: PlatformFs;
  /**
   * Last-gasp write for beforeunload. Synchronous on Electron; fire-and-forget
   * on Tauri (the IPC message is posted before the page unloads, the Rust side
   * outlives the webview teardown).
   */
  writeTextLastGasp(path: string, data: string): void;
  /** Absolute path of a dropped/picked File. Electron-only; null on Tauri. */
  pathForFile(file: File): string | null;
  /**
   * Native multi-file picker. Returns absolute paths, [] on cancel, or null
   * when the host has no native picker (Electron — use a DOM file input).
   */
  pickFiles(extensions: string[]): Promise<string[] | null>;
  /**
   * Native file-drop subscription. On Tauri the webview swallows DOM drop
   * events and reports absolute paths here instead; on Electron this is a
   * no-op (the DOM handlers receive drops). Returns an unsubscribe.
   */
  onFileDrop(cb: (paths: string[]) => void): () => void;
  ollama: {
    status(): Promise<OllamaStatus>;
    install(onProgress: (p: OllamaProgress) => void): Promise<void>;
    start(): Promise<boolean>;
  };
}

/** Forward slashes work for node fs, Rust fs, and Win32 APIs alike. */
export const joinPath = (...parts: string[]): string =>
  parts.filter(Boolean).join('/');

export const extname = (p: string): string => {
  const m = /\.[^./\\]+$/.exec(p);
  return m ? m[0] : '';
};
