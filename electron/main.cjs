const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');

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
    title: 'PromptVJ',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('promptvj:get-shaders-dir', () =>
    path.join(app.getPath('userData'), 'shaders'),
  );

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
