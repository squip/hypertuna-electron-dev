# Public Gateway Encrypted Replication Implementation Plan

## 1. Objectives & Success Criteria
- Allow authorized members to read/write relay autobase data even when no host peers are online by storing encrypted replicas inside the public gateway Hyperbee relay and routing REQ/EVENT traffic through it transparently.
- Preserve the existing peer-first behavior: whenever at least one worker is reachable, websocket traffic should still flow through the worker-hosted autobase.
- Keep replication payloads opaque to the gateway by encrypting the embedded nostr event JSON with a per-relay shared secret that is rotated whenever membership changes.
- Ensure desktops and the new public web client can seamlessly publish mirrored replication events, decrypt gateway-sourced copies, and reconcile with peers without creating duplicate events or violating access control.
- Provide observability, configuration toggles, and testing hooks so the feature can be adopted gradually and debugged in production.

## 2. Current State Summary
### Desktop + Worker Clients
- `NostrGroupClient` owns relay metadata, message publishing, and membership logic (`hypertuna-desktop/NostrGroupClient.js:2915-3445`). It assumes a live worker relay URL per group and publishes messages through `WebSocketRelayManager.publishToRelays` (`hypertuna-desktop/WebSocketRelayManager.js:152-199`). There is no IndexedDB cache today, so REQs are always routed to peers.
- Group metadata is encoded through `NostrEvents.createGroupCreationEvent` and `createGroupMetadataEditEvents`, which emit kind 9007/39000 payloads plus simple "public" / "open" tags (`hypertuna-desktop/NostrEvents.js:217-457`). Kind 9002 is already reserved for metadata edits.
- Relay configuration UI lives in `index.html` and `AppIntegration.js` (`hypertuna-desktop/index.html:337-373`, `hypertuna-desktop/AppIntegration.js:2847-2903`). There is no switch for encrypted replication today.
- Desktop gateway settings (`shared/config/PublicGatewaySettings.mjs:1-120`) only capture global routing preferences; they do not track per-relay replication policies or shared secrets.

### Public Gateway + Hyperbee Relay
- Hyperbee storage is handled by `public-gateway/src/relay/HyperbeeRelayHost.mjs`, which currently indexes by `created_at`, `kind`, `pubkey`, and generic `tagKey` prefixes. There are no relay-specific indexes yet.
- `shared/public-gateway/PublicGatewayHyperbeeAdapter.mjs` queries those indexes and feeds `RelayWebsocketController` / worker virtual relays. Queries presently assume unencrypted nostr events.
- `RelayWebsocketController` opportunistically serves REQs from the Hyperbee replica when `hyperbeeRelayEnabled` is set, before delegating to workers. No special handling exists for encrypted payloads.
- `PublicGatewayService` orchestrates worker routing and Hyperbee polling. When no peers are registered the connection currently just stalls.

## 3. Target Operating Model
1. Each relay exposes an "Encrypted Replication" toggle (default on). When enabled the desktop worker generates a symmetric shared secret per relay and publishes it (encrypted per member) so clients can recover it.
2. Every EVENT publish results in (a) the normal Autobase write through the worker relay and (b) a mirrored `replication-event` record stored in Hyperbee. The mirrored event stores unencrypted metadata (relay hash, original event id/kind/timestamps, file or drive keys) plus `eventData`, which is the encrypted JSON string of the canonical nostr event.
3. Desktop + public gateway clients detect whether peers are online. If none are registered or a peer connection fails, they fall back to a 2-phase workflow: subscribe broadly from Hyperbee using relay hash + time/kind filters, decrypt locally using the shared secret, store results in IndexedDB, then execute the user's fine-grained filters over that local cache.
4. When a worker comes online it compares the latest local timestamp vs. the latest Hyperbee replication timestamp for each relay. Any missing encrypted events are downloaded, decrypted, and appended to Autobase (with blind-peer mirroring afterward). Workers run periodic catch-up sweeps while they remain registered.
5. A hosted web client (https://hypertuna.com) mirrors the Electron UI but omits worker-only actions. It consumes the same replication APIs so users can stay productive from the gateway alone.

## 4. Detailed Scope & Requirements
### 4.1 Relay Configuration & Metadata
- Add “Encrypted replication” toggle to create-relay modal and settings (default ON). Wire through AppIntegration → NostrGroupClient → NostrEvents tags and verify round-trip (create/edit → tags → parse → UI). Feature-flag ready.
- Group creation/metadata events carry replication tags; parse into group state, cache, and admin-only controls.
- Relay hashing: `relayHash = sha256('hypertuna-relay-id:' + normalizedIdentifier)` (trim/lowercase/collapse whitespace), hex (64 chars).

### 4.2 Shared-Secret Lifecycle (Kind 30078)
- Secret manager to generate/cache per relay (in-memory for clients; encrypted at rest for workers).
- Publish NIP-78 kind `30078` envelopes per member on create/rotation with `d=hypertuna:relay:<relayId>:secret:v<version>`, tags `['h', relayId]`, `['p', pubkey]`; encrypt `content` per pubkey; trust only admin-pubkey issuers.
- Rotation on 9001: mint new secret, publish to remaining members; pick secret by created_at when decrypting replication payloads.
- Desktop/web: background REQ for 30078, cache latest per relay.
- Secret manager API: `getSecret(relayId)`, `getSecretForTimestamp(relayId, createdAt)`, `setSecret(relayId, secret, createdAt)`, `hasSecret(relayId)`, optional `subscribe(relayId, onUpdate)` for cache refresh.

### 4.3 Encrypted Replication Publish Path
- Mirror every EVENT: encrypt full nostr event with relay secret; payload `{relayID, kind, created_at, eventId, fileKey?, driveKey?, eventData:ciphertext}`.
- Publish to worker relay (existing) + Hyperbee relay target with hybrid auth (gateway token + nostr signature); retry/backoff + telemetry; Autobase write must not block on Hyperbee failure.
- Deterministic index key builders for replication event/kind/time/file using relay hash + padded numeric fields.
- Primary replication row: store ciphertext plus minimal cleartext header (relayID, original_kind, created_at, HMAC’d file index) under `relayID:<hash>:id:<eventId>`; other replication indexes store only the event id/pointer.
- Replication index keys:
  - `replicationEventKey` → `relayID:<relay hash>:id:<event.id>`
  - `replicationKindKey` → `relayID:<relay hash>:kind:<kind padded 5>:created_at:<timestamp>:id:<event.id>`
  - `replicationTimeKey` → `relayID:<relay hash>:created_at:<timestamp>:id:<event.id>`
  - `replicationFileKey` → `relayID:<relay hash>:filekey:<fileKey>:drivekey:<driveKey>`

### 4.4 Hyperbee Storage & Adapter
- HyperbeeRelayHost stores replication entries and relay-scoped indexes (event, kind, time, file).
- PublicGatewayHyperbeeAdapter maps replication filters to new indexes; range scans with `maxIndexScan`; helper API to fetch replication entries since timestamp for workers.
- Telemetry for lag and append results.

### 4.5 Routing & REQ Handling
- Gateway/Websocket controller: peer-first; fallback to Hyperbee with two-step flow (broad fetch → client decrypt/cache → local filter).
- Failover on peer errors; maintain cursors for Hyperbee-served subscriptions; emit EOSE consistently.

### 4.6 Client Retrieval & IndexedDB
- EncryptedReplicationStore (IndexedDB/WebSQL) for decrypted events keyed by relay hash, id, kind, timestamps, tags, HMAC’d file index.
- Web: in-memory default; IndexedDB only in offline mode; TTL 24–72h; purge on logout/close; per-relay size caps.
- Desktop: encrypted-at-rest (OS keystore/master key); TTL ~30 days; size caps; purge on logout/key rotation; wipe merged blobs post-Autobase sync; backlog telemetry if merges delayed.

### 4.7 Worker Sync & Autobase Merge
- ReplicationBackfill job: compare local Autobase vs Hyperbee replication latest ts; fetch missing entries; decrypt with secret; append to Autobase; dedupe by id.
- Periodic sync loop; metrics (lag, processed count); post-sync blind-peer mirror refresh.
- Robust retries; skip bad decrypts with telemetry.

### 4.8 File/Drive Metadata (HMAC Indexing)
- Replace plaintext `fileKey`/`driveKey` indexes with `fileIndex = HMAC-SHA256(sharedSecret, fileKey || driveKey || '')`; store real keys only inside encrypted `eventData`.
- Update writers/readers (`constructFilekeyRangeQuery`/`queryFilekeyIndex` in `hypertuna-worker/hypertuna-relay-event-processor.mjs`) to compute HMACs; decrypt payloads to recover driveKey/fileKey for reconcile/mirror flows. HTTP GET `/drive/:identifier/:fileHash` remains unchanged.
- No special replication event kind; separation relies on `relayID:` namespace + replication index keys.

### 4.9 Public Gateway Web Client
- In-repo hosted client using existing build chain; reuse desktop UI minus create/join and uploads.
- Supports login, kind 10009 relay list, group list/detail, messages, settings, members, follows, discover; integrates encrypted replication publish + fallback (peers offline).

### 4.10 Observability & Settings
- Extend public-gateway settings to include Hyperbee URL/auth; validation and parsing.
- Gateway tokens: default TTL 15–30 minutes; refresh at ~80% of TTL (silent/background in browser; prompt only on failure).
- Metrics: replication lag, Hyperbee append success/fail, fallback hit rate, sync backlog, secret rotations.
- Status endpoint for replication per relay (latest ts, lag).
- Telemetry-only backpressure: no hard append caps initially; emit warnings when queue/backlog/scan thresholds are crossed to inform tuning.
- Replication retry/backoff defaults (configurable): start 500–1000 ms, factor ~2.0, max backoff 30–60s, max 5–7 attempts; warn when pending queue per relay exceeds ~100 or lag exceeds configured thresholds.

### 4.11 Testing & Release Readiness
- Unit: index builders, secret manager, HMAC file index, encrypt/decrypt, cache eviction.
- Integration: publish with peers online/offline; Hyperbee fallback; worker merge; file mirroring with HMAC indexes.
- Load: burst replication writes; query scan bounds.
- Feature flags: per-relay toggle + global; staged rollout plan.

## 5. Sequencing & Dependencies
1. **Foundation:** add metadata toggles, shared secret plumbing, and Hyperbee schema updates. Validate by writing dummy replication events via scripts.
2. **Client Publishing:** ship simultaneous desktop + worker updates so every EVENT publish mirrors to Hyperbee when enabled. Keep the fallback path disabled initially.
3. **Fallback Reads:** implement the IndexedDB cache and two-phase REQ workflow; gate it behind a per-user flag until the Hyperbee query paths are battle-tested.
4. **Worker Sync:** once Hyperbee stores accurate data, add the merge process so relays stay consistent when peers return.
5. **Public Web Client:** after the backend proves stable, deploy the hosted UI along with documentation and routing updates.

## 6. Decisions and Resolutions (resolved)
1. **Secret Distribution Kind:** Use NIP-78 kind `30078` for relay shared-secret envelopes (avoid kind 9002). `d` tag format: `hypertuna:relay:<relayId>:secret:v<version>` plus tags `['h', <relayId>]`, `['p', <memberPubkey>]`; `content` encrypted per member.
2. **Relay Hashing:** Deterministic salted SHA-256 of normalized public relay identifier: `relayHash = sha256('hypertuna-relay-id:' + normalizedIdentifier)` (trim/lowercase/collapse whitespace), hex-encoded (64 chars).
3. **Hyperbee Write Auth:** Require hybrid auth: valid gateway bearer token **and** valid Nostr signature on replication events; keep browser token TTLs short and refresh via gateway settings.
4. **IndexedDB Retention:** Web—keep in-memory by default; write to IndexedDB only in offline mode; TTL 24–72h; purge on logout/close; per-relay size caps. Desktop—encrypted-at-rest (OS keystore/master key), TTL ~30 days, size caps, purge on logout/key-rotation; wipe merged replication blobs after successful Autobase sync, and surface telemetry if backlogs persist (worker crash, Autobase backpressure, gateway-only connectivity).
5. **Worker Secret Storage:** Persist shared secrets to disk encrypted with host peer key (or dedicated keyfile); load before sync for crash recovery.
6. **Public Gateway Hosting:** Host the web client in-repo using existing build tooling.
7. **File/Drive Metadata Exposure:** Use HMAC indexing: `fileIndex = HMAC-SHA256(sharedSecret, fileKey || driveKey || '')`; store real keys only inside encrypted `eventData`. Update writes/reads (e.g., `constructFilekeyRangeQuery`/`queryFilekeyIndex` in `hypertuna-worker/hypertuna-relay-event-processor.mjs`) to compute HMACs; decrypt payloads to recover driveKey/fileKey for fetch/mirror flows. HTTP GET paths use plaintext file hash and remain unaffected.
8. **Failure Semantics:** Retry Hyperbee appends with backoff; warn/telemetry on persistent failure; never block Autobase writes; optionally enqueue background re-publish until acknowledged.

## 7. Development Roadmap (Phased)
**Phase 1: Foundations & Metadata**
- UI toggle + metadata tags for encrypted replication (create/edit + parse/display).
- Secret manager + NIP-78 secret envelopes (issue, decrypt, rotate).
- Relay hashing change (salted SHA-256) applied consistently.
- Global/local feature flags wired.

**Phase 2: Replication Write Path & Hyperbee Schema**
- Encrypt-and-mirror EVENT helper; hybrid auth for Hyperbee append; retry/telemetry.
- HyperbeeRelayHost index extensions; replication key builders.
- Adapter support for replication queries; worker fetch-since API.

**Phase 3: Fallback Reads & Client Cache**
- Gateway/Websocket two-step fallback path; failover on peer errors.
- EncryptedReplicationStore (web/desktop variants) with eviction policies; local filter pipeline.

**Phase 4: Worker Sync & HMAC File Index**
- ReplicationBackfill: timestamp diff, fetch/decrypt, Autobase append, dedupe, periodic loop, metrics.
- Convert filekey index to HMAC; update reconcile/mirror/health flows; confirm GET paths unaffected.

**Phase 5: Public Web Client**
- In-repo web client build; scoped feature set (no create/join/uploads); replication publish + fallback; connects via gateway URL.

**Phase 6: Observability, Settings, and Rollout**
- Settings extensions (Hyperbee URL/auth); metrics (lag, append, fallback, backlog, rotations); status endpoint.
- Test harness (unit/integration/load); gated rollout plan; enable per relay then globally when stable.
