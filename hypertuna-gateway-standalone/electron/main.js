const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let gatewayProcess = null;
const logHistory = [];
const MAX_LOG_ENTRIES = 500;

const gatewayState = {
  running: false,
  port: Number(process.env.GATEWAY_PORT) || 8443,
  pid: null,
  startedAt: null,
  stoppedAt: null,
  configPath: null,
  defaultConfigPath: null,
  lastExit: null,
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0f172a',
    title: 'Hypertuna Gateway Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function recordLog(level, message) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    level,
    message,
    timestamp: new Date().toISOString(),
  };

  logHistory.push(entry);
  if (logHistory.length > MAX_LOG_ENTRIES) {
    logHistory.shift();
  }

  sendToRenderer('gateway:log', entry);
}

function updateGatewayState(update) {
  Object.assign(gatewayState, update);
  sendToRenderer('gateway:status', { ...gatewayState });
}

function resolveConfigPath(customPath) {
  const basePath = app.getAppPath();

  if (!customPath) {
    return path.join(basePath, 'gateway-config.json');
  }

  return path.isAbsolute(customPath) ? customPath : path.join(basePath, customPath);
}

async function startGateway(options = {}) {
  if (gatewayProcess) {
    throw new Error('Gateway process is already running');
  }

  const scriptPath = path.join(app.getAppPath(), 'pear-sec-hypertuna-gateway.js');
  const configPath = resolveConfigPath(options.configPath);

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Gateway script not found: ${scriptPath}`);
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Gateway configuration not found: ${configPath}`);
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  };

  recordLog('info', `Launching gateway using config: ${configPath}`);

  gatewayProcess = spawn(process.execPath, [scriptPath, configPath], {
    cwd: app.getAppPath(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  gatewayState.configPath = configPath;

  const handleStream = (stream, level) => {
    let buffer = '';
    stream.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => recordLog(level, line));
    });
    stream.on('close', () => {
      if (buffer.trim()) {
        recordLog(level, buffer.trim());
      }
    });
  };

  handleStream(gatewayProcess.stdout, 'info');
  handleStream(gatewayProcess.stderr, 'error');

  gatewayProcess.once('exit', (code, signal) => {
    recordLog('info', `Gateway process exited (code: ${code}, signal: ${signal || 'none'})`);
    gatewayProcess = null;
    updateGatewayState({
      running: false,
      pid: null,
      startedAt: null,
      stoppedAt: Date.now(),
      lastExit: { code, signal },
    });
  });

  gatewayProcess.once('error', (error) => {
    recordLog('error', `Gateway process error: ${error.message}`);
    gatewayProcess = null;
    updateGatewayState({
      running: false,
      pid: null,
      startedAt: null,
      stoppedAt: Date.now(),
      lastExit: { code: null, signal: null },
    });
  });

  await new Promise((resolve, reject) => {
    const handleSpawn = () => {
      gatewayProcess?.off('error', handleError);
      resolve();
    };

    const handleError = (error) => {
      gatewayProcess?.off('spawn', handleSpawn);
      reject(error);
    };

    gatewayProcess.once('spawn', handleSpawn);
    gatewayProcess.once('error', handleError);
  });

  updateGatewayState({
    running: true,
    pid: gatewayProcess.pid,
    startedAt: Date.now(),
    stoppedAt: null,
    configPath,
  });

  return { ...gatewayState };
}

async function stopGateway() {
  if (!gatewayProcess) {
    return { ...gatewayState };
  }

  recordLog('info', 'Stopping gateway process...');
  return new Promise((resolve) => {
    const proc = gatewayProcess;
    let settled = false;
    let onExit;
    let onError;

    const finalize = (code, signal, error) => {
      if (settled) {
        return;
      }
      settled = true;

      if (onExit) {
        proc.removeListener('exit', onExit);
      }
      if (onError) {
        proc.removeListener('error', onError);
      }

      if (error) {
        recordLog('error', `Error while stopping gateway: ${error.message}`);
      }

      gatewayProcess = null;
      updateGatewayState({
        running: false,
        pid: null,
        startedAt: null,
        stoppedAt: Date.now(),
        lastExit: { code, signal },
      });
      resolve({ ...gatewayState });
    };

    onExit = (code, signal) => finalize(code, signal ?? null, null);
    onError = (error) => finalize(null, null, error);

    proc.once('exit', onExit);
    proc.once('error', onError);

    try {
      proc.kill('SIGINT');
    } catch (error) {
      finalize(null, null, error);
      return;
    }

    setTimeout(() => {
      if (!settled && gatewayProcess) {
        recordLog('warn', 'Gateway process did not stop in time. Sending SIGTERM.');
        try {
          proc.kill('SIGTERM');
        } catch (error) {
          finalize(null, null, error);
        }
      }
    }, 5000);
  });
}

ipcMain.handle('gateway:start', async (_event, options) => {
  try {
    const state = await startGateway(options || {});
    return { ok: true, state };
  } catch (error) {
    recordLog('error', error.message);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('gateway:stop', async () => {
  const state = await stopGateway();
  return { ok: true, state };
});

ipcMain.handle('gateway:get-state', async () => {
  return {
    state: { ...gatewayState },
    logs: [...logHistory],
  };
});

ipcMain.handle('gateway:browse-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      {
        name: 'JSON Files',
        extensions: ['json'],
      },
      {
        name: 'All Files',
        extensions: ['*'],
      },
    ],
  });

  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }

  const selectedPath = result.filePaths[0];
  recordLog('info', `Selected config file: ${selectedPath}`);
  return { canceled: false, path: selectedPath };
});

function handleAppBeforeQuit() {
  if (!gatewayProcess) {
    return Promise.resolve();
  }
  return stopGateway();
}

app.whenReady().then(() => {
  gatewayState.defaultConfigPath = resolveConfigPath();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  if (!gatewayProcess) {
    return;
  }

  event.preventDefault();
  handleAppBeforeQuit().finally(() => {
    app.exit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
