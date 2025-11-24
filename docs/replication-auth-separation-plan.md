# Public Gateway Replication Auth Separation Plan

## Objectives
- Keep normal nostr traffic to `/relay` open (`requiresAuth:false`).
- Require gateway-issued tokens for all replication traffic via a dedicated endpoint.
- Ensure the gateway can handle replication reads/writes locally (with optional delegation to peers for reads only).
- Prevent replication publishes from being forwarded to peers.

## Current Gaps (from regression)
- `public-gateway:hyperbee` advertises `requiresAuth:false` and the desktop skips attaching tokens.
- Relay controller rejects replication frames without a token, so replication writes never reach Hyperbee.
- Normal and replication traffic share one socket, creating policy ambiguity.

## Target Design
- Two channels per relay:
  - **Normal**: `wss://{gateway}/relay` — open for normal EVENT/REQ; token optional.
  - **Replication**: `wss://{gateway}/mirror/{publicIdentifier}?token=...` — token required; replication-only routing.
- Registration metadata adds `requiresAuthForReplication:true` and `replicationEndpoint` to advertise the replication socket.
- Replication EVENTs/REQs are handled locally against Hyperbee; never forwarded to peers. Reads may delegate to peers when available but must succeed locally.

## Work Breakdown

### 1) Registration Metadata
- Add fields to the registration payload for `public-gateway:hyperbee`:
  - `requiresAuth:false` (existing)
  - `requiresAuthForReplication:true` (new)
  - `replicationEndpoint` (e.g., `/mirror/{identifier}`)
- Ensure the registration store persists/returns these fields.
- Update any status/telemetry endpoints to surface them for clients.

### 2) Replication WebSocket Path & Handler
- Add a new WebSocket route (e.g., `/mirror/:identifier`) that:
  - Requires a valid gateway-issued token at handshake; reject if missing/invalid.
  - Binds a replication-only controller that classifies frames:
    - `EVENT` with replication payload → append to Hyperbee (no peer forwarding).
    - `REQ` with replication filters (`relayID/#relay`) → serve from Hyperbee; optionally delegate to peers when present; emit EOSE consistently.
  - Shares session bookkeeping/metrics but keeps a separate path from `/relay`.
- Wire token validation to the existing token service.

### 3) Client Publish/Query Paths (Desktop + Hosted Web)
- Introduce per-relay replication socket config derived from metadata (`requiresAuthForReplication`, `replicationEndpoint`).
- Always connect replication traffic to the gateway host + replication endpoint with the gateway token; fail fast if token is absent/expired.
- Route all replication EVENT publishes and replication REQs through the replication socket; keep normal nostr traffic on existing sockets.
- Ensure token acquisition/refresh flows supply the replication socket; add retry/backoff and user-visible/logged errors when missing.

### 4) Controller Guard Rails
- `/relay` controller: stop rejecting replication frames solely due to missing token when `requiresAuth:false`; still permit tokens if provided.
- Replication controller: always enforce token; reject unauthed frames; never forward replication EVENTs to peers.
- Keep replication REQ delegation to peers optional, but default to local Hyperbee availability.
- Add metrics/logging for accepted/rejected replication frames (reason codes: missing-token, invalid-token, append-error).

### Testing & Rollout
- Unit: registration metadata serialization/deserialization; token-required handshake on replication endpoint; controller classification for replication vs. normal frames.
- Integration: publish replication EVENT with/without token; REQ with/without token; verify Hyperbee append and read paths; confirm normal `/relay` traffic remains open.
- Client integration: verify replication publishes/queries use replication socket + token; normal traffic unaffected.
- Incremental rollout: ship gateway changes behind a feature flag for the replication endpoint; then update clients to consume the new metadata and endpoint.

## Acceptance Criteria
- Registration payload for `public-gateway:hyperbee` includes `requiresAuth:false`, `requiresAuthForReplication:true`, and a non-empty `replicationEndpoint`; values surface through status/telemetry APIs and any registration read paths.
- `/relay` endpoint accepts normal EVENT/REQ without token when `requiresAuth:false` and does not reject replication frames solely for missing token (while still allowing tokened sessions).
- `/mirror/{identifier}` (replication endpoint) rejects connections without a valid gateway token and rejects replication frames lacking auth; accepts valid replication EVENT/REQ, appends to Hyperbee, and serves replication REQs with consistent EOSE.
- Replication EVENTs are never forwarded to peers; replication REQs can be delegated to peers when available but succeed locally when peers are absent.
- Desktop + hosted web clients route all replication publishes/queries via the replication endpoint with the gateway token; normal traffic remains on the existing sockets; missing/expired token yields visible/logged errors and does not silently drop replication.
- Metrics/logs capture replication accepts/rejects with reason codes (e.g., missing-token, invalid-token, append-error) and normal traffic continues unaffected.

## Open Questions / Clarifications
- Confirm the exact replication endpoint shape for registration metadata (e.g., `/mirror/{publicIdentifier}`) and whether to include the full absolute URL or a path template; current assumption is a path template.
  - answer: confirming we will implement the `/mirror/{publicIdentifier}` endpoint shape using a path template.

- Should replication REQ delegation to peers be enabled by default or guarded by a feature flag per relay? (Default assumption: allowed, but local serve is mandatory.)
  - answer: confirming assumption is correct. peer delegation will be enabled by default and used opportunistically while active peers are online, but local serve will continue to be manadatory. 

- Any legacy clients that might hit `/mirror` without token? If so, should we return a specific notice/error code for better UX?
  - answer: codebase is currently in development and has not been launched. reverse compatibility with legacy client implementations is not a concern.

- Token scope: should the replication endpoint accept only relay-scoped tokens or also any broader gateway token types? (Assumption: relay-scoped gateway tokens only.)
  - answer: confirming replication endpoint should be configured to accept relay-scoped gateway tokens only.


Notes:
clients are still expected to connect to the /relay connectionURL for emitting normal nostr traffic to the public-gateway:hyperbee. updates made to the desktop or web-ui nostr clients should not overwrite this. when workers register relay instances with the public gateway host and are issued tokens, the functionality that creates the connectionURL value for the normal / non-mirror relay instance ie wss://{public gateway host}/{relay identifier}?token=.... should continue to be supported as well. what it sounds like we need is a fix that will create the missing connectionURL specifically for handling replication traffic to the public gateway for that relay instance i.e. wss://{public gateway host}/mirror/{relay identifier}?token=..... this should be additional to, and not replace the non-mirror connection url for the relay. when emitting the replication event data, the client should establish an additional websocket connection to the relay mirror connectionURL wss://{public gateway host}/mirror/{relay identifier}?token=.... and exclusively use this to send the replication event traffic only for the relay instance.

==the public gateway server hosts the authoritative public-gateway:hyperbee relay (HyperbeeRelayHost + adapter/dispatcher/controller), and workers only open a replica client against it. The LocalGatewayServer/worker cannot process writes to that dataset. Any relay auth/token logic for public-gateway:hyperbee must therefore be handled on the gateway side and then consumed by workers/desktop to connect to the gateway’s /mirror/... endpoint; there’s no worker-hosted authority involved for that relay.==

We still need a usable token and mirror URL for public-gateway:hyperbee so the worker can connect to the gateway replica, but that token should be issued by the gateway (not derived from the worker). Also, user relays still show non-mirror connectionUrl values, so clients keep connecting to /relay instead of /mirror—that’s the next gap to close.

We should keep the existing /relay connectionUrl for normal nostr traffic, and add (not replace) a separate replication connection URL that points to /mirror/{relayPath}?token=…. Clients will maintain two sockets per relay: the existing /relay socket for normal EVENT/REQ, plus a new /mirror/... socket for replication EVENT/REQ only.

Next steps to close the gap:

- Gateway/worker state: expose both URLs per relay:
    - connectionUrl → normal /relay URL (already present).
    - replicationConnectionUrl (or similar) → /mirror/{relayPath}?token=…, with a token issued for replication auth.
- Token issuance: continue issuing the normal /relay token; additionally issue or derive a replication token/URL for /mirror/... and surface it in the relay state/status.
- Clients: read both URLs; keep using /relay for normal traffic; open the /mirror/... URL for replication publishes/queries only.
- Public-gateway: still handles replication on /mirror with token enforcement; normal /relay remains for non-replication traffic.

This matches the intended separation without breaking the existing /relay path.
