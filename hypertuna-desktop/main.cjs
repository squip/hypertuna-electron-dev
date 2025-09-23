const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { promises: fs, existsSync } = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let workerProcess = null;
let pendingWorkerMessages = [];

const userDataPath = app.getPath('userData');
const storagePath = path.join(userDataPath, 'hypertuna-data');
const logFilePath = path.join(storagePath, 'desktop-console.log');
const gatewaySettingsPath = path.join(storagePath, 'gateway-settings.json');

async function ensureStorageDir() {
  try {
    await fs.mkdir(storagePath, { recursive: true });
  } catch (error) {
    console.error('[Main] Failed to create storage directory', error);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 765,
    height: 1050,
    backgroundColor: '#1F2430',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!pendingWorkerMessages.length) return;
    pendingWorkerMessages.forEach((message) => {
      mainWindow.webContents.send('worker-message', message);
    });
    pendingWorkerMessages = [];
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

async function startWorkerProcess() {
  if (workerProcess) {
    return { success: false, error: 'Worker already running' };
  }

  const workerRoot = path.join(__dirname, '..', 'hypertuna-worker');
  const workerEntry = path.join(workerRoot, 'index.js');

  if (!existsSync(workerEntry)) {
    const error = 'Relay worker entry not found in hypertuna-worker/index.js';
    console.error('[Main] ' + error);
    return { success: false, error };
  }

  try {
    await ensureStorageDir();

    workerProcess = spawn(process.execPath, [workerEntry], {
      cwd: workerRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        APP_DIR: workerRoot,
        STORAGE_DIR: storagePath
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    pendingWorkerMessages = [];

    workerProcess.on('message', (message) => {
      if (mainWindow) {
        mainWindow.webContents.send('worker-message', message);
      } else {
        pendingWorkerMessages.push(message);
      }
    });

    workerProcess.on('error', (error) => {
      console.error('[Main] Worker error', error);
      if (mainWindow) {
        mainWindow.webContents.send('worker-error', error.message);
      }
    });

    workerProcess.on('exit', (code, signal) => {
      console.log(`[Main] Worker exited with code=${code} signal=${signal}`);
      workerProcess = null;
      pendingWorkerMessages = [];
      if (mainWindow) {
        mainWindow.webContents.send('worker-exit', code ?? signal ?? 0);
      }
    });

    if (workerProcess.stdout) {
      workerProcess.stdout.on('data', (data) => {
        if (mainWindow) {
          mainWindow.webContents.send('worker-stdout', data.toString());
        }
      });
    }

    if (workerProcess.stderr) {
      workerProcess.stderr.on('data', (data) => {
        if (mainWindow) {
          mainWindow.webContents.send('worker-stderr', data.toString());
        }
      });
    }

    if (mainWindow && pendingWorkerMessages.length) {
      for (const message of pendingWorkerMessages) {
        mainWindow.webContents.send('worker-message', message);
      }
      pendingWorkerMessages = [];
    }

    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to start worker', error);
    workerProcess = null;
    return { success: false, error: error.message };
  }
}

async function stopWorkerProcess() {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }

  try {
    workerProcess.removeAllListeners();
    workerProcess.kill();
    workerProcess = null;
    pendingWorkerMessages = [];
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to stop worker', error);
    return { success: false, error: error.message };
  }
}

ipcMain.handle('start-worker', async () => {
  return startWorkerProcess();
});

ipcMain.handle('stop-worker', async () => {
  return stopWorkerProcess();
});

ipcMain.handle('send-to-worker', async (_event, message) => {
  if (!workerProcess) {
    return { success: false, error: 'Worker not running' };
  }

  try {
    workerProcess.send(message);
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to send message to worker', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-config', async () => {
  try {
    await ensureStorageDir();
    const configPath = path.join(storagePath, 'relay-config.json');
    const data = await fs.readFile(configPath, 'utf8');
    return { success: true, data: JSON.parse(data) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('write-config', async (_event, config) => {
  try {
    await ensureStorageDir();
    const configPath = path.join(storagePath, 'relay-config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to write config', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-gateway-settings', async () => {
  try {
    await ensureStorageDir();
    const data = await fs.readFile(gatewaySettingsPath, 'utf8');
    return { success: true, data: JSON.parse(data) };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { success: true, data: null };
    }
    console.error('[Main] Failed to read gateway settings', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('write-gateway-settings', async (_event, settings) => {
  try {
    await ensureStorageDir();
    await fs.writeFile(gatewaySettingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to write gateway settings', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-storage-path', async () => {
  await ensureStorageDir();
  return storagePath;
});

ipcMain.handle('get-log-file-path', async () => {
  await ensureStorageDir();
  return logFilePath;
});

ipcMain.handle('append-log-line', async (_event, line) => {
  try {
    await ensureStorageDir();
    await fs.appendFile(logFilePath, line, 'utf8');
    return { success: true };
  } catch (error) {
    console.error('[Main] Failed to append log', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-file-buffer', async (_event, filePath) => {
  try {
    const data = await fs.readFile(filePath);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return { success: true, data: buffer };
  } catch (error) {
    console.error('[Main] Failed to read file buffer', error);
    return { success: false, error: error.message };
  }
});

app.whenReady().then(async () => {
  await ensureStorageDir();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (workerProcess) {
      try {
        workerProcess.kill();
      } catch (error) {
        console.error('[Main] Error while killing worker on shutdown', error);
      }
      workerProcess = null;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  if (workerProcess) {
    try {
      workerProcess.kill();
    } catch (error) {
      console.error('[Main] Error while stopping worker before quit', error);
    }
    workerProcess = null;
  }
});
