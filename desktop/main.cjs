/**
 * Electron desktop host for AISHA.
 *
 * Security model (unchanged from the canonical runtime, Project 2):
 *   contextIsolation: true, sandbox: true, nodeIntegration: false,
 *   an allow-listed preload bridge, navigation + window-open blocking, and a
 *   permission handler that grants only the microphone (needed for voice).
 *
 * The renderer never receives Node access: it talks to the local AISHA HTTP
 * service, which is the single runtime authority.
 */
const { app, BrowserWindow, ipcMain, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT || 3000);
const APP_URL = `http://127.0.0.1:${PORT}`;
const ALLOWED_ORIGINS = [APP_URL, `http://localhost:${PORT}`];
let serverProcess = null;
let mainWindow = null;

function projectRoot() {
  return path.resolve(__dirname, "..");
}

function startServerIfNeeded() {
  const root = projectRoot();
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    throw new Error("Dependencies are missing. Run Start-AISHA.bat (or npm install) first.");
  }
  serverProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "start"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.on("data", (chunk) => process.stdout.write(`[aisha] ${chunk}`));
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(`[aisha] ${chunk}`));
  serverProcess.on("exit", (code) => console.log(`[aisha] server exited with ${code}`));
}

async function waitForHealth(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${APP_URL}/api/health`);
      if (response.ok || response.status === 503) return await response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`AISHA did not answer /api/health within ${timeoutMs}ms`);
}

function hardenSession() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "audioCapture" || permission === "microphone");
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const isLocal = ALLOWED_ORIGINS.some((origin) => details.url.startsWith(origin)) || details.url.startsWith("devtools://") || details.url.startsWith("data:");
    callback({ cancel: !isLocal });
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#05070f",
    title: "AISHA — AI Executive",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!ALLOWED_ORIGINS.some((origin) => url.startsWith(origin))) {
      event.preventDefault();
      if (url.startsWith("http")) void shell.openExternal(url);
    }
  });

  await mainWindow.loadURL(APP_URL);
  return mainWindow;
}

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  port: PORT,
  platform: process.platform,
  health: `${APP_URL}/api/health`,
  doctor: `${APP_URL}/api/system`,
}));

ipcMain.handle("doctor:run", async () => {
  const response = await fetch(`${APP_URL}/api/system`);
  return response.json();
});

ipcMain.handle("open:external", async (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return { ok: false, detail: "only http(s) URLs may be opened externally" };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:maximize", () => (mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()));

app.whenReady().then(async () => {
  hardenSession();
  try {
    startServerIfNeeded();
    const health = await waitForHealth();
    console.log("[aisha] health:", JSON.stringify(health).slice(0, 400));
    await createWindow();
  } catch (error) {
    console.error("[aisha] startup failed:", error);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) serverProcess.kill();
});
