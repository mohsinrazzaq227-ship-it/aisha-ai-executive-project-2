# AISHA desktop host (Electron)

The web runtime is the single authority. The Electron host only starts the local AISHA
service, waits for `/api/health`, and loads it in a hardened window.

## Install and run

```bash
npm install --save-dev electron
npx electron desktop/main.cjs
```

`GET /api/system` reports the Electron capability honestly: `MISSING` with the install
command until the package is present, then `AVAILABLE_BUT_OPTIONAL`.

## Security posture (see ../SECURITY.md)

* `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
* preload exposes exactly five allow-listed channels (`app:info`, `doctor:run`,
  `open:external`, `window:minimize`, `window:maximize`); the renderer never gets Node
* navigation and `window.open` are intercepted: local origins stay in-window, http(s)
  links go to the system browser, everything else is blocked
* `webRequest` cancels any request that leaves the local AISHA origin
* permission handler grants only microphone/audio capture (needed for the voice pipeline)
* the child server process is killed on `window-all-closed` and `before-quit`

## Files

* `main.cjs` — window creation, service supervision, IPC handlers
* `preload.cjs` — the audited bridge, with channel validation repeated in main
