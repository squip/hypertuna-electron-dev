(() => {
  const api = window.gatewayAPI;
  const els = {
    statusIndicator: document.getElementById('statusIndicator'),
    statusLabel: document.getElementById('statusLabel'),
    uptimeValue: document.getElementById('uptimeValue'),
    pidValue: document.getElementById('pidValue'),
    portValue: document.getElementById('portValue'),
    configPathValue: document.getElementById('configPathValue'),
    statusMessage: document.getElementById('statusMessage'),
    healthStatusValue: document.getElementById('healthStatusValue'),
    healthPeersValue: document.getElementById('healthPeersValue'),
    healthRelaysValue: document.getElementById('healthRelaysValue'),
    healthUpdatedAt: document.getElementById('healthUpdatedAt'),
    connectionsList: document.getElementById('connectionsList'),
    logsContainer: document.getElementById('logsContainer'),
    startButton: document.getElementById('startButton'),
    stopButton: document.getElementById('stopButton'),
    chooseConfigButton: document.getElementById('chooseConfigButton'),
  };

  let currentState = null;
  let healthTimer = null;
  let uptimeTimer = null;
  let selectedConfigPath = null;
  const seenLogIds = new Set();

  function setMessage(text, type = 'info', timeout = 4000) {
    if (!text) {
      els.statusMessage.hidden = true;
      els.statusMessage.textContent = '';
      return;
    }

    els.statusMessage.textContent = text;
    els.statusMessage.className = `message ${type}`;
    els.statusMessage.hidden = false;

    if (timeout > 0) {
      setTimeout(() => {
        if (els.statusMessage.textContent === text) {
          setMessage('');
        }
      }, timeout);
    }
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
      return '—';
    }
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
    }
    return `${seconds}s`;
  }

  function truncateKey(key) {
    if (!key) return '—';
    if (key.length <= 16) return key;
    return `${key.slice(0, 8)}…${key.slice(-6)}`;
  }

  function escapeHtml(value) {
    if (typeof value !== 'string') {
      return value;
    }
    return value.replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);
  }

  function formatRelativeTime(value) {
    if (!value) {
      return '—';
    }
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) {
      return '—';
    }
    const diff = Date.now() - timestamp;
    if (diff < 0) {
      return 'just now';
    }
    if (diff < 60_000) {
      return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
    }
    if (diff < 3_600_000) {
      return `${Math.floor(diff / 60_000)}m ago`;
    }
    if (diff < 86_400_000) {
      return `${Math.floor(diff / 3_600_000)}h ago`;
    }
    return new Date(timestamp).toLocaleString();
  }

  function updateButtons(state) {
    const running = !!state?.running;
    els.startButton.disabled = running;
    els.stopButton.disabled = !running;
  }

  function updateStatus(state) {
    currentState = state;
    updateButtons(state);

    const running = !!state?.running;
    els.statusIndicator.classList.toggle('is-online', running);
    els.statusLabel.textContent = running ? 'Online' : 'Offline';
    els.portValue.textContent = state?.port ?? '—';
    els.pidValue.textContent = state?.pid ?? '—';

    const configToShow = selectedConfigPath || state?.configPath || state?.defaultConfigPath;
    els.configPathValue.textContent = configToShow || '—';

    if (uptimeTimer) {
      clearInterval(uptimeTimer);
      uptimeTimer = null;
    }

    if (running && state?.startedAt) {
      const render = () => {
        const diff = Date.now() - state.startedAt;
        els.uptimeValue.textContent = formatDuration(diff);
      };
      render();
      uptimeTimer = setInterval(render, 1000);
    } else {
      els.uptimeValue.textContent = '—';
    }
  }

  function resetHealthUI() {
    els.healthStatusValue.textContent = '—';
    els.healthPeersValue.textContent = '—';
    els.healthRelaysValue.textContent = '—';
    els.healthUpdatedAt.textContent = '—';
    els.connectionsList.innerHTML = '<p class="empty">No data. Start the gateway to monitor peers.</p>';
  }

  function updateHealthUI(health, diagnostics) {
    if (!currentState?.running) {
      resetHealthUI();
      return;
    }

    if (!health) {
      els.healthStatusValue.textContent = 'Starting…';
      els.healthPeersValue.textContent = '—';
      els.healthRelaysValue.textContent = '—';
      els.healthUpdatedAt.textContent = new Date().toLocaleTimeString();
    } else {
      const modeLabel = health.mode ? ` (${health.mode})` : '';
      els.healthStatusValue.textContent = `${health.status ?? 'unknown'}${modeLabel}`;
      els.healthUpdatedAt.textContent = health.timestamp ? new Date(health.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    }

    if (diagnostics?.peers) {
      els.healthPeersValue.textContent = diagnostics.peers.totalActive ?? '0';
    }
    if (diagnostics?.relays) {
      els.healthRelaysValue.textContent = diagnostics.relays.totalActive ?? '0';
    }

    const peers = diagnostics?.peers?.list ?? [];
    const listEl = els.connectionsList;
    listEl.innerHTML = '';

    if (!peers.length) {
      listEl.innerHTML = '<p class="empty">No peers connected yet.</p>';
      return;
    }

    peers.slice(0, 6).forEach((peer) => {
      const item = document.createElement('div');
      item.className = 'connection-item';
      item.innerHTML = `
        <strong>${escapeHtml(truncateKey(peer.publicKey))}</strong>
        <div class="connection-meta">
          <span>Status · ${escapeHtml(peer.status ?? 'unknown')}</span>
          <span>Mode · ${escapeHtml(peer.mode ?? '—')}</span>
          <span>Relays · ${peer.relayCount ?? 0}</span>
          <span>Last · ${escapeHtml(formatRelativeTime(peer.lastSeen))}</span>
        </div>
      `;
      listEl.appendChild(item);
    });

    if (peers.length > 6) {
      const footer = document.createElement('p');
      footer.className = 'empty';
      footer.textContent = `+ ${peers.length - 6} more peers`; 
      listEl.appendChild(footer);
    }
  }

  function addLog(entry) {
    if (!entry || seenLogIds.has(entry.id)) {
      return;
    }
    seenLogIds.add(entry.id);

    const row = document.createElement('div');
    const level = entry.level || 'info';
    row.className = `log-entry log-entry--${level}`;

    const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString();
    row.innerHTML = `
      <span class="log-entry__time">${escapeHtml(time)}</span>
      <span>${escapeHtml(entry.message ?? '')}</span>
    `;

    els.logsContainer.appendChild(row);

    while (els.logsContainer.children.length > 500) {
      els.logsContainer.removeChild(els.logsContainer.firstChild);
    }

    els.logsContainer.scrollTop = els.logsContainer.scrollHeight;
  }

  function startHealthPolling() {
    stopHealthPolling();
    const poll = async () => {
      if (!currentState?.running) {
        resetHealthUI();
        return;
      }

      const port = currentState.port ?? 8443;
      const baseUrl = `http://127.0.0.1:${port}`;

      let healthData = null;
      let diagnostics = null;

      try {
        const response = await fetch(`${baseUrl}/health`, { cache: 'no-store' });
        if (response.ok) {
          healthData = await response.json();
        }
      } catch (error) {
        healthData = null;
      }

      try {
        const response = await fetch(`${baseUrl}/debug/connections`, { cache: 'no-store' });
        if (response.ok) {
          diagnostics = await response.json();
        }
      } catch (error) {
        diagnostics = null;
      }

      updateHealthUI(healthData, diagnostics);
    };

    poll();
    healthTimer = setInterval(poll, 6000);
  }

  function stopHealthPolling() {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    resetHealthUI();
  }

  async function handleStart() {
    els.startButton.disabled = true;
    els.stopButton.disabled = true;
    setMessage('Starting gateway…', 'info');

    const configPath = selectedConfigPath || currentState?.configPath || currentState?.defaultConfigPath;

    const response = await api.startGateway(configPath);
    if (!response?.ok) {
      updateButtons(currentState);
      setMessage(response?.error || 'Failed to start gateway', 'error');
      return;
    }

    setMessage('Gateway started successfully', 'success');
    updateStatus(response.state);
    startHealthPolling();
  }

  async function handleStop() {
    els.startButton.disabled = true;
    els.stopButton.disabled = true;
    setMessage('Stopping gateway…', 'info');

    const response = await api.stopGateway();
    if (!response?.ok) {
      setMessage(response?.error || 'Failed to stop gateway', 'error');
      updateButtons(currentState);
      return;
    }

    setMessage('Gateway stopped', 'success');
    updateStatus(response.state);
    stopHealthPolling();
  }

  async function chooseConfig() {
    const result = await api.browseConfig();
    if (!result || result.canceled) {
      return;
    }
    selectedConfigPath = result.path;
    els.configPathValue.textContent = selectedConfigPath;
    setMessage('Configuration file selected.', 'success');
  }

  async function bootstrap() {
    try {
      const initial = await api.getState();
      if (initial?.state) {
        updateStatus(initial.state);
        selectedConfigPath = initial.state.configPath || initial.state.defaultConfigPath;
        els.configPathValue.textContent = selectedConfigPath || '—';
      } else {
        updateStatus({ running: false });
        resetHealthUI();
      }
      if (Array.isArray(initial?.logs)) {
        initial.logs.forEach((entry) => addLog(entry));
      }
    } catch (error) {
      updateStatus({ running: false });
      setMessage('Unable to read gateway state on load.', 'error', 6000);
    }

    const detachStatus = api.onStatus((state) => {
      updateStatus(state);
      if (state.running) {
        startHealthPolling();
      } else {
        stopHealthPolling();
      }
    });

    const detachLog = api.onLog((entry) => {
      addLog(entry);
    });

    els.startButton.addEventListener('click', () => {
      if (currentState?.running) return;
      handleStart().catch((error) => {
        setMessage(error?.message || 'Unable to start gateway', 'error');
        updateButtons(currentState);
      });
    });

    els.stopButton.addEventListener('click', () => {
      if (!currentState?.running) return;
      handleStop().catch((error) => {
        setMessage(error?.message || 'Unable to stop gateway', 'error');
      });
    });

    els.chooseConfigButton.addEventListener('click', () => {
      chooseConfig().catch((error) => {
        setMessage(error?.message || 'Failed to choose configuration file', 'error');
      });
    });

    window.addEventListener('beforeunload', () => {
      detachStatus?.();
      detachLog?.();
      if (healthTimer) {
        clearInterval(healthTimer);
      }
      if (uptimeTimer) {
        clearInterval(uptimeTimer);
      }
    });

    if (currentState?.running) {
      startHealthPolling();
    } else {
      resetHealthUI();
    }
  }

  document.addEventListener('DOMContentLoaded', bootstrap);
})();
