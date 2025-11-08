# Public Gateway Blind-Peer Replica & Autobase Escrow Implementation Plan

## 1. Objectives
- Allow the public gateway to service read/write requests when registered workers are offline by operating mirrored Autobase/Hyperdrive replicas sourced from blind-peer storage.
- Ensure any gateway-originated writes occur only when a worker has explicitly authorized a temporary writer key via a secure escrow workflow.
- Preserve the existing “peer-first” routing model so online workers continue to handle requests directly.

---

## 2. High-Level Architecture
1. **Worker Mirrors + Metadata**
   - Workers continue mirroring relay/hyperdrive cores into the gateway blind-peer service.
   - Each mirror call now supplies metadata (owner peer key, identifiers, type, announce flag, priority) so the gateway can map blind-peer cores back to relays/hyperdrives.

2. **BlindPeerReplicaManager (Gateway)**
   - New service colocated with `BlindPeerService`.
   - Opens mirrored cores from the blind-peer store, maintains Autobase + Hyperbee views, and exposes read/write helpers.
   - Emits readiness/lag metrics for each mirrored relay or drive.

3. **AutobaseKeyEscrow (Automated Policy)**
   - Separate microservice (or hardened module) that holds encrypted writer secrets.
   - Workers deposit a sealed “gateway writer package” (public key, encrypted secret, unlock policy, expiry).
   - Gateway requests releases when no healthy peers exist; the escrow service automatically validates unlock policies (peer liveness thresholds, mirror freshness, relay permissions) before returning the decrypted writer key (re-encrypted to a short-lived gateway session key).

4. **Request Routing Changes**
   - HTTP + WebSocket handlers keep the existing preference order:
     1. Forward to registered workers via Hyperswarm if any are healthy.
     2. If not, consult `BlindPeerReplicaManager` to fulfill REQ/EVENT flows against mirrored Autobase/Hyperdrive data.
     3. Writes require an active escrow lease; reads remain available if mirrors are present.

5. **Auditing & Rotation**
   - Every escrow release is logged (who unlocked, which relay, reason, expiry).
   - Workers rotate the gateway writer feed (and upload a new escrow package) after reconnecting.

6. **Gateway-Owned Hyperdrives for Offline Uploads**
   - Because blind peers cannot author new Hyperdrive blocks without writer keys, the public gateway maintains its own Hyperdrive writers (pfp + per-relay drives) using the same folder structure as worker instances.
   - When no workers are online, authenticated uploads land in the gateway-owned drives; once workers return, they replicate the gateway drive(s) (or their blind-peer mirrors) to ingest the pending files and keep state in sync.

---

## 3. Phase Breakdown & Task Stubs

### Phase 1 – Metadata & Mirror Enhancements ✅
1. **Worker Mirror Metadata** – *Completed*
   - `hypertuna-worker/blind-peering-manager.mjs` now attaches owner peer keys, identifiers, announce flags, and priority hints to every relay/hyperdrive mirror target.
   - Mirror metadata is persisted (and returned via the `blind-peering-status` IPC request) with the new fields so operators can audit pending mirrors even when workers are offline.
2. **Gateway Core Metadata** – *Completed*
   - `public-gateway/src/blind-peer/BlindPeerService.mjs` persists mirror metadata (including core types) and exposes readiness snapshots plus Prometheus metrics.
   - `/api/blind-peer` and the new `/api/blind-peer/replicas` endpoint surface per-identifier readiness, last-active timestamps, and lag windows.

#### Phase 1 Execution Tickets
- **BP-P1-01 – Worker Mirror Metadata Pipeline (Completed):** Annotate relay and hyperdrive mirror registrations with owner peer keys, identifier context, announce/priority hints, and persist the enriched metadata for debugging/rehydration flows.
- **BP-P1-02 – Gateway Mirror Index & Metrics (Completed):** Extend `BlindPeerService` to store identifier/owner mappings on disk, expose readiness APIs, and emit Prometheus gauges (`gateway_blind_peer_mirror_state`, `gateway_blind_peer_mirror_lag_ms`) for Grafana dashboards.

### Phase 1 Technical Overview
- Worker-side `BlindPeeringManager` now seeds every relay/hyperdrive mirror entry with the owner peer key (derived from the worker’s Hyperswarm identity), normalized identifiers, announce/priority hints, and timestamps. The enriched metadata is persisted to `blind-peering-metadata.json` and exposed through the existing `blind-peering-status` IPC channel for desktop diagnostics.
- Hyperdrive mirrors recorded by the worker tag the gateway-owned drive keys, enabling returning peers to discover pending uploads. Relay mirrors track both `relayKey` and `publicIdentifier`, keeping the blind-peer metadata portable when workers churn.
- `BlindPeerService` maintains a disk-backed inventory of mirrored cores, aggregates readiness snapshots per identifier/owner, and exposes them through `/api/blind-peer` and the new `/api/blind-peer/replicas` endpoint. The readiness snapshots power two new Prometheus gauges that Grafana consumes to visualize health and lag.

### Phase 2 – BlindPeerReplicaManager ✅
1. **Replica Manager Module** – *Completed*
   - Added `public-gateway/src/blind-peer/BlindPeerReplicaManager.mjs`, which hooks into the blind-peer Corestore, tracks relay/hyperdrive replicas, keeps an LRU cache of open cores, and exposes snapshots for downstream consumers.
2. **Lifecycle Integration** – *Completed*
   - `BlindPeerService` now emits `mirror-added`/`mirror-removed` events and exposes its underlying Corestore. The replica manager subscribes to these events, automatically seeds from existing metadata, and cleans up listeners on shutdown.
3. **Metrics & Health** – *Completed*
   - `/api/blind-peer/replicas` now returns replica metadata straight from the manager, and Prometheus tracks replica readiness via the new gauges introduced in Phase 1 plus the manager’s live snapshotting.

#### Phase 2 Execution Tickets
- **BP-P2-01 – BlindPeerReplicaManager Module (Completed):** Build the manager class, wire it to the blind-peer Corestore, maintain an LRU cache, and expose replica snapshots.
- **BP-P2-02 – Service Lifecycle Hooks (Completed):** Emit structured mirror events from `BlindPeerService`, surface the Corestore handle, and ensure the manager subscribes/unsubscribes cleanly.
- **BP-P2-03 – Replica Health Surfacing (Completed):** Update `/api/blind-peer/replicas` to read from the manager, ensuring operators can retrieve up-to-date readiness, lag, and cached-core information.

### Phase 2 Technical Overview
- `BlindPeerService` now publishes structured mirror events containing owner metadata, identifiers, priority hints, and timestamps, making it possible for auxiliary services to react instantly whenever the blind-peer daemon mirrors or evicts a core.
- The new `BlindPeerReplicaManager` consumes those events, stores per-identifier replica state (including owning peer, priority bounds, and lag), maintains bounded LRU caches of open cores, and can open the underlying hypercores on demand by reusing the blind-peer Corestore.
- Public Gateway startup wires the manager in automatically and exposes the aggregated state through `/api/blind-peer/replicas`, which now reflects the manager’s snapshot rather than re-synthesizing metrics on every request.

### Phase 3 – AutonbaseKeyEscrow Service (Automated Policy) ✅
1. **Service Definition** – *Completed*
   - Delivered the standalone AutobaseKeyEscrow service (`public-gateway/src/escrow`) with `/policy`, `/escrow`, `/escrow/unlock`, and `/escrow/revoke` endpoints, disk-backed escrow records, automated policy evaluation, and a Corestore-based audit feed for every deposit/unlock/revoke.
2. **Worker Integration** – *Completed*
   - Worker gateway settings now capture escrow configuration, the worker fetches policy snapshots, encrypts relay writer keys with the published escrow public key, and uploads deposits whenever relays register or writer keys rotate.
3. **Gateway Integration** – *Completed*
   - The public gateway boots an `AutobaseKeyEscrowCoordinator` that requests leases, decrypts writer packages in-memory, updates the `BlindPeerReplicaManager` lease state, exports Prometheus metrics, and exposes signed admin APIs for querying or manually requesting leases.
4. **Audit Trail** – *Completed*
   - All escrow actions append to the service’s audit Hypercore so operators can replay the history during incident response.

#### Phase 3 Execution Tickets
- **BP-P3-01 – AutobaseKeyEscrow Service & Policy Engine (Completed):** Implemented service bootstrapper, persistent store, Hypercore audit log, policy evaluation, and signed HTTP surface.
- **BP-P3-02 – Worker Escrow Deposits (Completed):** Worker GatewayService consumes escrow policy, encrypts writer packages, automatically deposits per relay, caches deposit metadata, and includes escrow state within HTTP registrations.
- **BP-P3-03 – Gateway Escrow Coordinator & APIs (Completed):** Added escrow coordinator, Prometheus metrics, replica-manager lease tracking, and signed `/api/escrow/leases/*` admin endpoints for manual inspection/lease triggering.

### Phase 3 Technical Overview
- **Escrow microservice:** `public-gateway/src/escrow/AutobaseKeyEscrowService.mjs` manages encrypted deposits, enforces automated unlock policies (peer liveness + mirror freshness), and writes an append-only Hypercore audit log. `public-gateway/src/escrow/index.mjs` boots the service for standalone deployments.
- **Worker pipeline:** `hypertuna-worker` now persists escrow settings, fetches policy via `AutobaseKeyEscrowClient`, encrypts relay writer keys through the shared NaCl helper, and attaches escrow metadata to `/api/relays` registrations so the gateway knows which relays are escrow-enabled.
- **Gateway coordinator:** `AutobaseKeyEscrowCoordinator` requests unlocks when instructed (currently via signed admin APIs), decrypts leases via ephemeral session keys, updates `BlindPeerReplicaManager` writer lease flags, and records metrics (`gateway_escrow_unlock_requests_total`, `gateway_escrow_leases_active`). Manual ops endpoints (`/api/escrow/leases/query` and `/api/escrow/leases/:relayKey/request`) reuse the shared secret signature scheme for trust parity with registration flows.

### Phase 4 – Request Routing Updates
1. **WebSocket Relay Handler – Completed**
   - Extend `RelayWebsocketController` so every session performs a “peer sweep” before falling back: try each usable peer from `#getUsablePeersFromRegistration` exactly once; a single failure/timeout per peer immediately counts as a miss so we can enter replica mode without extra retries and keep GET latency low.
   - When replica mode is triggered, attach a `BlindPeerReplicaManager` session handle so REQ frames run against the mirrored Hyperbee view (streaming `EVENT` + `EOSE` locally).
   - EVENT frames use the same path, but the controller now enforces escrow: if `AutobaseKeyEscrowCoordinator.getLease(relayKey)` returns null, reply with `NOTICE` (“read-only while workers offline”); otherwise apply the event via the replica session using the leased writer key, wipe the key when finished, and emit `OK`.
   - Emit structured telemetry (`gateway_relay_fallback_reads_total`, `gateway_relay_fallback_writes_total` with `{relay, mode}` labels plus histogram gauges for replica duration) whenever a session switches between peer and replica paths; lease ids stay in logs to control metric cardinality.
2. **HTTP Proxy + Gateway Hyperdrives – Completed**
   - Replicate the worker’s REST surface inside the gateway (`/drive/:identifier/:file`, `/pfp/:file`, `/pfp/:owner/:file`, `/post/join/:identifier`, finalize-auth callbacks, etc.) so clients see identical behavior whether a worker or the gateway answers.
   - Introduce a `GatewayHyperdriveManager` that mirrors the worker’s folder structure under a dedicated root (e.g., `<storageDir>/gateway-drives/<relayKey>/…`) while exposing the same paths so URLs stay portable. The gateway-owned drives are mirrored into the blind-peer service for durability.
   - Reads hit Hyperswarm peers first; if a stream errors or stalls, the gateway immediately replays the request against the mirrored Hyperdrive (pfp or per-relay) and serves the file locally.
   - Authenticated uploads (drive writes, `/post/join` payload persistence, callback data) write straight into the gateway-owned Hyperdrive when workers are offline; existing gateway auth tokens remain the gate (no new scopes/quotas). Autobase writes still require escrow. All gateway writes are logged with relayKey + requester so ops know what was accepted while peers were offline.
3. **Delegation Logic & Telemetry – Replica Path Completed (Hyperswarm metrics pending)**
   - Keep `EnhancedHyperswarmPool` as the “peer-first” router but add explicit fallback events: each failed peer attempt includes reason + latency, and a single `fallback` record is emitted when replica mode starts. When a peer recovers, the session exits replica mode and telemetry records the duration spent serving locally.
   - Metrics: peer sweep attempts, fallback duration histograms, `gateway_relay_fallback_{reads,writes}_total{relay,mode}`, gauges for active replica sessions and `gateway_pending_writes{relay}`. These power Grafana alerts when replicas become the primary serving path without exploding label cardinality (lease ids stay in structured logs only).
4. **Worker Resync Flow**
   - When the gateway performs offline writes, it marks the affected relay in the registration payload (e.g., `metadata.gatewayPendingWrites = true`, `metadata.gatewayDriveVersion = <seq>`). Blind-peer replica snapshots should include the same flag so workers see the status even before HTTP registration.
   - As soon as the gateway records an offline write it also pushes a `/gateway/pending-writes` control message over the existing Hyperswarm channel to every registered worker for that relay (mutual Hyperswarm identity is sufficient auth). The payload includes relay key, pending types (`autobase`, `drive`), drive key/version, and (if applicable) escrow lease metadata so workers can resync immediately without polling.
   - Workers replicate the gateway-owned Hyperdrive (or its blind-peer mirror) and stream Autobase deltas until the pending indicator clears locally, then call `POST /api/relays/:relayKey/resync-complete` to acknowledge. The gateway releases the escrow lease, clears the pending flags, emits a follow-up push (“pending-cleared”), and workers rotate writer keys + upload fresh escrow packages. All transitions are logged/audited so operators can verify that gateway-written state has been absorbed.
   
#### Phase 4 Technical Overview – Replica Fallback (Completed)
- Added `AutobaseReplicaSession` plus an enhanced `BlindPeerReplicaManager` so the gateway can open Autobase/Hyperbee mirrors straight from blind-peer storage, hydrate active escrow leases, and reuse long‑lived sessions across fallback requests.
- Reworked `RelayWebsocketController` to run a single peer sweep before falling back, serve REQ/EVENT frames from replica sessions, and enforce escrow for EVENT writes; structured logs capture every fallback transition.
- Introduced replica-specific Prometheus metrics (`gateway_relay_fallback_{reads,writes}_total{relay,mode}`, `gateway_relay_replica_sessions`, `gateway_relay_fallback_duration_seconds`) so Grafana dashboards can alarm when replica usage spikes.

#### Phase 4 Technical Overview – Gateway Hyperdrive Surface (Completed)
- Implemented `GatewayHyperdriveManager`, a namespaced Corestore/Hyperdrive wrapper that keeps per-relay drives plus a shared PFP drive under `<storageDir>/gateway-drives`, mirrors new blocks into the blind-peer service, and exposes typed helpers (`readRelayFile/writeRelayFile`, `readPfpFile/writePfpFile`) for the rest of the gateway.
- Ported the worker HTTP surface (`/drive`, `/pfp`, `/post/join`, `/callback/finalize-auth`) and layered in fast fallbacks: drive/PFP reads now drop to the gateway hyperdrive whenever peer fetches fail, while uploads immediately land in gateway-owned drives (behind the existing relay tokens) and are logged + marked so workers know to resync.
- Added HTTP artifact persistence so join + callback submissions are captured as JSON envelopes inside the relay’s gateway drive when no peers are online; every stored artifact raises `gatewayPendingWrites`, feeds the blind-peer mirrors, and produces audit logs for later replay.

#### Phase 4 Group 3 – Push Notifications & Worker Resync (Remaining Work)
1. **G3-S1 – Gateway Pending Write Push Service**
   - When the gateway logs the first offline write for a relay, fan out a `/gateway/pending-writes` control message over the Hyperswarm protocol to every currently connected worker for that relay (payload: relay key, drive identifier, pending types, drive version, escrow lease id, reason).
   - Track per-relay notification state (last push timestamp, retries) and keep retrying at a fixed cadence until at least one worker acknowledges or the pending flag clears; emit a “pending-cleared” push when resync completes.
   - Surface metrics/logs for push successes, retries, and time-to-ack.

   **Ticket 1 – Completed:** `#markGatewayPendingWrites` now normalizes reason buckets, tracks the set of pending write types, stores the originating drive identifier/version, and stamps metadata with first/last update timestamps (`public-gateway/src/PublicGatewayService.mjs`). These updates drive a new `gateway_pending_writes{relay}` Prometheus gauge plus push attempt counters and wait-time histograms (`public-gateway/src/metrics.mjs`), ensuring dashboards immediately reflect which relays are being served from gateway replicas.

   **Ticket 2 – Completed:** `GatewayHyperdriveManager.writeRelayFile` now returns the relay drive’s key, discovery key, version, and core/blob length stats; `#storeGatewayDriveUpload` and `#persistGatewaySubmission` pass those values into `#markGatewayPendingWrites`, so `gatewayDriveVersion` reflects the actual Hyperdrive version rather than a timestamp surrogate.

   **Ticket 3 – Completed:** Added `GatewayPendingWritePushService`, a retrying dispatcher that builds `/gateway/pending-writes` payloads (including drive version + lease metadata), resolves healthy peers via Hyperswarm, and pushes `state: pending` / `state: cleared` notices until a worker acknowledges or the flag clears. The service ties into the new metrics, supports future ack hooks, and automatically triggers whenever `#markGatewayPendingWrites` or the resync completion handler updates metadata.

2. **G3-S2 – Worker Push Handler & Resync Executor**
   - Register a `/gateway/pending-writes` handler inside `GatewayService` to accept the Hyperswarm push, validate it, and enqueue a resync job (Autobase catch-up via blind-peer + Hyperdrive mirror via gateway-owned drive).
   - Provide progress telemetry so operators can see when a relay is ingesting gateway-owned state.
   G3-S2 – Worker Push Handler & Resync Executor

Ticket 1 – **Completed:** Extend the Hyperswarm protocol surface so `/gateway/pending-writes` requests are accepted regardless of server/client role (update `hypertuna-worker/gateway/GatewayService.mjs (lines 1579-1592)`) with signature/peer validation, dedupe per relayKey, and emit structured events before acking the gateway.
Ticket 2 – **Completed:** Added a worker-side `PendingWriteCoordinator` that subscribes to the gateway’s control events via `GatewayService`, persists per-relay pending metadata/lease info, maintains a queued/in-flight job view, and feeds that telemetry back through the existing gateway/public-gateway status emitters so operators can track resync backlog from the desktop UI (`hypertuna-worker/index.js` + `gateway/PendingWriteCoordinator.mjs`).
Ticket 3 – **Completed:** Hyperdrive resync executors now pull `/gateway/pending-writes` jobs from the worker’s `PendingWriteCoordinator`, resolve the gateway-owned drive identifier, invoke `ensureRemoteMirror` / `ensureRelayFolder` to mirror the drive into the worker’s Hyperdrive, and update the coordinator state so operators can see queued/in-flight/finished jobs from the desktop UI.
Ticket 4 – **Completed:** Autobase catch-up now leverages the blind-peer mirrors (via `hypertuna-worker/blind-peering-manager.mjs` refresh/rehydrate helpers) so each queued job rehydrates the relay’s Autobase before completion; pending-write telemetry flows through the coordinator, giving operators visibility into queued/in-flight Autobase resyncs.

3. **G3-S3 – Resync Completion & Escrow Rotation**
   - Once the worker drains the resync queue it calls `POST /api/relays/:relayKey/resync-complete`, the gateway clears metadata flags, sends the “pending-cleared” push, and releases any outstanding escrow lease.
   - Worker rotates writer keys, deposits a fresh escrow package, and updates registration metadata so future fallbacks know the new owner key.

   G3-S3 – Resync Completion & Escrow Rotation

   **Ticket 1 – Completed:** The worker-side pending write processor now signs `{ relayKey, action: 'resync-complete' }` using the configured gateway shared secret and POSTs to `/api/relays/:relayKey/resync-complete` as soon as Autobase + drive resync jobs finish (`hypertuna-worker/index.js`). The gateway consumes the request (`public-gateway/src/PublicGatewayService.mjs`), clears all pending metadata, resets metrics, and unlocks the escrow lease.
**Ticket 2 – Completed:** When the gateway accepts a resync completion it immediately invokes `GatewayPendingWritePushService` with `state: 'cleared'`, broadcasting the update to online workers while releasing any outstanding escrow lease (`public-gateway/src/PublicGatewayService.mjs`). This keeps peer replicas and dashboards in sync without polling.
**Ticket 3 – Completed:** After the worker finishes resyncing, it now calls `GatewayService.rotateGatewayWriter(relayKey)` which forces a new escrow deposit (skipping cached leases) via `#syncPublicGatewayRelay` with `forceEscrowRefresh`. This refreshes the escrow package/registration metadata so any future gateway fallback requires the rotated writer credentials (`hypertuna-worker/index.js`, `hypertuna-worker/gateway/GatewayService.mjs`).

4. **G3-S4 – Documentation & Runbooks**
   - Document the push payload schemas, retry behaviour, worker resync lifecycle, and operational commands for forcing/inspecting pending writes.

   G3-S4 – Documentation & Runbooks

Ticket 1 – Update docs/public-gateway-autobase-escrow-plan.md (and, if needed, docs/blind-peer-integration-plan.md) with the /gateway/pending-writes payload schema, retry cadence, ack expectations, metrics names, and the lifecycle diagram covering gateway ↔ worker interactions when peers go offline.
  - **Completed:** Added documentation of the `/gateway/pending-writes` payload (`state`, `relayKey`, `driveIdentifier`, `driveVersion`, `types[]`, `lease{}`), outlined the jittered exponential backoff (15s → 5m) plus ack expectations, and referenced the new metrics (`gateway_pending_writes`, `gateway_pending_write_push_total`, `gateway_pending_write_push_wait_seconds`) and desktop telemetry streamed via `gateway-pending-writes` events so operators can trace the full workflow end-to-end.
Ticket 2 – Add an operational playbook (new doc under docs/ or an appendix to the existing plan) that walks through forcing pending writes, monitoring resync progress, manually clearing stuck jobs, and rotating escrow writers so SREs have deterministic recovery steps.
  - **Completed:** Added `docs/pending-writes-runbook.md`, covering inspection steps, forcing pending writes, monitoring the worker coordinator/Prometheus metrics, clearing stuck jobs, and manually triggering escrow-backed writer rotations end-to-end.

### Phase 5 – Governance, Security & Testing
1. **Key Handling & Storage**
   - Ensure unlocked writer keys remain in-memory only; add zeroization utilities and crash-safe guards.
   - Enforce TLS + mTLS between gateway and escrow service.
2. **Rotation Flows**
   - On worker reconnect, automatically revoke the outstanding escrow lease and force a writer rotation (remove old writer, add new one, upload new escrow payload).
3. **Escrow Storage Backend**
   - Back the escrow service with Postgres to gain transactional guarantees for deposits/unlocks, durable audit logging, and straightforward schema migrations; use row-level encryption or Vault integration for sealed payloads.
4. **Testing**
   - Integration tests:
     - Worker registers → mirrors → gateway fallback read.
     - Escrow unlock success/failure under automated policy rules (healthy-peer edge cases, stale mirrors).
     - Writer rotation and revocation.
   - Chaos testing for partial failures (escrow offline, blind-peer GC, corrupted metadata).
5. **Documentation & Runbooks**
   - Publish operational docs covering escrow policies, fallback behavior, manual overrides, and monitoring dashboards.
6. **Observability**
   - Export Prometheus metrics (mirror readiness, lease counts, policy rejections) and ship a Grafana dashboard package so operators can visualize blind-peer health, escrow unlock trends, and Hyperdrive fallback activity.

#### Phase 5 Group 1 – Secrets & Transport Hardening
1. **G1-S1 – Writer Key Vaulting & Zeroization**
   - Expand `shared/escrow/AutobaseKeyEscrowCrypto.mjs` with secure buffer helpers plus `withZeroizedBuffer` utilities, then plumb them through `public-gateway/src/escrow/AutobaseKeyEscrowService.mjs`, `public-gateway/src/escrow/AutobaseKeyEscrowCoordinator.mjs`, `public-gateway/src/blind-peer/BlindPeerReplicaManager.mjs`, `public-gateway/src/replica/AutobaseReplicaSession.mjs`, and `hypertuna-worker/gateway/GatewayService.mjs` so decrypted writer packages never hit disk/logs.
   - Introduce a dedicated in-memory `LeaseVault` that tracks active secrets, redacts payloads from metrics/logs, and registers crash hooks (`SIGINT`, `SIGTERM`, `uncaughtException`) to zeroize buffers before exit.
   **Ticket BP-P5-01 (Completed):** Added `withZeroizedBuffer`/`toSecureBuffer` helpers plus a crash-safe `LeaseVault`, refactored the escrow service, gateway coordinator, replica sessions, and worker escrow attachment builder to hydrate writer secrets via secure buffers, and shipped tests proving that only digests flow through metrics/logs.
   **Ticket BP-P5-02 (Completed):** Replaced the remaining in-memory lease maps with the shared `LeaseVault` (gateway coordinator + escrow microservice), added redacted `/api/escrow/leases` responses that surface only digests/owner metadata, and wired crash/expiry hooks so secrets are zeroized on signal or TTL expiry.

2. **G1-S2 – Escrow TLS + mTLS Enforcement**
   - Add TLS configuration (server cert/key, CA, mandatory client certs) to `public-gateway/src/escrow/config.mjs`, switch the escrow entrypoint to `https.createServer`, and support certificate hot-reload.
   - Extend `shared/escrow/AutobaseKeyEscrowClient.mjs` so gateway + worker clients can supply pinned CAs and client cert/key pairs, with new env vars (`ESCROW_TLS_CA`, `ESCROW_TLS_CLIENT_CERT`, `ESCROW_TLS_CLIENT_KEY`) threaded through `public-gateway/src/config.mjs` and `hypertuna-worker/gateway/GatewayService.mjs`.
   - Reuse the existing Traefik/Let’s Encrypt automation from `docker-compose.yml` by minting a dedicated CA bundle for the escrow service and distributing short-lived client certs to gateway + worker containers during compose boot.
   **Ticket BP-P5-03 (Completed):** Escrow now terminates HTTPS with mandatory client certs (auto-reloading cert/key/CA files on change), the shared escrow client moved to a native HTTP(S) stack that accepts pinned CA + client certs, and both the gateway + worker processes honor the new `ESCROW_TLS_*` env paths when instantiating their Autobase escrow clients.

#### Phase 5 Group 2 – Postgres Escrow Backend
1. **G2-S1 – Database Plumbing & Schema**
   - Introduce a Postgres client wrapper (based on `pg`) plus a migration CLI under `public-gateway/src/escrow/db`, driven by `ESCROW_DATABASE_URL`, pool sizing, and statement timeouts.
   - Ship an initial migration that creates `escrow_deposits`, `escrow_lease_history`, and `escrow_audit_log` tables with `pgcrypto`-encrypted columns, unique indexes on `relay_key`, and retention policies.
   - Bundle Postgres inside the `public-gateway` Docker container (bootstrapped during `docker compose up`) and auto-install required extensions so admins only need to set env vars.
   **Ticket BP-P5-04 (Completed):** Added a container-local Postgres runtime (managed by `bin/start.sh`) that provisions users/db + pgcrypto automatically, introduced the `pg`-based migration runner (`npm run escrow:migrate`) with the initial schema under `src/escrow/db/migrations/`, and wired `deploy/docker-compose.yml`/config/env defaults so `docker compose up` boots Postgres, applies migrations, and exposes `ESCROW_DATABASE_URL` without manual steps.

2. **G2-S2 – Store/Audit Refactor**
   - Replace the JSON-backed `AutobaseKeyEscrowStore`/`AutobaseKeyEscrowAuditLog` with Postgres repositories that wrap all writes in transactions, store sealed packages as ciphertext blobs, and surface pagination/filter APIs.
   - Update `AutobaseKeyEscrowService` to depend on the new repositories, wire in retry/backoff logic, and emit structured metrics for DB latency/errors.
   **Ticket BP-P5-05 (Completed):** Implemented the Postgres-backed store, audit log, and lease-history repositories (with automatic fallback to the legacy JSON files when `ESCROW_DATABASE_URL` is absent), updated `AutobaseKeyEscrowService` to hydrate them behind a feature flag, and now persist every deposit/lease/audit event inside the gateway’s Postgres instance while still supporting the older on-disk mode for local/dev runs.


#### Phase 5 Group 3 – Rotation & Governance Automation
1. **G3-S1 – Worker Reconnect Drives Rotation**
   - Detect worker reconnects/registrations inside `hypertuna-worker/gateway/GatewayService.mjs`, automatically revoke outstanding leases via the escrow `/revoke` API, and push a fresh escrow deposit before the worker resumes servicing requests.
   - Persist rotation metadata (previous lease id, rotation cause, timestamp) inside the worker status snapshot so desktop diagnostics surface the latest writer handshake.
   **Ticket BP-P5-07 (Completed):** GatewayService now auto-rotates every relay’s writer key whenever the worker reconnects (and after pending-write resync jobs) by revoking the old escrow lease, forcing a fresh deposit, and re-registering the relay. Each rotation is tracked per relay, emitted as a `gateway-escrow-rotation` event, persisted via `PendingWriteCoordinator`, and surfaced through the worker status/desktop UI with attempt counts, timestamps, and failure details for retry telemetry.

2. **G3-S2 – Gateway Lease Health Monitor**
   - Add a `LeaseHealthMonitor` inside `public-gateway/src/PublicGatewayService.mjs` that correlates worker health, replica lag, and escrow leases; it should release leases when peers return, prevent fallback writes without leases, and escalate when leases near expiry.
   - Expose operator endpoints (`GET /api/escrow/leases/query`, `POST /api/relays/:relayKey/escrow/revoke`) plus structured logs so manual overrides remain auditable.
   **Ticket BP-P5-08 (Completed):** Implemented the LeaseHealthMonitor inside `PublicGatewayService` (tracking lease issuance/release, peer recovery, and expiry warnings), enforced escrow leases for every gateway-drive write, introduced the new operator endpoints (`GET /api/escrow/leases/query`, `GET /api/escrow/leases`, and `POST /api/relays/:relayKey/escrow/revoke`), and wired the telemetry into the worker/pending-write pipeline so rotations and lease status are visible in the desktop UI.

3. **G3-S3 – Rotation Audit & Notifications**
   - Emit audit entries for every issuance/revocation/rotation, forward them both to the Postgres audit log and to `GatewayPendingWritePushService` so workers receive `leaseVersion` info alongside pending-write payloads.
   - Highlight “gateway lease active” state in `/api/blind-peer/replicas` and worker telemetry to make fallbacks transparent.
   **Ticket BP-P5-09 (Completed):** Added lease-version tracking on the gateway (surfaced via `/api/blind-peer/replicas`, `GatewayPendingWritePushService`, and worker telemetry), extended the pending-write push payloads + desktop dashboard to show lease health, wired escrow lease/audit hooks (including Postgres audit entries for releases), and exposed a new `gateway_escrow_rotation_total{reason,result}` Prometheus counter so operators can explain every fallback/rotation event.

#### Phase 5 Group 4 – Observability & Alerting
1. **G4-S1 – Prometheus Metrics**
   - Export new gauges/counters: `escrow_unlock_total{result}`, `escrow_policy_rejections_total{reason}`, `escrow_active_leases`, `gateway_replica_fallback_total{mode}`, and lease lag histograms from gateway + worker processes.
   - Include mirror freshness + escrow latency stats so Grafana can alarm on stuck leases or stale replicas.
   **Ticket BP-P5-10 (Completed):** Added first-class Prometheus exporters across the stack: the escrow microservice now exposes `/metrics` with `escrow_unlock_total{result}`, `escrow_policy_rejections_total{reason}`, `escrow_active_leases`, and `escrow_unlock_duration_seconds`; the public gateway exports `gateway_replica_fallback_total{mode}`, `gateway_escrow_policy_rejections_total`, and `gateway_escrow_lease_lag_seconds` in addition to the per-relay gauges we already had; worker telemetry streams lease-lag samples so dashboards and the desktop pending-write panel can highlight stuck resyncs. These signals feed the Grafana panels/alerts covering mirror freshness, fallback usage, and escrow latency thresholds.

2. **G4-S2 – Alerting & Dashboards**
   - Publish Grafana dashboards/alert rules (Terraform/jsonnet bundles) covering blind-peer health, escrow unlock trends, Postgres saturation, and fallback write volume.
   - Define alerts for “fallback write without lease”, “lease expiry in <60s”, and “policy rejections spike”.
   **Ticket BP-P5-11 (Completed):** Added `deploy/observability/` with two pre-built Grafana dashboards (gateway + escrow/worker) plus `prometheus-alerts.yaml` that fires on fallback writes without leases, impending lease expiry (<60s), and escrow policy rejection spikes. The dashboards visualize blind-peer lag, fallback rates, pending-write latency, and unlock durations using the new metrics introduced in BP-P5-10 (e.g., `gateway_replica_fallback_total`, `gateway_escrow_lease_time_to_expiry_seconds`, `escrow_policy_rejections_total`). README instructions cover importing the dashboards and wiring the alerts into Prometheus/Grafana deployments.

#### Phase 5 Group 5 – Testing, Chaos & Runbooks
1. **G5-S1 – Integration Harness**
   - Build an automated harness that spins up worker, gateway, blind-peer mocks, the escrow service, and Postgres (via docker-compose or `pg-mem`) to validate worker-register → mirror → gateway fallback → rotation flows.
   - Cover unlock success/failure, stale mirrors, policy rejections, and lease revocation edge cases.
   **Ticket BP-P5-12 (Pending):** Add `public-gateway/test/escrow.integration.test.mjs`, supporting fixtures, and a CI job that runs the suite with coverage reports.

2. **G5-S2 – Chaos & Failure Drills**
   - Provide scripts that kill the escrow service, drop Postgres connections, corrupt deposits, or pause blind-peer mirroring, then verify that policy enforcement halts gateway writes until issues resolve.
   - Capture the recovery telemetry and feed it into `test-logs/` for regression analysis; execution automation can be deferred (design hooks now, wire CI/staging later).
   **Ticket BP-P5-13 (Deferred):** Implement `test/chaos/escrow-failures.mjs`, keep it runnable locally, and schedule CI/staging automation in a follow-up milestone.

3. **G5-S3 – Documentation & Runbooks**
   - Extend `docs/pending-writes-runbook.md` and add `docs/escrow-operations.md` describing escrow policies, rotation workflows, certificate renewal, Postgres migrations, and troubleshooting drills.
   - Embed lifecycle diagrams showing how blind-peer replicas, escrow leases, and worker resync interact when peers churn.
   **Ticket BP-P5-14 (Completed):** Published the updated runbook plus the new `docs/escrow-operations.md` (covering topology, rotation workflows, TLS renewal, Postgres tasks, and lifecycle diagrams). The runbook now references the new metrics (`gateway_escrow_lease_lag_seconds`, `gateway_escrow_lease_time_to_expiry_seconds`) and the Grafana/alert assets so operators can follow a single source for pending-write remediation.

---

## 4. Technical Requirements Summary
| Area | Requirement |
| --- | --- |
| Worker Mirrors | Include structured metadata in blind-peering calls; persist locally for debugging. |
| Gateway Metadata | Track mirror ownership, identifiers, timestamps, and expose status via API/metrics. |
| Replica Manager | Ability to open Autobase/Hyperbee from blind-peer storage, serve queries, and apply writes with leased keys. |
| Escrow Service | Secure storage of encrypted writer keys, policy enforcement, unlock/revoke APIs, audit logging. |
| Escrow Storage | Postgres-backed metadata/audit store with transactional guarantees and optional row-level encryption. |
| Routing Logic | Peer-first delegation with local fallback for both WebSocket and HTTP flows; clear error messaging when writes aren’t permitted. |
| Security | mTLS between gateway and escrow, in-memory key handling, audit trails, rotation on reconnect. |
| Observability | Prometheus metrics feeding Grafana dashboards for mirror readiness, fallback usage, escrow unlocks, and lease expirations. |
| Testing | Automated coverage for escrow lifecycle, fallback routing, metadata persistence, and failure scenarios. |

---

## 5. Key Decisions
1. **Global Automated Policy:** Unlock criteria remain uniform across relays—no per-relay overrides in v1.
2. **Escrow Required for All Writes:** The public gateway never performs Autobase or Hyperdrive writes without an active escrow lease, even for “public mirror” relays.
3. **Hyperdrive Fallback Strategy:** Gateway-owned Hyperdrive writers accept uploads when workers are offline; their keys are mirrored to blind peers for durability, and returning workers replicate those drives to ingest pending files.
4. **Escrow Storage Backend:** Postgres provides the durable metadata store for escrow payloads, audit logs, and policy state.
5. **Observability Stack:** Prometheus metrics feed standardized Grafana dashboards for monitoring mirror readiness, escrow unlocks, and fallback activity.
