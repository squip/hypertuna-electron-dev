const electronAPI = window.electronAPI || null;
let logFilePath = null;

if (electronAPI?.getLogFilePath) {
  electronAPI.getLogFilePath().then((path) => {
    logFilePath = path;
  }).catch(() => {
    logFilePath = null;
  });
}

function getCallingScript() {
  const err = new Error();
  const stack = err.stack ? err.stack.split('\n') : [];
  for (const line of stack) {
    if (line.includes('console-file-logger')) continue;
    const match = line.match(/(?:\(|@)([^:\)]+\.js)/);
    if (match) {
      const parts = match[1].split(/[\\/]/);
      return parts[parts.length - 1] || 'unknown';
    }
  }
  return 'unknown';
}

function writeLog(level, args) {
  const message = args.map(arg => {
    try {
      return typeof arg === 'string' ? arg : JSON.stringify(arg);
    } catch {
      return '[Unserializable]';
    }
  }).join(' ');

  const script = getCallingScript();
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${script}] ${message}\n`;

  if (electronAPI?.appendLogLine) {
    electronAPI.appendLogLine(line).catch(() => {});
  }
}

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    writeLog(level, args);
    original(...args);
  };
}

export { logFilePath };
