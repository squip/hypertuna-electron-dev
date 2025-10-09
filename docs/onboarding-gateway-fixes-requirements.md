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
