import { v4 as uuidv4 } from 'uuid';

export function getClientId(existing = null) {
  if (existing) return existing;
  const stored = safeStorageGet('hypertuna_web_client_id');
  if (stored) return stored;
  const next = uuidv4();
  safeStorageSet('hypertuna_web_client_id', next);
  return next;
}

export async function postTelemetry(baseUrl, data = {}) {
  if (!baseUrl || typeof fetch === 'undefined') return false;
  const url = `${baseUrl.replace(/\/+$/, '')}/api/web-telemetry`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': data.clientId || ''
      },
      body: JSON.stringify(data)
    });
    return resp.ok;
  } catch (error) {
    console.warn('[telemetry] failed to post', error?.message || error);
    return false;
  }
}

function safeStorageGet(key) {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // ignore
  }
}
