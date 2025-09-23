const { contextBridge, ipcRenderer } = require('electron');
const { createRequire } = require('module');
const nodeRequire = createRequire(__filename);

async function importModule(specifier) {
  try {
    return await import(specifier);
  } catch (importError) {
    try {
      return nodeRequire(specifier);
    } catch (requireError) {
      throw importError;
    }
  }
}

function requireModule(specifier) {
  return nodeRequire(specifier);
}

function registerListener(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  startWorker: () => ipcRenderer.invoke('start-worker'),
  stopWorker: () => ipcRenderer.invoke('stop-worker'),
  sendToWorker: (message) => ipcRenderer.invoke('send-to-worker', message),
  onWorkerMessage: registerListener('worker-message'),
  onWorkerError: registerListener('worker-error'),
  onWorkerExit: registerListener('worker-exit'),
  onWorkerStdout: registerListener('worker-stdout'),
  onWorkerStderr: registerListener('worker-stderr'),
  readConfig: () => ipcRenderer.invoke('read-config'),
  writeConfig: (config) => ipcRenderer.invoke('write-config', config),
  readGatewaySettings: () => ipcRenderer.invoke('read-gateway-settings'),
  writeGatewaySettings: (settings) => ipcRenderer.invoke('write-gateway-settings', settings),
  startGateway: (options) => ipcRenderer.invoke('gateway-start', options),
  stopGateway: () => ipcRenderer.invoke('gateway-stop'),
  getGatewayStatus: () => ipcRenderer.invoke('gateway-get-status'),
  getGatewayLogs: () => ipcRenderer.invoke('gateway-get-logs'),
  getGatewayOptions: () => ipcRenderer.invoke('gateway-get-options'),
  setGatewayOptions: (options) => ipcRenderer.invoke('gateway-set-options', options),
  getStoragePath: () => ipcRenderer.invoke('get-storage-path'),
  getLogFilePath: () => ipcRenderer.invoke('get-log-file-path'),
  appendLogLine: (line) => ipcRenderer.invoke('append-log-line', line),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  importModule,
  requireModule
});
