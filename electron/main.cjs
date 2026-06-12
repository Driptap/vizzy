const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerOllamaIpc } = require('./ollama-manager.cjs');

// Web MIDI + getUserMedia are permission-gated in Electron; without these
// handlers requestMIDIAccess() rejects silently.
const ALLOWED_PERMISSIONS = ['media', 'audioCapture', 'midi', 'midiSysex'];

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0a0a0a',
    title: 'Vizzy',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // The master-out pop-out (window.open from the renderer): bare black
  // window, no menu bar, resizable onto a projector.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      fullscreenable: true,
    },
  }));

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// One-time migration: the package rename (prompt-vj -> vizzy) moved the
// userData directory, which would orphan the saved shader library.
function migrateLegacyShaders() {
  const oldShaders = path.join(app.getPath('appData'), 'prompt-vj', 'shaders');
  const newShaders = path.join(app.getPath('userData'), 'shaders');
  if (!fs.existsSync(oldShaders) || fs.existsSync(newShaders)) return;
  try {
    fs.mkdirSync(path.dirname(newShaders), { recursive: true });
    fs.cpSync(oldShaders, newShaders, { recursive: true });
    console.log('[Vizzy] Migrated shader library from prompt-vj userData');
  } catch (err) {
    console.error('[Vizzy] Shader library migration failed:', err);
  }
}

app.whenReady().then(() => {
  migrateLegacyShaders();

  ipcMain.handle('vizzy:get-shaders-dir', () =>
    path.join(app.getPath('userData'), 'shaders'),
  );
  ipcMain.handle('vizzy:get-models-dir', () =>
    path.join(app.getPath('userData'), 'models'),
  );
  ipcMain.handle('vizzy:get-sprites-dir', () =>
    path.join(app.getPath('userData'), 'sprites'),
  );

  registerOllamaIpc();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.includes(permission),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
