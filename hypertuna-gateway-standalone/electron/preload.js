const { contextBridge, ipcRenderer } = require('electron');

const gatewayAPI = {
  startGateway: (configPath) => ipcRenderer.invoke('gateway:start', { configPath }),
  stopGateway: () => ipcRenderer.invoke('gateway:stop'),
  getState: () => ipcRenderer.invoke('gateway:get-state'),
  browseConfig: () => ipcRenderer.invoke('gateway:browse-config'),
  onStatus: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('gateway:status', listener);
    return () => ipcRenderer.removeListener('gateway:status', listener);
  },
  onLog: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const listener = (_event, logEntry) => callback(logEntry);
    ipcRenderer.on('gateway:log', listener);
    return () => ipcRenderer.removeListener('gateway:log', listener);
  },
};

contextBridge.exposeInMainWorld('gatewayAPI', gatewayAPI);
