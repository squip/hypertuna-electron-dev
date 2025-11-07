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
1. **WebSocket Relay Handler**
   - Update `RelayWebsocketController` to:
     - Check `BlindPeerReplicaManager` when no live peers exist.
     - Serve REQ frames by hitting the replica view (Hyperbee query) and streaming results.
     - Queue EVENT frames for local application if an escrow lease is active; otherwise reject writes with a NOTICE explaining the service is read-only while offline.
2. **HTTP Proxy Endpoints**
   - `/api/relays` POST: fallback to local replica for write operations only when an escrow lease is active; no gateway write occurs without escrow approval even if the relay is marked “public mirror writeable.”
   - `/drive/:identifier/:file`: read from local mirrored Hyperdrive when workers are offline, and, if the request is a write/upload, persist the file to the gateway-owned Hyperdrive writer (pfp or relay-specific). The gateway mirrors its Hyperdrive keys to the blind-peer service for durability so returning peers can replicate either directly from the gateway or from the blind-peer mirror during catch-up.
3. **Delegation Logic**
   - Ensure `EnhancedHyperswarmPool` still attempts workers first; fallback triggers should emit structured telemetry (reason, relayKey, leaseId).
4. **Worker Resync Flow**
   - When workers reconnect, they replicate the gateway-owned Hyperdrives (or their blind-peer mirrors) using the existing folder conventions, ingest pending uploads, and then resume ownership of future writes; the gateway tears down any temporary leases once replication completes.

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
