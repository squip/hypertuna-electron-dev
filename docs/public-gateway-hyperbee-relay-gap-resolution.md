# Public Gateway Hyperbee Relay Gap Resolution Requirements

## 1. Context & Gap Summary
- Gateway dispatcher assigns subscription work to workers, but `RelayWebsocketController` still forwards REQ frames over Hyperswarm, so the replicated Hyperbee in each worker is never queried locally (`public-gateway/src/relay/RelayWebsocketController.mjs`).
- Worker relay stack (`hypertuna-worker/hypertuna-relay-manager-bare.mjs`, `hypertuna-worker/hypertuna-relay-event-processor.mjs`) is Autobase-dependent. Pulling the gateway Hyperbee replica through those classes would disable sparse downloads and reintroduce multiwriter semantics the gateway must avoid.
- `PublicGatewayRelayClient` already mirrors the gateway Hyperbee (sparse replication, telemetry), but only exposes lifecycle hooks. There is no read API to satisfy Nostr filters from the replica (`hypertuna-worker/gateway/PublicGatewayRelayClient.mjs`).
- Dispatcher telemetry and assignment metadata do not currently surface Hyperbee freshness, so fallback decisions cannot distinguish between stale replica data and healthy availability.

## 2. Design Outcomes
1. Workers that receive dispatcher assignments must service REQ frames locally by querying their replicated Hyperbee while preserving sparse download behaviour.
2. Autobase-backed relay code remains untouched for peer-created relays; gateway-specific code paths must be isolated and feature-flagged.
3. Existing peer relay index layouts are reused verbatim, so no migration or schema changes are required for the gateway Hyperbee.
4. Local execution must report precise outcomes (hit, miss, stale replica, fallback) so the dispatcher and telemetry consumers can adapt routing.
5. Testing and tooling must validate Hyperbee-only execution against the same Nostr filter matrix currently exercised through Autobase relays.

## 3. Architectural Adjustments
- Introduce a **GatewayHyperbeeReader** utility responsible for executing Nostr filters against a Hyperbee instance without Autobase dependencies. It should accept filter arrays, produce canonical EVENT arrays, and expose diagnostics (match counts, consumed ranges, replica version).
- Extend `PublicGatewayRelayClient` to expose the underlying Hyperbee handle plus convenience readers while keeping replication duties encapsulated.
- Update the gateway websocket path so that when dispatcher assignments target the local worker, REQ frames use the reader directly. Legacy Hyperswarm forwarding remains as a fallback path only.
- Enrich dispatcher scheduling inputs/outputs with replica state (version, lag, staleness thresholds) so policy decisions can favour healthy replicas and degrade gracefully when stale.
- Add structured telemetry and logging for local Hyperbee execution to support observability and incident response.

## 4. Detailed Requirement Tasks

### 4.1 Gateway Hyperbee Reader Layer
1. **Module creation** – Add `hypertuna-worker/gateway/PublicGatewayHyperbeeReader.mjs` (name TBD) that:
   - Accepts a `Hyperbee` instance and optional index helpers.
   - Implements `query(filters, context)` returning `{ events, metrics, stale }`.
   - Supports filter features already handled in `NostrRelay.queryEvents` (kinds, ids, authors, time bounds, `#tag` selectors, limit/order options).
2. **Index compatibility** – Reuse existing key derivation helpers or factor common logic out of `hypertuna-worker/hypertuna-relay-event-processor.mjs` so both Autobase and Hyperbee-only readers produce identical index paths.
3. **Sparse safety** – Ensure queries rely on range scans and point lookups compatible with sparse replication (avoid `.download({ start: 0 })` patterns). Document any differences in behaviour vs Autobase reads.
4. **Error handling** – Distinguish between replica-not-ready, decode errors, and empty results to guide fallback decisions.
5. **Unit tests** – Create targeted tests (e.g. `hypertuna-worker/test/public-gateway-hyperbee-reader.test.mjs`) using temporary Hypercores to validate filter coverage and sparse semantics.

### 4.2 Worker Integration & Dispatch Flow
1. **Expose reader via client** – Extend `PublicGatewayRelayClient` with `getDb()`, `getVersion()`, and `createReader()` helpers. Maintain encapsulation of replication state and telemetry.
2. **GatewayService shortcut** – In `hypertuna-worker/gateway/GatewayService.mjs:214-360`, introduce a local execution path that:
   - Detects dispatcher assignments targeting the current worker by exposing the worker’s Hyperswarm public key (`config.swarmPublicKey`) to the service and comparing it with `decision.assignedPeer`.
   - Invokes the reader with REQ filters before invoking `forwardMessageToPeerHyperswarm`.
   - Streams results back through the websocket session using existing serialization helpers.
3. **Fallback triggers** – Define thresholds for fallback (e.g. replica lag > configured blocks, query flagged stale, reader throws). When triggered, continue using the Hyperswarm forwarding path.
4. **Session tracking** – Ensure subscription lifecycle bookkeeping (`session.assignPeer`, dispatcher acknowledgements) reflects whether the local worker or a remote peer ultimately serviced the request.
5. **Telemetry updates** – Augment `GatewayService.#collectTelemetrySnapshot` (current location near usage of `publicGatewayRelayClient.getTelemetry()`) with replica freshness metrics and last local query success/failure.

### 4.3 Dispatcher & Controller Enhancements
1. **Decision metadata** – Modify dispatcher job objects (`public-gateway/src/relay/RelayWebsocketController.mjs:62-119`) to include replica state (version, lag) so policy modules can prioritise ready replicas.
2. **Local execution hook** – Update `RelayWebsocketController.#handleReqFrame` to call a new `handleAssignedLocally` hook on the worker session when `assignedPeer` matches the local identity, instead of blindly calling `legacyForward`.
3. **Result acknowledgement** – Extend dispatcher acknowledgement payloads so local execution can mark jobs as `servedLocally`, including the event count and optional stale flag for adaptive routing.
4. **Feature flags** – Introduce configurable toggles (e.g. `publicGatewaySettings.gatewayReplica.enabled`, `forceLegacyForward`) to gate the new path, defaulting to off until validated.
5. **Test coverage** – Expand `public-gateway/test/relay-websocket-controller.test.mjs` to exercise local assignment handling, fallback scenarios, and dispatcher failure propagation.

### 4.4 Public Gateway Relay Host Alignment
1. **Schema audit** – Validate that Hyperbee event storage schema in the gateway host matches expectations of the new reader. Update `docs/public-gateway-relay-interface-contracts.md` with any additional fields required for sparse reads (e.g. index manifests).
2. **Replication metadata** – Ensure registration and discovery payloads include fields the worker needs to determine replica readiness (e.g. hyperbee `version`, replication topics). Update parsers in `PublicGatewayRegistrar` and `PublicGatewayDiscoveryClient` accordingly.
3. **Security & ACLs** – Confirm that write operations remain gateway-only; replication without Autobase (and without the writer’s secret key) already enforces single-writer behaviour, so focus on adding lightweight guards to catch accidental write attempts in the reader path.

### 4.5 Observability & Operations
1. **Metrics** – Define counters/timers for local Hyperbee query latency, hit rate, fallback count, and replica staleness. Integrate with existing metrics pipeline on both gateway and worker sides.
2. **Logging** – Add structured logs when local execution is used, including query summary (subscription id, filter kinds, event count) and replica status. Ensure sensitive data is redacted.
3. **Diagnostics tooling** – Provide CLI or admin endpoints to inspect replica status per worker (e.g. expose via existing telemetry channels or a new debug command).

### 4.6 Documentation & Rollout
1. **Requirements alignment** – Update `docs/public-gateway-relay-requirements.md` to incorporate the Hyperbee-only execution path and reference this gap-resolution plan.
2. **Developer docs** – Produce a HOWTO outlining how the reader works, expected schema, and troubleshooting steps for stale replicas.
3. **Runbooks** – Extend operational runbooks with verification steps (checking replica lag, forcing fallback) before enabling feature flags in production.
4. **Rollout plan** – Define staged rollout steps (test environment → canary worker → full fleet) with success metrics and rollback conditions.

## 5. Acceptance Criteria
- Workers assigned by the dispatcher serve REQ frames locally using the Hyperbee replica under default configuration, with successful test coverage across all supported Nostr filters.
- Sparse replication remains intact (verified via tests and telemetry showing partial block downloads during queries).
- Dispatcher metrics reflect local vs remote servicing, enabling tuning based on real replica performance.
- Legacy Autobase-based relay behaviour is unchanged when the new feature flag is disabled.

## 6. Dependencies & Open Questions
- Confirm exposure of the worker Hyperswarm public key inside `GatewayService` so the dispatcher’s `assignedPeer` value (the same key provided during registration) can be recognised as “local” when wiring the Hyperbee reader path.
- Assess whether additional access controls are needed to prevent peers from forging local execution acknowledgements.
- Validate compatibility with existing desktop clients that may assume REQ responses originate from Hyperswarm peers.
