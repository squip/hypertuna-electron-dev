# Hyperdrive Integration Requirements and Task Stubs

## Overview
Hypertuna peers will use a local [Hyperdrive](hyperdrive-documentation/hyperdrive-api-documentation.md) instance to share and replicate files. Hyperdrive exposes a public key (`drive.key`) identifying the drive and methods for writing and reading files such as `drive.put` and `drive.get`【F:hyperdrive-documentation/hyperdrive-api-documentation.md†L90-L100】【F:hyperdrive-documentation/hyperdrive-api-documentation.md†L134-L140】.

## Functional Requirements & Tasks

### 1. Worker Hyperdrive Instance
Each worker process must create a single Hyperdrive for storing files and syncing with peers. The drive key is persisted in the user's `relay-config.json` so other peers can discover it.

**Task stubs**
- `hypertuna-worker/hyperdrive-manager.mjs`: implement `initializeHyperdrive`, `storeFile`, and `getFile` to manage a Hyperdrive rooted at `config.storage` and expose helpers for per‑relay folders【F:hypertuna-worker/hyperdrive-manager.mjs†L1-L35】.
- `hypertuna-worker/index.js`: load `driveKey` from config and initialize Hyperdrive during startup【F:hypertuna-worker/index.js†L73-L81】【F:hypertuna-worker/index.js†L610-L621】.

### 2. Config File Updates
Persist the Hyperdrive `driveKey` in both worker and desktop configuration so that each peer can advertise its drive to others.

**Task stubs**
- Extend `loadOrCreateConfig` and related save logic to read/write `driveKey`.
- Update desktop configuration handling to include the worker's `driveKey` in the user config file.

### 3. File Publication Workflow
When a user posts an event with a file:
1. Desktop client hashes the file, constructs a `fileUrl` tag and sends `{ relayKey, fileHash, metadata, buffer }` to the worker.
2. Worker stores the file under `/<relayKey>/<fileHash>` in Hyperdrive and appends an index entry to the relay database: `filekey:<hash>:drivekey:<driveKey>:pubkey:<pubkey>`.

**Task stubs**
- Desktop (`NostrIntegration.js` or related modules): add helpers to hash files, create `fileUrl` tags, and forward file data to the worker.
- Worker (`hypertuna-relay-event-processor.mjs`): support the new `filekey:` index when processing events.
- Worker (`hyperdrive-manager.mjs`): implement `storeFile` to persist both file data and metadata via `drive.put` and verify hash integrity.

### 4. Relay-specific Folder Layout
The Hyperdrive root must contain a subdirectory for each relay, named by the relay's `relayKey` hex string.

**Task stubs**
- `hyperdrive-manager.mjs`: ensure `initializeHyperdrive` creates the folder tree and `storeFile/getFile` reference paths like `/${relayKey}/${fileHash}`.

### 5. P2P Replication & Consensus
Peers connected to the same Nostr relay continuously reconcile their Hyperdrive subdirectory with `filekey:` entries published on the relay.

**Task stubs**
- Worker: add a periodic job to query the relay for new `filekey:` entries, fetch missing files from peers using their `driveKey`, validate hashes, and deduplicate existing files.
- Worker: monitor local Hyperdrive for changes and keep its state in consensus with other peers.

### 6. Gateway File Retrieval
The gateway exposes an HTTPS endpoint that proxies file requests to peers via the existing protomux protocol.

**Task stubs**
- `hypertuna-gateway/pear-sec-hypertuna-gateway.js`: add a `GET /drive/:publicIdentifier/:file` handler that requests the file from a peer and streams the Hyperdrive buffer to the client.
- `hypertuna-gateway/pear-sec-hypertuna-gateway-client.js`: implement a request method that contacts a peer and returns the requested file from its Hyperdrive.
- Worker-side relay protocol: extend the protomux handler to respond to gateway file requests by reading from Hyperdrive using `getFile`.

## Non-functional Requirements
- Validate each replicated file’s hash against the published `fileKey` before accepting it.
- Automatically deduplicate files in Hyperdrive.
- Ensure Hyperdrive operations fail gracefully when storage is unavailable.

## Next Steps
Completing the above task stubs will provide a foundation for peer‑to‑peer file sharing and replication using Hyperdrive across all Hypertuna peers.

