// Secure preload bridge. The renderer never receives Node.js access: only the
// audited, explicitly listed channels below are exposed, and each argument is
// validated again in the main process.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['app:info', 'doctor:run', 'open:external', 'window:minimize', 'window:maximize'];

contextBridge.exposeInMainWorld('aiExecutive', {
  isDesktop: true,
  invoke: (channel, payload) => {
    if (!CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`Channel "${channel}" is not exposed by the preload bridge.`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onSupervisorEvent: (listener) => {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('supervisor:event', handler);
    return () => ipcRenderer.removeListener('supervisor:event', handler);
  },
});
