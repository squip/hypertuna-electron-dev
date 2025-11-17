const relaySecrets = new Map(); // relayId -> { secret, updatedAt }

export function setRelaySecret(relayId, secret) {
  if (!relayId || !secret) return;
  relaySecrets.set(relayId, { secret, updatedAt: Date.now() });
}

export function getRelaySecret(relayId) {
  const entry = relaySecrets.get(relayId);
  return entry ? entry.secret : null;
}

export function hasRelaySecret(relayId) {
  return relaySecrets.has(relayId);
}

export function listRelaySecrets() {
  return Array.from(relaySecrets.entries()).map(([relayId, { updatedAt }]) => ({
    relayId,
    updatedAt
  }));
}
