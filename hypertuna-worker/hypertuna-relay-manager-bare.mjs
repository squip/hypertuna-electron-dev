// ./relay-worker/hypertuna-relay-manager-bare.mjs
// Bare-compatible version of the relay manager

import Corestore from 'corestore';
import Hyperswarm from 'hyperswarm';
import NostrRelay from './hypertuna-relay-event-processor.mjs';
import b4a from 'b4a';
import c from 'compact-encoding';
import Protomux from 'protomux';
import Autobee from './hypertuna-relay-helper.mjs';
import { nobleSecp256k1 } from './crypto-libraries.js';
import { NostrUtils } from './nostr-utils.js';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';

// File locking utility to handle concurrent access
const fileLocks = new Map();

async function acquireFileLock(filePath, maxRetries = 5, retryDelay = 500) {
  let retries = 0;
  
  while (retries < maxRetries) {
    if (!fileLocks.has(filePath)) {
      // Acquire the lock
      fileLocks.set(filePath, true);
      return true;
    }
    
    // Wait before retrying
    console.log(`File ${filePath} is locked, retrying in ${retryDelay}ms (attempt ${retries + 1}/${maxRetries})`);
    await delay(retryDelay);
    retries++;
  }
  
  // Failed to acquire lock after max retries
  throw new Error(`Failed to acquire lock for ${filePath} after ${maxRetries} attempts`);
}

function releaseFileLock(filePath) {
  fileLocks.delete(filePath);
}

async function verifyEventSignature(event) {
  try {
      console.log('Verifying Event Signature ===');
      const serialized = serializeEvent(event);
      console.log('Serialized Event:', serialized);
      
      // Use sha256 which returns Uint8Array
      const hashBytes = await nobleSecp256k1.utils.sha256(b4a.from(serialized, 'utf8'));
      const hashHex = NostrUtils.bytesToHex(hashBytes);
      console.log('Event Hash:', hashHex);
      
      console.log('Verification Details:');
      console.log('Public Key:', event.pubkey);
      console.log('Signature:', event.sig);
      
      // schnorr.verify expects the signature, hash, and pubkey
      // Our pure implementation handles string/Uint8Array conversion internally
      const isValid = await nobleSecp256k1.schnorr.verify(
        event.sig,  // hex string
        hashHex,    // hex string
        event.pubkey // hex string (x-only pubkey, 32 bytes)
      );
      
      console.log('Verification Result:', isValid);
      return isValid;
  } catch (err) {
      console.error('Error verifying event signature:', err);
      return false;
  }
}

const WAKEUP_CAPABILITY_FILENAME = 'wakeup-capability.json';

function serializeEvent(event) {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

async function getEventHash(event) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const hashBytes = await nobleSecp256k1.utils.sha256(b4a.from(serialized, 'utf8'));
  return NostrUtils.bytesToHex(hashBytes);
}

function validateEvent(event) {
  if (typeof event.kind !== 'number') return false;
  if (typeof event.content !== 'string') return false;
  if (typeof event.created_at !== 'number') return false;
  if (typeof event.pubkey !== 'string') return false;
  if (!event.pubkey.match(/^[a-f0-9]{64}$/)) return false;

  if (!Array.isArray(event.tags)) return false;
  for (let tag of event.tags) {
    if (!Array.isArray(tag)) return false;
    for (let item of tag) {
      if (typeof item === 'object') return false;
    }
  }

  return true;
}

export class RelayManager {
    constructor(storageDir, bootstrap) {
      this.storageDir = storageDir;
      this.bootstrap = bootstrap;
      this.store = null;  // Initialize in the initialize method
      this.relay = null;
      this.swarm = null;
      this.peers = new Map(); // Track connected peers
    }
  
    async initialize() {
      console.log('Initializing relay with bootstrap:', this.bootstrap);
  
      try {
        // Acquire lock for the storage directory
        await acquireFileLock(this.storageDir);
        console.log(`Acquired lock for storage directory: ${this.storageDir}`);
        
        // Initialize Corestore after acquiring the lock
        this.store = new Corestore(this.storageDir);
        
        this.relay = new NostrRelay(this.store, this.bootstrap, {
          apply: async (batch, view, base) => {
            const kvOps = []
            const eventOps = []

            for (const node of batch) {
              const op = node.value
              if (op.type === 'addWriter') {
                console.log('\rAdding writer', op.key)
                await base.addWriter(b4a.from(op.key, 'hex'))
                continue
              }
              if (op.type === 'put' || op.type === 'del') kvOps.push(node)
              else eventOps.push(node)
            }

            if (kvOps.length) {
              await Autobee.apply(kvOps, view, base)
            }
            if (eventOps.length) {
              await NostrRelay.apply(eventOps, view, base)
            }
          },
          valueEncoding: c.any,
          verifyEvent: this.verifyEvent.bind(this)
        });

        this.relay.on('error', console.error);

        await this.relay.update();
        await this.ensureWakeupCapability().catch((error) => {
          console.warn('[RelayManager] Failed to prepare wakeup capability', error?.message || error);
        });

        this.relay.view.core.on('append', async () => {
          if (this.relay.view.version === 1) return;
          console.log('\rRelay event appended. Current version:', this.relay.view.version);
        });

        if (!this.bootstrap) {
          console.log('Relay public key:', b4a.toString(this.relay.key, 'hex'));
        }

        this.swarm = new Hyperswarm();
        this.setupSwarmListeners();

        console.log('Joining swarm with discovery key:', b4a.toString(this.relay.discoveryKey, 'hex'));
        const discovery = this.swarm.join(this.relay.discoveryKey);
        await discovery.flushed();

        console.log('Initializing relay');
        if (this.relay.writable) {
          try {
            const initEventId = await this.initRelay();
            console.log('Relay initialized with event ID:', initEventId);
          } catch (error) {
            console.error('Failed to initialize relay:', error);
          }
        } else {
          console.log('Relay isn\'t writable yet');
          console.log('Have another writer add the following key:');
          console.log(b4a.toString(this.relay.local.key, 'hex'));
        }
        
        // Release the lock after initialization
        releaseFileLock(this.storageDir);
        console.log(`Released lock for storage directory: ${this.storageDir}`);
        
        return this;
      } catch (error) {
        // Make sure to release the lock in case of errors
        releaseFileLock(this.storageDir);
        console.error(`Error during relay initialization: ${error.message}`);
        console.error(error.stack);
        throw error;
      }
    }

    async ensureWakeupCapability() {
      if (!this.relay) return null;
      try {
        if (typeof this.relay.ready === 'function') {
          await this.relay.ready();
        }
      } catch (error) {
        console.warn('[RelayManager] Relay ready() failed while preparing wakeup capability', error?.message || error);
      }

      const localCore = this.relay.local || null;
      if (localCore && typeof localCore.ready === 'function') {
        try {
          await localCore.ready();
        } catch (error) {
          console.warn('[RelayManager] Failed to ready local core for wakeup capability', error?.message || error);
        }
      }

      let capability = await this.loadWakeupCapability();
      if (capability?.key) {
        this.relay.wakeupCapability = {
          key: capability.key,
          discoveryKey: capability.discoveryKey || null
        };
        return this.relay.wakeupCapability;
      }

      const primaryKey = localCore?.key || localCore?.core?.key || this.relay?.local?.key || this.relay?.key || null;
      if (!primaryKey) {
        console.warn('[RelayManager] Unable to determine wakeup capability key for relay');
        return null;
      }

      const discoveryKey = localCore?.discoveryKey || this.relay.discoveryKey || null;
      const normalizedKey = Buffer.isBuffer(primaryKey) ? primaryKey : Buffer.from(primaryKey);
      capability = {
        key: normalizedKey,
        discoveryKey: discoveryKey ? (Buffer.isBuffer(discoveryKey) ? discoveryKey : Buffer.from(discoveryKey)) : null
      };

      try {
        if (this.relay._wakeup?.queue) {
          this.relay._wakeup.queue(capability.key, localCore?.length || 0);
          await this.relay._wakeup.flush();
        }
      } catch (error) {
        console.warn('[RelayManager] Failed to flush wakeup state', error?.message || error);
      }

      this.relay.wakeupCapability = { ...capability };

      await this.persistWakeupCapability(capability).catch((error) => {
        console.warn('[RelayManager] Failed to persist wakeup capability', error?.message || error);
      });

      return this.relay.wakeupCapability;
    }

    async loadWakeupCapability() {
      const filePath = join(this.storageDir, WAKEUP_CAPABILITY_FILENAME);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.key) return null;
        const keyBuffer = Buffer.from(parsed.key, 'hex');
        const discoveryBuffer = parsed.discoveryKey ? Buffer.from(parsed.discoveryKey, 'hex') : null;
        return {
          key: keyBuffer,
          discoveryKey: discoveryBuffer
        };
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn('[RelayManager] Failed to load wakeup capability', error?.message || error);
        }
        return null;
      }
    }

    async persistWakeupCapability(capability) {
      if (!capability?.key) return;
      const filePath = join(this.storageDir, WAKEUP_CAPABILITY_FILENAME);
      const payload = {
        key: b4a.isBuffer(capability.key) ? capability.key.toString('hex') : Buffer.from(capability.key).toString('hex'),
        discoveryKey: capability.discoveryKey
          ? (b4a.isBuffer(capability.discoveryKey) ? capability.discoveryKey.toString('hex') : Buffer.from(capability.discoveryKey).toString('hex'))
          : null,
        updatedAt: Date.now()
      };
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    }

    setupSwarmListeners() {
      this.swarm.on('connection', async (connection, peerInfo) => {
        const peerKey = b4a.toString(peerInfo.publicKey, 'hex');
        console.log('\rPeer joined', peerKey.substring(0, 16));
        
        // Track peer
        this.peers.set(peerKey, {
          connection,
          connectedAt: new Date(),
          info: peerInfo
        });
        
        const mux = new Protomux(connection);
        console.log('Initialized Protomux on the connection');
        
        const addWriterProtocol = mux.createChannel({
          protocol: 'add-writer',
          onopen: () => {
            console.log('add-writer protocol opened!');
          },
          onclose: () => {
            console.log('add-writer protocol closed!');
            // Remove peer on disconnect
            this.peers.delete(peerKey);
          }
        });
        
        if (!addWriterProtocol) {
          console.error('Failed to create add-writer protocol channel');
          return;
        }
        
        const addWriterMessage = addWriterProtocol.addMessage({
          encoding: c.string,
          onmessage: async (message) => {
            const writerKey = message.toString();
            console.log('Received new writer key:', writerKey);
            try {
              await this.addWriter(writerKey);
              await this.relay.update();
              console.log('Writer key added successfully');
              addWriterProtocol.close();
            } catch (error) {
              console.error('Error adding writer key:', error);
            }
          }
        });
        
        addWriterProtocol.open();
        console.log('Opened add-writer protocol');
        
        const writerKey = b4a.toString(this.relay.local.key, 'hex');
        addWriterMessage.send(writerKey);
        console.log('Sent writer key:', writerKey);
        
        this.relay.replicate(connection);
      });
    }

    async addWriter(key) {
      console.log('Adding writer:', key);
      const result = await this.relay.append({
        type: 'addWriter',
        key
      });
      await this.relay.update().catch(() => {});
      await this.ensureWakeupCapability().catch((error) => {
        console.warn('[RelayManager] Failed to refresh wakeup capability after addWriter', error?.message || error);
      });
      return result;
    }

    async removeWriter(key) {
      console.log('Removing writer:', key);
      return await this.relay.append({
        type: 'removeWriter',
        key
      });
    }

    async handleMessage(message, sendResponse, connectionKey) {
      if (!this.relay) {
        throw new Error('Relay not initialized');
      }
      return this.relay.handleMessage(message, sendResponse, connectionKey);
    }

    async handleSubscription(connectionKey) {
      if (!this.relay) {
        throw new Error('Relay not initialized');
      }
      return this.relay.handleSubscription(connectionKey);
    }        

    async updateSubscriptions(connectionKey, activeSubscriptionsUpdated) {
      try {
        if (!this.relay) {
          throw new Error('Relay not initialized');
        }
        
        console.log(`[${new Date().toISOString()}] RelayManager: Updating subscriptions for connection ${connectionKey}`);
        // console.log('Updated subscription data:', JSON.stringify(activeSubscriptionsUpdated, null, 2));
        
        const result = await this.relay.updateSubscriptions(connectionKey, activeSubscriptionsUpdated);
        console.log(`[${new Date().toISOString()}] RelayManager: Successfully updated subscriptions`);
        
        return result;
      } catch (error) {
        console.error(`[${new Date().toISOString()}] RelayManager: Error updating subscriptions:`, error);
        throw error;
      }
    }

    async initRelay() {
      // Generate a new private key
      const privateKey = NostrUtils.generatePrivateKey(); // Returns hex string
      const publicKey = NostrUtils.getPublicKey(privateKey); // Returns hex string (x-only, 32 bytes)
      
      const event = {
        kind: 0,
        content: 'Relay initialized',
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        pubkey: publicKey, // Already the x-only coordinate without prefix
      };
      
      const serializedEvent = serializeEvent(event);
      const eventHashBytes = await nobleSecp256k1.utils.sha256(b4a.from(serializedEvent, 'utf8'));
      event.id = NostrUtils.bytesToHex(eventHashBytes);
      
      // Sign the event - schnorr.sign returns Uint8Array
      const signatureBytes = await nobleSecp256k1.schnorr.sign(event.id, privateKey);
      event.sig = NostrUtils.bytesToHex(signatureBytes);
      
      console.log('Initialized event (before publishing):', JSON.stringify(event, null, 2));
      console.log('Serialized event:', serializedEvent);
      console.log('Event hash:', event.id);
      
      return this.relay.publishEvent(event);
    }

    async listAllEvents() {
      try {
        await acquireFileLock(`${this.storageDir}-read`);
        
        let count = 0;
        const events = [];
        for await (const node of this.relay.createReadStream()) {
          try {
            const event = JSON.parse(node.value);
            events.push({
              id: node.key.toString('hex'),
              event
            });
            count++;
          } catch (error) {
            console.error('Error parsing event:', error);
          }
        }
        console.log(`Total events: ${count}`);
        
        releaseFileLock(`${this.storageDir}-read`);
        return events;
      } catch (error) {
        releaseFileLock(`${this.storageDir}-read`);
        console.error(`Error listing events: ${error.message}`);
        return [];
      }
    }

    async verifyEvent(event) {
      const isValid = validateEvent(event) && await verifyEventSignature(event);
      return isValid;
    }

    async publishEvent(event) {
      if (!this.relay) {
        throw new Error('Relay not initialized');
      }
      
      if (!validateEvent(event)) {
        throw new Error('Invalid event format');
      }
      
      try {
        await acquireFileLock(`${this.storageDir}-write`);
        const result = await this.relay.publishEvent(event);
        releaseFileLock(`${this.storageDir}-write`);
        return result;
      } catch (error) {
        releaseFileLock(`${this.storageDir}-write`);
        throw error;
      }
    }

    async getEvent(eventId) {
      if (!this.relay) {
        throw new Error('Relay not initialized');
      }
      
      try {
        await acquireFileLock(`${this.storageDir}-read`);
        const result = await this.relay.getEvent(eventId);
        releaseFileLock(`${this.storageDir}-read`);
        return result;
      } catch (error) {
        releaseFileLock(`${this.storageDir}-read`);
        throw error;
      }
    }

    async queryEvents(filters) {
      if (!this.relay) {
        throw new Error('Relay not initialized');
      }
      
      try {
        await acquireFileLock(`${this.storageDir}-read`);
        const result = await this.relay.queryEvents(filters);
        releaseFileLock(`${this.storageDir}-read`);
        return result;
      } catch (error) {
        releaseFileLock(`${this.storageDir}-read`);
        throw error;
      }
    }

    async deleteEvent(eventId) {
      if (!this.relay) {
        throw new Error('Relay not initialized');
      }
      
      try {
        await acquireFileLock(`${this.storageDir}-write`);
        const result = await this.relay.deleteEvent(eventId);
        releaseFileLock(`${this.storageDir}-write`);
        return result;
      } catch (error) {
        releaseFileLock(`${this.storageDir}-write`);
        throw error;
      }
    }

    getPublicKey() {
      return b4a.toString(this.relay.key, 'hex');
    }

    async flushSubscriptionQueue(subscriptionId) {
      try {
        await acquireFileLock(`${this.storageDir}-flush`);
        const result = await this.relay.flushSubscriptionQueue(subscriptionId);
        releaseFileLock(`${this.storageDir}-flush`);
        return result;
      } catch (error) {
        releaseFileLock(`${this.storageDir}-flush`);
        throw error;
      }
    }

    async close() {
      try {
        // Acquire lock for cleanup
        await acquireFileLock(`${this.storageDir}-close`);
        console.log(`Closing relay for ${this.storageDir}`);
        
        if (this.relay) {
          await this.relay.close();
        }
        if (this.swarm) {
          await this.swarm.destroy();
        }
        
        // Release lock when done
        releaseFileLock(`${this.storageDir}-close`);
        console.log(`Released lock for ${this.storageDir}`);
      } catch (error) {
        releaseFileLock(`${this.storageDir}-close`);
        console.error(`Error closing relay: ${error.message}`);
        throw error;
      }
    }
}

// Generate a random public key (potentially used for testing)
export function generateRandomPubkey() {
  const privateKey = NostrUtils.generatePrivateKey(); // Returns hex string
  const publicKey = NostrUtils.getPublicKey(privateKey); // Returns hex string (x-only)
  return publicKey; // Already the correct format, no need to slice
}
