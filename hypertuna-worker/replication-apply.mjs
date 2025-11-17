import { logWithTimestamp } from './hypertuna-relay-helper.mjs';

export async function applyReplicationEvent(relayManager, relayId, event) {
  if (!relayManager || !relayId || !event?.id) return { status: 'failed' };
  const manager = relayManager.activeRelays?.get?.(relayId) || relayManager.activeRelays?.get?.(relayId.toString());
  const relay = manager?.relay;
  if (!relay || typeof relay.publishEvent !== 'function' || typeof relay.getEvent !== 'function') {
    logWithTimestamp(`[ReplicationApply] No relay found for ${relayId}`);
    return { status: 'failed', reason: 'no-relay' };
  }

  try {
    const existing = await relay.getEvent(event.id);
    if (existing) {
      logWithTimestamp(`[ReplicationApply] Duplicate event ${event.id} for relay ${relayId}, skipping`);
      return { status: 'duplicate' };
    }
  } catch (_) {
    // ignore lookup failures, proceed to append
  }

  const result = await relay.publishEvent(event);
  if (Array.isArray(result) && result[0] === 'OK' && result[2] === true) {
    logWithTimestamp(`[ReplicationApply] Applied replication event ${event.id} to relay ${relayId}`);
    return { status: 'applied' };
  }
  logWithTimestamp(`[ReplicationApply] Failed to apply replication event ${event.id} to relay ${relayId}: ${result || 'unknown'}`);
  return { status: 'failed', reason: result || 'unknown' };
}
