# Onboarding Relay & Public Gateway Fix Requirements

1. **Relay list persistence for newly created relays**
   - When the desktop client orchestrates relay creation through the worker, the resulting relay must be stored in the user's kind-10009 relay list even if the worker returns an authenticated (tokenized) websocket URL.
   - Sanitise relay URLs before persisting (strip query tokens and normalise base paths) so cached relay metadata and join flows remain stable across restarts.
   - Ensure downstream UI refresh logic continues to rely on the updated relay list so the new relay renders immediately after creation.

2. **Public gateway bridge enabled by default for new users**
   - Default public gateway settings should enable the bridge and rely on discovery to fetch the shared secret automatically; a fresh profile should not require manual toggles.
   - Discovery updates must trigger re-resolution of the public gateway configuration until a gateway secret is obtained, instead of permanently disabling the bridge when no entry is found during the first pass.
   - Persist the resolved public gateway configuration (including fetched secret metadata) so subsequent worker restarts retain the enabled state without repeating discovery work.

3. **Operational coherence**
   - All new logic must be compatible with existing accounts (no regression for users who already have relays or custom gateway preferences).
   - Keep logging and error-handling concise; new retries or background operations should surface actionable warnings without flooding the console.

4. **Public gateway peer connection reliability**
   - **Task 4.1 – Hyperswarm connection lifecycle hardening**
     - Ensure each `HyperswarmConnection` reacts to `stream` and `protocol` closure or errors by resetting its `connected` state, cleaning up listeners, and removing itself from the shared pool so future lookups trigger a fresh dial.
   - **Task 4.2 – Prefer healthy sockets on inbound connections**
     - Update the pool’s `swarm.on('connection')` handler to validate whether an existing wrapper is still healthy before keeping it; if the active stream is stale, swap in the new connection and tear down the old wrapper.
   - **Task 4.3 – Active health sweep for registered peers**
     - Add a periodic health-check loop that pings each pooled connection via the existing protocol health endpoint; failed checks must mark the wrapper as unhealthy and trigger cleanup/removal from the pool.
   - **Task 4.4 – Registration store stale peer pruning**
     - Track `lastSeen` timestamps per peer during registration merges and proactive health checks, and remove peers that have not re-registered or failed recent health checks so routing tables never include offline entries.
   - **Task 4.5 – Routing resilience**
     - Adjust `PublicGatewayService` peer selection helpers (`#withPeer`, `#withRelayPeerKey`, delegation flows) to skip unhealthy peers, rotate to viable alternatives, and optionally fall back to local replicas if no remote peers remain.
