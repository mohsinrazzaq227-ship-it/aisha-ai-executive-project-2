/**
 * Secure preload bridge. The renderer receives NO Node.js access: only the
 * explicitly listed channels below are exposed, and every argument is validated
 * again in the main process.
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = ["app:info", "doctor:run", "open:external", "window:minimize", "window:maximize"];

contextBridge.exposeInMainWorld("aisha", {
  isDesktop: true,
  invoke: (channel, payload) => {
    if (!CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`Channel "${channel}" is not exposed by the preload bridge.`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onHostEvent: (listener) => {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on("aisha:event", handler);
    return () => ipcRenderer.removeListener("aisha:event", handler);
  },
});
