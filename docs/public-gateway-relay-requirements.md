**Goal**

- Deliver requirements for adapting the public gateway to run a single-writer Hyperbee relay replicated to peers.
- Preserve admin write authority while enabling network nodes to read and publish through wss://relay.hypertuna.com.
- Keep the gateway relay as the default discovery relay used by the individual peer nostr clients, while also supporting the other public discovery relay URLs used by the desktop client codebase.
- Enumerate codebase touchpoints and tasks needed to integrate the solution end to end.

**Constraints**

- Gateway relay must drop Autobase integration so peers never gain direct multiwriter rights (hypertuna-worker/hypertuna-relay-helper.mjs:1 shows current Autobase inheritance pattern).
- Hyperbee sparse downloading should remain intact; replication logic must avoid forcing full state syncs (see docs in holepunchto-documentation/hyperbee-API-docs.md:1).
- Existing worker relays still require Autobase; changes must not regress them (hypertuna-worker/hypertuna-relay-manager-bare.mjs:101).
- Solution must operate within current discovery, registration, and token flows without breaking deployed peers.

**Architecture**

- Introduce a HyperbeeRelayHost service inside the public gateway to manage the writable Hyperbee core and provide websocket-backed Nostr semantics (public-gateway/src/PublicGatewayService.mjs:25 is the hosting surface).
- Expose replication endpoints over Hyperswarm so peers sync the Hyperbee via sparse reads while maintaining live websocket feeds.
- Delegate REQ filtering to whichever peer (including the gateway) is best positioned to serve data, with routing metadata stored alongside subscription state.
- Extend registration payloads and discovery broadcasts to distribute the relay Hyperbee public key plus relay URL so peers can bootstrap replication.
- Layer a load-aware subscription dispatcher that favours healthy, low-latency peers while capping concurrent jobs per peer (reuse PeerHealthManager metrics in hypertuna-worker/gateway/GatewayService.mjs:198 and extend with rolling in-flight counts).
- Maintain clear separation between the new gateway-only relay host and the existing Autobase-enabled worker relays. The gateway implementation must live under public-gateway/src, with shared utilities promoted into shared/ only when they are truly common.
- Define explicit interfaces for: (1) Hyperbee storage driver (open/close/replicate), (2) websocket relay server (ingest/publish/ack), (3) dispatcher coordination (assign/reassign/failover), and (4) telemetry bus. Each interface should hide implementation details from dependents and enable future unit testing with mocks.
- Persist gateway relay configuration (keys, discovery key, scheduler parameters, token policy) through typed config objects so changes can be rolled out gradually and validated at startup.

**Gateway Work**

- Implement gateway-side Hyperbee lifecycle (corestore setup, Hyperbee instance, replication wiring) and embed it into the startup path of PublicGatewayService (public-gateway/src/PublicGatewayService.mjs:25).
- Replace Autobase-dependent event ingestion with direct Hyperbee writes, ensuring EVENT JSON and index structures mirror worker expectations for compatibility.
- Extend websocket handling to accept Nostr EVENT and REQ frames, apply admin-only writes, and enqueue subscription workloads across connected peers (hypertuna-worker/gateway/GatewayService.mjs:304 already maintains peer health metadata that can be reused).
- Add replication endpoints or protocol handlers so connected peers can stream the Hyperbee (reuse Hyperswarm plumbing that currently powers forwardMessageToPeerHyperswarm in shared/public-gateway/HyperswarmClient.mjs:563).
- Persist gateway relay metadata (keys, discovery key, indexes) and expose it via health and admin APIs; ensure clean shutdown flushes caches and closes Hyperbee (public-gateway/src/config.mjs:4 governs persistence paths).
- Introduce metrics and logging for Hyperbee ops (append latency, replication stats) alongside the existing metrics.mjs pipeline.
- Maintain per-peer workload telemetry (in-flight subscription handlers, rolling latency, failure rate) and feed it into the dispatcher; expose a control frame so peers can be reassigned mid-stream if they breach thresholds.
- Emit gateway-signed token revocation frames over the websocket when per-peer tokens are invalidated and ensure the dispatcher drops revoked peers immediately.
- Create gateway-facing admin endpoints/CLI commands for: (a) inspecting Hyperbee stats (version, size, writers), (b) dumping dispatcher queues, (c) forcing token revocation, and (d) pausing replication for maintenance. These need guarded access controls and structured output for ops tooling.
- Provide feature flags (env/config) allowing staged rollout: independent toggles for Hyperbee host enablement, dispatcher activation, and token enforcement to ease incremental deployment.

**Worker & Peer Work**

- Create a gateway-relay client module in the worker that opens the Hyperbee using the key delivered at registration, handling sparse sync and local storage reuse.
- Introduce a dedicated Hyperbee reader that reuses the existing peer relay index scheme (no migrations), exposes read-only query helpers for Nostr filters, and reports query diagnostics.
- Update relay coordination to treat the gateway relay as read-only: disable Autobase writer paths when relayKey === gatewayRelayKey, route publish attempts over the websocket, and guard the reader from issuing mutating operations.
- Build subscription distribution logic so workers receiving REQs from the gateway can query their local Hyperbee snapshot and stream results back over Hyperswarm, preferring local execution when the dispatcher assigns the worker’s Hyperswarm public key.
- Enhance peer startup to fetch the Hyperbee key from registration payloads (public-gateway/src/stores/MemoryRegistrationStore.mjs:1 stores relay metadata) and initialise replication before declaring the relay usable.
- Provide recovery paths for peers to resync the Hyperbee when out of date, including version detection and resubscription.
- Report load metrics (recent REQ count, active query streams, median response latency, replica lag) back to the gateway via heartbeat or dispatcher acknowledgements so the scheduler can make informed assignments.
- Enforce per-peer token TTLs locally; treat gateway revocation frames or failed refresh responses as hard disconnect signals and tear down replication/websocket sessions accordingly.
- Implement configurable back-off and retry strategies for websocket publish attempts, Hyperbee replication rejoin, and dispatcher acknowledgements so intermittent connectivity issues do not overwhelm the network.
- Update peer health reporting to include Hyperbee sync progress (latest version, percentage synced) and local query outcome summaries to inform dispatcher decisions and operator dashboards.

**Shared Modules**

- Extend registration DTOs and token metadata to include the gateway relay key, websocket URL, and Hyperbee discovery info (shared/auth/PublicGatewayTokens.mjs:1 and public-gateway/src/stores/MemoryRegistrationStore.mjs:1).
- Update shared/config/PublicGatewaySettings.mjs:1 and shared/config/GatewaySettings.mjs:1 to persist gateway relay flags (enable/disable auto token issuing, preferred relay key).
- Enhance shared/public-gateway/GatewayDiscovery.mjs:13 to broadcast the new relay descriptors so auto-discovery peers can bootstrap without manual config.
- Adjust shared/public-gateway/HyperswarmClient.mjs:563 to add message types for relay subscription delegation results and Hyperbee sync control.
- Add shared payload definitions for dispatcher telemetry (peer load reports, assignment tokens) and websocket control frames that communicate token revocations and reassignment directives.
- Expose dispatcher policy and token refresh configuration via shared PublicGatewaySettings defaults so desktop/worker UIs surface the new tuning knobs.
- Include Hyperbee relay metadata (public key, discovery key, replication topic) in discovery announcements and registration responses for worker bootstrap.
- Provide schema validation (with e.g. zod or bespoke validators) for new shared payloads to ensure malformed data is rejected before reaching business logic. Keep validation shared so both gateway and worker enforce consistent rules.

**Auth & Security**

- Implement optional rotating websocket access tokens issued by the gateway and validated by peers; integrate TTL handling into token metadata stores.
- Ensure gateway relay write operations verify the admin private key and reject unauthorized websocket publish attempts.
- Define rate limits for publish and subscription calls to protect the gateway relay from abuse while allowing background replication.
- Audit logging should capture token issuance, replication failures, and publish attempts for observability.
- Issue tokens on a per-peer basis keyed to registration records, store TTL/refresh metadata in MemoryRegistrationStore (and Redis variant), and require clients to refresh proactively via a `token/refresh` route before expiry.
- Define revocation flow: remove peer entry from the token store, broadcast a signed `token-revoked` websocket control frame, and reject subsequent refresh attempts; peers must close connections upon receipt.
- Capture token issuance/refresh/revocation events in structured logs for traceability and to support automated incident response.
- Ensure all token and dispatcher control frames are signed by the gateway and include monotonically increasing sequence numbers to prevent replay. Workers should track the highest observed sequence per gateway.
- Provide configuration for token TTL, refresh thresholds, and maximum outstanding refresh failures before peer quarantine. Document default values and rationale.

**Operations**

- Provide migration tooling to seed the new Hyperbee from any existing gateway data before cutover.
- Document required environment variables and config entries for enabling the gateway relay host, including storage paths and token settings (public-gateway/src/config.mjs:4).
- Update deployment scripts/docker image to include Hyperbee dependencies and any new ports or topics.
- Add health endpoints or status events exposing Hyperbee sync state so operators can monitor replication.
- Expand operational dashboards (metrics.mjs exporters, Grafana panels) to cover dispatcher queue depth, token issuance rate, Hyperbee replication lag, and websocket error counts.
- Define runbooks for common incidents: peer token revocation, dispatcher overload, Hyperbee rebuild, and upgrade rollback.
- Introduce staged rollout feature flags controlled via `GATEWAY_FEATURE_HYPERBEE_RELAY`, `GATEWAY_FEATURE_RELAY_DISPATCHER`, and `GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT`; defaults remain false to preserve existing behaviour until activation.
- Surface new relay token configuration knobs (`GATEWAY_DEFAULT_TOKEN_TTL`, `GATEWAY_TOKEN_REFRESH_WINDOW`) in deployment docs so operators can tune issuance and refresh windows prior to enabling enforcement.

**Testing**

- Unit-test Hyperbee host operations (put/get/index) with mocked websocket inputs.
- Integration-test peer registration to confirm relay keys propagate and replication succeeds with sparse downloads.
- Simulate publish/subscribe workflows across multiple peers to verify delegated REQ handling and consistency.
- Perform regression testing on legacy worker relays to ensure Autobase paths remain intact.
- Add scheduler-focused tests that exercise latency spikes, token revocation mid-stream, and dispatcher reassignment logic to ensure queries fail over gracefully.
- Validate per-peer token lifecycle with unit tests covering issuance, refresh, expiration, and revocation handling on both gateway and peer implementations.
- Build chaos tests/fault injection scripts that emulate peer churn, delayed telemetry, and Hyperbee replication stalls to validate dispatcher stability and token expiry handling under stress.

**Resolved Considerations**

- Subscription dispatcher will use a hybrid load-aware strategy built on PeerHealthManager metrics with per-peer concurrency caps.
- Rotating access tokens are scoped per peer with explicit refresh and revocation flows; no global tokens will be issued.
- The gateway relay reuses the existing peer relay index scheme; no schema migration or additional index manifests are required.
- Public gateway relays are new, so no historical data requires migration.

**Implementation Plan**

- **Phase 0 – Design & Environment Preparation**
- Finalise interface contracts for HyperbeeRelayHost, dispatcher, and token services; capture them in TypeScript/JSDoc typings under shared/ where appropriate.
- Audit current configs and introduce feature flags/env vars required for staged rollout; ensure defaults preserve existing behaviour.
- Align documentation and architecture diagrams; schedule knowledge sharing with operations and worker teams.
  - Outputs: `docs/public-gateway-relay-interface-contracts.md`, `shared/types/public-gateway-relay.d.ts`, and an announced rollout/knowledge share plan circulated to gateway + worker owners.

- **Phase 1 – Hyperbee Host Foundations (Gateway)**
  - Create `public-gateway/src/relay/HyperbeeRelayHost.mjs` responsible for corestore initialisation, Hyperbee lifecycle, replication hooks, and admin inspection APIs.
  - Wire host startup/shutdown into `PublicGatewayService.init/start/stop`, guarded by a feature flag.
  - Implement persistence of relay keys/config in the gateway settings loader and ensure secure storage of private material.
  - Add unit tests mocking Hyperbee to validate lifecycle, metrics emission, and error handling.

- **Phase 2 – Gateway Websocket & Nostr Handling**
  - Build a dedicated websocket controller to parse EVENT/REQ messages, enforce admin-only writes, ACK/NACK semantics, and queue dispatcher jobs.
  - Integrate control frames for token revocation and dispatcher reassignment, including signature/sequence validation.
  - Extend metrics and logging for websocket throughput, error types, and latency distribution.

- **Phase 3 – Dispatcher & Telemetry Layer**
  - Implement dispatcher service with pluggable scoring (latency, in-flight, failure rate) leveraging `PeerHealthManager` data and new telemetry channels.
  - Define peer heartbeat protocol conveying load metrics, Hyperbee sync status, and token refresh status; update HyperswarmClient to transport these messages.
  - Build failover logic for reassignment, including circuit breaker thresholds and backpressure controls.
  - Add simulation tests that fake multiple peers and validate scheduling decisions under varying conditions.

- **Phase 4 – Token Service & Security Flows**
  - Extend registration stores (memory and Redis) to persist per-peer token metadata, sequence counters, and refresh windows.
  - Implement token issuance/refresh endpoints plus websocket control messages. Update shared auth helpers with signing and verification utilities.
  - Update logging/audit trails and exposure of token metrics. Ensure revoked tokens propagate immediately and peers disconnect.

- **Phase 5 – Worker/Peer Integration**
  - Introduce worker-side Hyperbee client module to mirror gateway schema, manage sparse replication, and expose read-only query APIs used by subscription handlers.
  - Build a dedicated Hyperbee reader abstraction (shared as needed) that reuses existing peer relay index helpers, supports sparse range scans, and reports query metrics for dispatcher feedback.
  - Update registration flow to capture gateway relay metadata, bootstrap replication, and initiate websocket connection with token negotiation.
  - Expose the worker Hyperswarm public key to `GatewayService`, route dispatcher-assigned REQs through the local reader when the assignment matches, and fall back to Hyperswarm forwarding on staleness or errors while preserving legacy behaviour behind feature flags.
  - Implement dispatcher telemetry reporting (local query hits/misses, replica lag, fallback counts), token refresh handling, and failover logic reacting to reassignment and revocation frames.
  - Provide configuration and CLI for operators to inspect worker peer status and reconcile issues.

- **Phase 6 – Shared Module Enhancements**
  - Update shared DTOs, discovery payloads, and settings modules with new fields (relay key, dispatcher parameters, token TTLs) plus validation.
  - Ensure all call sites (gateway, worker, desktop) consume new shapes gracefully with feature flag guarding.
  - Document versioning expectations for shared packages to coordinate releases (note new discovery payload fields require coordinated bumps across gateway/worker/desktop bundles).

- **Phase 7 – Validation & Hardening**
  - Execute integration tests across gateway + multiple workers to validate replication, subscription routing, and token lifecycle under realistic loads.
  - Run chaos/fault-injection scenarios (peer churn, latency spikes) to stress dispatcher failover and token revocation behaviour.
  - Perform security review of token signing, sequence enforcement, and sensitive logging.
  - Prepare observability dashboards and runbooks; complete operational readiness review.

- **Phase 8 – Rollout & Post-Deployment Monitoring**
  - Enable features progressively via flags (e.g., Hyperbee host first, then dispatcher, then token enforcement).
  - Monitor metrics and logs for regression signals during rollout; keep rollback procedure ready.
  - Gather feedback from peer operators, iterate on tuning defaults (concurrency caps, token TTLs) based on real-world telemetry.
  - Finalise documentation updates for developers and operations teams.
