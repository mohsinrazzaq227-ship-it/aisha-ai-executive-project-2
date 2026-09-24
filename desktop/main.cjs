/**
 * Electron desktop host for AI-EXECUTIVE.
 * Security model: contextIsolation true, sandbox true, nodeIntegration false,
 * a channel allowlist in the preload bridge, navigation and window-open
 * blocking, and a permission handler that only grants the microphone.
 */
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 3000);
const APP_URL = `http://127.0.0.1:${PORT}`;
let serverProcess = null;
let mainWindow = null;

function projectRoot() {
  return path.resolve(__dirname, '..');
}

function startServerIfNeeded() {
  const root = projectRoot();
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    throw new Error('Dependencies are missing. Run Start-Agent.bat (or npm install) first.');
  }
  serverProcess = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => console.log(`[server] exited with ${code}`));
}

async function waitForServer(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${APP_URL}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#040711',
    title: 'AI-EXECUTIVE',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: process.env.AI_EXECUTIVE_DEVTOOLS === 'true',
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      console.warn(`[security] blocked navigation to ${url}`);
    }
  });
  void mainWindow.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    // Only the microphone is granted: it is required by the voice pipeline.
    callback(permission === 'media' || permission === 'microphone');
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    root: projectRoot(),
  }));
  ipcMain.handle('doctor:run', async () => {
    const res = await fetch(`${APP_URL}/api/system?doctor=1`);
    return res.json();
  });
  ipcMain.handle('open:external', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Only absolute http(s) URLs may be opened externally.');
    }
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => (mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()));

  startServerIfNeeded();
  const ready = await waitForServer();
  if (!ready) {
    console.error('[startup] The backend did not answer /api/health within the timeout. Opening the window anyway so the Doctor can explain what is wrong.');
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});
