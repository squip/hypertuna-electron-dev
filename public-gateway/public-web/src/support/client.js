import NostrGroupClient from '@desktop/NostrGroupClient.js';
import NostrEvents from '@desktop/NostrEvents.js';
import { NostrUtils } from '@desktop/NostrUtils.js';
import WebSocketRelayManager from '@desktop/WebSocketRelayManager.js';
import EncryptedReplicationStore from '@desktop/EncryptedReplicationStore.js';
import ReplicationSecretManager from '@desktop/ReplicationSecretManager.js';

let clientInstance = null;

export function getNostrClient(options = {}) {
  if (clientInstance) return clientInstance;
  const debug = options.debug ?? false;
  clientInstance = new NostrGroupClient(debug);
  return clientInstance;
}

export const sharedModules = {
  NostrGroupClient,
  NostrEvents,
  NostrUtils,
  WebSocketRelayManager,
  EncryptedReplicationStore,
  ReplicationSecretManager
};
