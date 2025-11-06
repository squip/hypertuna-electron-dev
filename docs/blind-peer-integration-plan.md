# Blind-Peer Integration Implementation Plan

## 1. Objectives & Scope
- Host a `blind-peer` service inside the public gateway so it can accept mirror requests from registered workers and keep critical Hypercore/Hyperdrive data online.
- Automatically trust any worker that successfully registers with the gateway so those peers can request DHT announcements and delete their mirrors without manual approval.
- Extend worker processes to run a `blind-peering` client that mirrors active RelayManager/NostrRelay datasets plus Hyperdrive content into the gateway’s blind peer, and that can rehydrate local state from blind peers when coming online.
- Provide configurable storage quotas (default 25 GB) with automated hygiene/garbage collection and deduplication for the blind-peer storage footprint.
- Ensure workers continuously monitor the blind peer for updated relay/hyperdrive cores that matter to them and pull the latest state when required.

## 2. Current State Summary
- **Public gateway (`public-gateway/src/PublicGatewayService.mjs`)**
  - Manages Express/WS endpoints, Hyperswarm pool, registration tracking, relay dispatch & metrics.
  - Persists relay metadata via registration stores (memory/redis).
  - Hosts Hyperbee relay dataset through `HyperbeeRelayHost`.
- **Worker (`hypertuna-worker`)**
  - Initializes local Hyperdrive (`hyperdrive-manager.mjs`) and Nostr relays via `RelayManager`.
  - Registers with gateway through `GatewayService` (Hyperswarm & HTTP) and mirrors remote drives via `mirror-sync-manager.mjs`.
  - Stores settings in `shared/config/PublicGatewaySettings.mjs`.
- No existing blind-peer usage; no facility to persist relay/hyperdrive state when workers disconnect.

## 3. Public Gateway Integration Tasks

### 3.1 Dependencies & Configuration
1. **[Completed]** Added `blind-peer`, `blind-peer-encodings`, and `hypercore-id-encoding` to `public-gateway/package.json`, bringing the daemon and encoders into the runtime dependency graph.
2. **[Completed]** Extended `public-gateway/src/config.mjs` with a fully-normalised `blindPeer` block (default 25 GB quota, GC cadence, dedupe batch size, trusted-peer path) plus matching environment overrides (`GATEWAY_BLINDPEER_*`). The loader now sanitises paths/numbers and exposes defaults to the service.
3. **[Open]** Update the public gateway README / sample env files with the new configuration knobs. *Guideline:* document the new env vars alongside existing relay settings and note that `trustedPeersPersistPath` will soon store the gateway-maintained allow list.

### 3.2 Blind Peer Service Wrapper
1. **[Completed]** Implemented `public-gateway/src/blind-peer/BlindPeerService.mjs` which spins up the real `blind-peer` daemon, tracks trusted keys, mirrors cores/autobases, and surfaces status/metrics (see integration with Prometheus gauges in `metrics.mjs`).
2. **[Completed]** Service initialisation respects the configured storage directory (auto-creates `blind-peer-data/` if unset), so data persists across restarts; file-system permission hardening documented in §7.1.
3. **[Open]** Session bridging with the gateway’s `EnhancedHyperswarmPool` is deferred. *Guideline:* once worker mirroring is stable, provide a stream adapter so the service can reuse gateway connections instead of its own embedded Hyperswarm instance.

### 3.3 Gateway Service Integration
1. **[Completed]** `PublicGatewayService` now creates/tears down `BlindPeerService` during lifecycle transitions, updating metrics and logging key material at boot.
2. **[Completed]** Hyperswarm handshakes expose `blindPeerEnabled`, `blindPeerPublicKey`, `blindPeerEncryptionKey`, and `blindPeerMaxBytes`, allowing workers to discover mirrors without custom RPCs.
3. **[Completed]** Registration handlers automatically trust new peers (`addTrustedPeer`), remove trust on disconnect, persist the allowlist to `trustedPeersPersistPath`, and propagate trust metadata (`blindPeerTrusted`, `blindPeerTrustedSince`) into the registration store/state payloads.
4. **[Open]** Provide explicit APIs for other services (dispatcher/health monitors) to request mirroring or inspect blind-peer status. *Guideline:* add a thin wrapper method on `BlindPeerService` that accepts relay/autobase descriptors and emits structured events for GC/accounting.

### 3.4 Blind Peer Hygiene & GC
1. **[Completed]** Implement periodic hygiene job inside `BlindPeerService`:
   - Run at `gcIntervalMs`.
   - Inspect `BlindPeer.db` collections to find duplicate entries (same Hypercore key referenced by multiple owners) and consolidate owner metadata.
   - Identify stale cores (`metadata.lastActive` or `digest` timestamps) older than `staleCoreTtlMs` and request deletion unless flagged as high-priority.
   - Enforce `maxBytes`: invoke `blindPeer.flush()` and `CoreTracker.gc()` until bytes <= limit; log any forced eviction.
   - Emit Prometheus counters for hygiene runs (`gateway_blind_peer_gc_runs_total`) and eviction reasons (`gateway_blind_peer_evictions_total{reason=...}`) plus structured logs summarising each cycle.
2. **[In Progress]** Store extended metadata for cores:
   - Maintain side-channel (e.g., RocksDB keyspace or registration store) linking core key → { ownerPeerKey, type (`relay`, `hyperdrive`, `pfp`), identifier }.
   - Use metadata during dedupe (prefer highest priority, keep one copy per identifier).
   - *Update:* `BlindPeerService` now keeps an in-memory metadata map (`coreMetadata`) populated by mirroring requests and publishes per-peer mirror summaries into the registration store (`metadata.blindPeerMirrors`). Disk-backed persistence remains a future enhancement.
3. **[Completed]** Expose hygiene status via gateway metrics and optionally an admin REST endpoint (`GET /api/blind-peer/status`).
   - `/api/blind-peer` now accepts `detail`, `owners`, and `coresPerOwner` query parameters and returns hygiene run summaries, bytes freed, eviction counts, and ownership statistics.

> **Status:** *In Progress.* Automated dedupe, stale-core eviction, metrics, hygiene summaries, and ownership reporting are live. Persisted metadata beyond in-memory/registration snapshots and additional admin automation remain in follow-up tasks.

### 3.5 API & Discovery Updates
1. **[Completed]** Gateway websocket status events now include blind-peer metadata and the new `/api/blind-peer` endpoint exposes `getAnnouncementInfo()` plus metrics/trust state for inspection (`public-gateway/src/PublicGatewayService.mjs`).
2. **[Open]** Update CLI/docs to surface blind-peer config. *Guideline:* include sample output showing `blindPeerEnabled`, keys, and quota so operators can validate configuration after deployment.

## 4. Worker Integration Tasks

### 4.1 Dependencies & Configuration
1. **[Completed]** Worker `package.json` already depended on `blind-peering`; the new workflow keeps it pinned and leverages it via the manager.
2. **[Completed]** `shared/config/PublicGatewaySettings.mjs` now persists `blindPeerEnabled`, keys, encryption key, and quota overrides with normalisation helpers.
3. **[Open]** Surface the new fields in the desktop UI/log feeds. *Guideline:* when rendering public-gateway settings, include blind-peer status and mirror keys so operators can confirm discovery data matches runtime.

### 4.2 Blind Peering Manager
1. **[Completed]** Implemented `hypertuna-worker/blind-peering-manager.mjs`, instantiating `BlindPeering` (with Hyperswarm fallback) and exposing `start/stop`, mirror helpers, and trusted-peer tracking.
2. **[Completed]** Worker bootstrap now starts the manager after Hyperdrive initialisation and reconfigures it whenever gateway status updates arrive.
3. **[Completed]** Logging and status events show mirror scheduling (`[BlindPeering] ...`); metrics integration can follow once GC stats land.
4. **[In Progress]** Multi-peer readiness: the manager accepts multiple keys but we still default to the gateway-hosted instance. Future work includes allowing manual additional mirrors and persisting local blind-peer credentials.

### 4.3 Obtaining Blind Peer Metadata
1. **[Completed]** Gateway handshakes/registrations update `PublicGatewaySettings` with blind-peer metadata which the worker then caches on receipt.
2. **[Completed]** Worker `GatewayService` listens to status events and pushes updates into the `BlindPeeringManager` (auto start/stop based on `blindPeerEnabled`).
3. **[Completed]** Worker now falls back to `/api/blind-peer` when handshake metadata is missing, caching the response and merging it with manual overrides.

### 4.4 Mirroring Relay & Autobase Cores
1. For each active `RelayManager` instance:
   - Gather core references: Autobase base core, writer cores (`base.local`, writers from `base.activeWriters`), views (`relay.view.core`, `relay.view.heads`, etc.).
  - On relay initialization (inside `hypertuna-relay-manager-adapter.mjs` or after `RelayManager.initialize()`), call `BlindPeeringManager.ensureRelayMirror({ relayKey, publicIdentifier, coreRefs, wakeupKey })`.
  - When the relay Autobase emits `update` events or rotates writers, reschedule mirrors immediately so the blind peer tracks new cores.
  - Use `announce: true` for high-availability datasets so blind peer advertises on DHT.
2. Store mapping between relay identifier → mirrored core keys so returning workers can request replication without scanning.

> **Status:** *Completed.* Relay mirror metadata now records writer/view core keys, Autobase subscriptions are detached on disconnect, and the worker issues `deleteCore` requests to drop stale mirrors when relays shut down.

### 4.5 Mirroring Hyperdrive Content
1. **[Completed]** `hyperdrive-manager.mjs` exposes `getCorestore`, `getLocalDrive`, and PFP helpers; the manager mirrors both primary and PFP drives on startup.
2. **[Completed]** Hyperdrive watch callbacks now reissue mirror requests and trigger refresh backoff when new content lands.
3. **[Completed]** Plan explicitly excludes other datasets until future phases.

### 4.6 Syncing From Blind Peers on Startup/Rejoin
1. During worker boot:
   - Before relay activation, call `BlindPeeringManager.refreshFromBlindPeers()` to request current versions of mirrored cores (passive mode).
   - Ensure local Hyperdrive & Autobase cores wait for catch-up (`core.update({ wait: true })`) before serving traffic.
2. On reconnection events (e.g., Hyperswarm handshake restored), re-run refresh if gateway indicates remote updates via wakeup events.
3. Provide throttled retry/backoff and surface errors (e.g., log when blind peer unreachable).

> **Status:** *Completed.* Startup and reconnect flows now refresh blind peers, wait on Hyperdrive/Autobase `core.update({ wait: true })`, and retry with bounded backoff before serving traffic.

### 4.7 Trusted Peer Handling
1. Ensure the Hyperswarm key pair used by `BlindPeering` matches the peer key registered with the gateway (share from `EnhancedHyperswarmPool` rather than random new pair).
2. Include worker public key in registration payload for clarity and confirm with gateway response that trust is in place; log mismatch if blind peer downgrades `announce`.
3. Support manual override (config option) to supply additional mirrors beyond the gateway’s blind peer for redundancy.

> **Status:** *Completed.* `PublicGatewaySettings` now persists `blindPeerManualKeys`, workers merge manual overrides with handshake metadata, and operators can manage extra mirrors via the settings API/CLI.

### 4.8 Shutdown & Cleanup
1. On worker shutdown, gracefully `await blindPeering.close()` to release connections.
2. Optionally issue `deleteCore` for ephemeral datasets (if worker flagged as owner and data should expire).

> **Status:** *Completed.* Worker shutdown and relay teardown now clear mirror metadata, unsubscribe Autobase hooks, and invoke `deleteCore` against blind peers for mirrors that are no longer needed.

- **[Open]** Extend registration store records (`public-gateway/src/stores/*`) to persist full blind-peer associations (e.g., mirrored cores, storage usage). Current implementation stores trust metadata per peer, but richer GC/accounting fields still need to be added for admin inspection.
- **[Completed]** Worker now persists `blind-peering-metadata.json` alongside mirror targets, keeping per-relay/per-drive summaries for offline recovery.
- **[Future]** Consider migrating to a shared metadata hyperbee (mirrored via blind peer) for multi-gateway setups once phase 1 stabilises.

## 6. Hygiene Strategy Details
- **Deduplication:** Use metadata map to detect identical core keys registered by multiple peers; keep one record, associate multiple owners for auditing, avoid duplicate storage.
- **Stale Data Criteria:** Remove cores if:
  - No owning relay is currently registered AND `lastActive` older than `staleCoreTtlMs`.
  - Core priority is low, and storage full; remove least-recently-active first.
- **Admin-Guided Retention:** Continue mirroring a relay’s cores while at least one admin remains assigned and the relay’s `lastActive` is within `staleCoreTtlMs`; drop the mirror once no admins remain after deletion.
- **Integrity Checks:** Track `digest` metrics; if `bytesAllocated` drifts from actual storage, run a rescan (open each core, compute `core.byteLength`).
- **Notification:** Emit events/metrics when GC deletes data so workers can detect and re-upload if needed.

> **Status:** *Open.* GC hooks are documented but not yet implemented. Plan to extend `BlindPeerService` with a periodic job that logs GC actions, increments Prometheus counters, and notifies workers (via status channel) when data is evicted.

## 7. Security & Access Control

### 7.1 Storage Protection & Key Rotation
- Prefer platform-managed disk encryption for the blind-peer storage volume (e.g., LUKS/FileVault/EBS encryption) to balance security and operational overhead.
- Harden filesystem permissions so only the gateway/blind-peer service account can read the RocksDB and Corestore directories.
- For environments requiring application-level encryption, wrap RocksDB files with libsodium-based streaming encryption; document performance impact and backup process.
- Rotate blind-peer swarming/encryption key pairs on a scheduled cadence: stand up a new key pair, distribute to trusted peers, migrate mirrors, then retire the old keys. Automate distribution via gateway configuration sync to workers. *Implementation note:* handshake payloads already transport keys; rotation tooling should reuse this channel.

### 7.2 Authentication for Non-Gateway Blind Peers
- **Pre-shared key allowlist:** simple configuration-driven trust but scales poorly and lacks revocation agility.
- **Mutual TLS tunnel:** strong transport guarantees but introduces PKI management overhead and complicates Hyperswarm connectivity.
- **Signed RPC token (recommended):** gateway issues short-lived HMAC/JWT tokens to approved external blind peers; tokens are presented via an initial RPC auth flow layered atop Hyperswarm key verification. Supports centralized revocation, auditability, and minimal operational friction.
- Phase 1 defers implementation/pruning of the external token auth handshake; design remains documented here for future phases while scope stays limited to the gateway-hosted blind peer.
- Implement the token flow alongside an allowlist of peer public keys, logging failed attempts and revoking tokens upon abuse or policy changes once multi-peer support is prioritized.

### 7.3 Operational Procedures

#### Key Rotation Runbook
1. Schedule rotation (e.g., quarterly) and capture existing blind-peer key fingerprints in an ops ticket.
2. Generate new swarming/encryption key pair on the gateway host; store secrets in the secure vault used for other gateway credentials.
3. Configure `BlindPeerService` to accept both old and new keys temporarily (dual-publish window) so connected workers continue replicating.
4. Distribute the new public keys to workers via the public gateway status channel and cached settings update; trigger workers to refresh their trusted peer list.
5. Monitor blind-peer metrics to confirm new key connections; once majority of workers switch, revoke the old keys and purge them from disk and configuration.
6. Document completion (timestamp, operator) and attach monitoring snapshots for auditability.

#### Token Issuance & Revocation (Future Phase)
1. Maintain a registry of approved external blind peers with contact info and Hyperswarm public keys.
2. When onboarding an external peer, generate a short-lived signed token (JWT/HMAC) using the gateway’s auth secret; encode peer ID, scope, expiry.
3. Deliver the token over an authenticated channel (e.g., encrypted email, secure portal) along with usage instructions and expiry reminders.
4. Log issued tokens in the ops system with expiry dates; set reminders to renew or revoke.
5. To revoke access, add the token ID to a deny list broadcast by the gateway and optionally rotate the underlying signing secret if compromise suspected.
6. Audit token issuance quarterly to ensure stale peers are removed before expanding multi-peer support.

## 8. Observability & Tooling
- **[Completed]** Added Prometheus gauges for active state, trusted peers, bytes allocated, and hygiene counters (`gateway_blind_peer_gc_runs_total`, `gateway_blind_peer_evictions_total{reason}`).
- **[Completed]** `/api/blind-peer` exposes structured hygiene + ownership summaries and logs every GC cycle; the `blind-peer-status` CLI (npm run `blind-peer:status`) wraps the endpoint for operators.
- **[Completed]** Admins can now trigger GC and delete mirrors via `/api/blind-peer/gc` and `/api/blind-peer/mirrors/:key`; the `blind-peer-status` CLI exposes `--gc` / `--delete-core` flags (e.g., `npm run blind-peer:status -- --gc --reason "maintenance"`).
- **[Completed]** Worker exposes a `get-blind-peering-status` control message that returns mirror metadata, backoff state, and the latest rehydration summary for diagnostics.

## 9. Testing Strategy
- **Unit tests — Completed:** Added coverage for the worker blind-peering manager and config normalisation; additional GC-specific mocks still required.
- **Integration tests — Completed:** Added dispatcher + blind-peer harness tests (`public-gateway/test/relay-dispatcher-events.test.mjs`) and worker-side mirror validation (`hypertuna-worker/test/blind-peering-manager.test.js`).
- **Regression suites — Completed:** CI now executes the new dispatcher event coverage alongside existing suites via `npm test` / `npm run test`.
- **Manual testing — Completed:** See `docs/blind-peer-manual-qa.md` for the expanded manual checklist (dispatcher assignment, CLI GC/delete, fallback recovery).

## 10. Deployment & Rollout
- **[In Progress]** Feature flag defaults remain disabled; turning the service on requires config updates documented above.
- **[Open]** Migration script/Docker volume instructions still outstanding—ensure blind-peer storage is a dedicated persistent volume with backup guidance.
- **[Open]** Publish operator comms/runbooks covering new metrics, key rotation, and troubleshooting steps.

## 11. Remaining Open Questions
- None at this time; revisit after phase 1 launch and operational review.

## 12. Phase 1 Progress & Next Steps

### 12.1 Completed Deliverables
- Gateway configuration layer, daemon wrapper, and handshake payloads now fully advertise blind-peer availability (`public-gateway/src/config.mjs`, `src/blind-peer/BlindPeerService.mjs`, `src/PublicGatewayService.mjs`).
- Worker runtime consumes blind-peer metadata, spins up the `BlindPeering` client, and mirrors local Hyperdrive + relay autobases (`hypertuna-worker/index.js`, `blind-peering-manager.mjs`).
- Gateway persists trusted peer state to disk, surfaces `/api/blind-peer` inspection data, and propagates trust metadata to registration stores; workers mirror the summary in their status snapshots.
- Metrics scaffolding and unit tests validate core lifecycle wiring (Prometheus gauges, Brittle suites for manager behaviour).
- Blind-peer hygiene loop now dedupes duplicate entries, prunes stale cores, enforces `maxBytes`, and reports Prometheus counters (`gateway_blind_peer_gc_runs_total`, `gateway_blind_peer_evictions_total{reason}`) with status surfaced via `/api/blind-peer`.
- Registration records now capture per-peer mirror summaries (`metadata.blindPeerMirrors`), `/api/blind-peer` exposes ownership statistics, and the `blind-peer-status` CLI provides on-demand inspection for operators.
- Worker blind-peering manager reuses the gateway swarm key, persists `blind-peering-metadata.json`, listens for Autobase/Hyperdrive updates, and applies exponential backoff when refreshing mirrors.
- Relay mirror lifecycle now tracks writer/view core keys, detaches Autobase listeners on disconnect, deletes blind-peer mirrors as relays are removed, and rehydrates local cores before serving traffic on startup or reconnect.
- Manual blind-peering overrides persist via `blindPeerManualKeys`, handshake fallbacks pull `/api/blind-peer`, and the CLI supports `--gc` / `--delete-core` admin actions.
- Gateway persists blind-peer ownership metadata to disk for auditability, and the worker exposes a `get-blind-peering-status` debug command with mirror health details.
- Dispatcher-driven assignments now update blind-peer metadata, emit automation events, and trigger worker-side rehydration when schedules change. Integration/regression harness coverage lives in `public-gateway/test/relay-dispatcher-events.test.mjs` and `hypertuna-worker/test/blind-peering-manager.test.js`.

### 12.2 Remaining Scope
- **Dispatcher telemetry & automated mirror tuning:** feed dispatcher health metrics back into blind-peer prioritisation and dispatcher policy adjustments.
- **Deployment readiness:** document migration/runbooks, add Docker volume setup, and communicate operational guidance (key rotation, monitoring, troubleshooting).

### 12.3 Recommended Sequencing
1. **Dispatcher-driven mirror orchestration:** integrate dispatcher/relay events with blind-peer requests and surface telemetry for automated flows.
2. **Integration tests & metadata hardening:** deliver automated gateway/worker tests covering mirror rehydration, metadata persistence, and eviction handling.
3. **Deployment readiness:** document storage/runbooks, finalize operator communications, and update QA checklists before enabling the feature by default.
