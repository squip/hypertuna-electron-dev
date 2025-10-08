# Restart & Relay Initialization Optimization Requirements

## R1. Parallelized Auto-Auth & Worker Startup
1. The onboarding flow must trigger the returning-user auto-authentication workflow immediately after state detection without an arbitrary minimum splash delay.
2. Auto-authentication must request Hypertuna worker startup concurrently with Nostr client initialization and profile hydration to avoid serialized waits.
3. `NostrIntegration.init` invoked during auto-authentication must accept a configuration that allows deferred discovery so that UI readiness is not blocked on relay discovery subscriptions.
4. The onboarding overlay must be dismissible as soon as authentication, config hydration, and worker readiness prerequisites succeed, with remaining discovery tasks continuing asynchronously in the background.
5. Auto-authentication must emit progress updates that can be surfaced by the renderer status component (e.g., stages for auth, worker boot, discovery resume).

## R2. Worker Bootstrap & Relay Auto-Connect Concurrency
1. Worker startup must begin connecting stored relays in parallel with public gateway initialization rather than waiting for explicit gateway readiness before starting the connect pass.
2. Relay auto-connect operations must process stored relay profiles using concurrent (or at least batched) promises so that a slow relay does not block the entire set.
3. The worker must emit `relay-loading` status messages for each stored relay before attempting connection, enabling the renderer to display progress feedback.
4. Existing `relay-initialized`, `relay-registration-complete`, and `all-relays-initialized` messages must continue to fire for compatibility.
5. Errors encountered during concurrent auto-connect must be captured per relay and reported without stopping remaining relays from processing.

## R3. Relay List State Persistence & Hydration
1. The renderer must persist the latest non-empty relay list snapshot locally (e.g., localStorage) whenever `updateRelayList` receives data.
2. On startup, the renderer must hydrate the relay list UI from the cached snapshot before fresh data arrives, avoiding visible empty states for returning users.
3. Cache hydration must be bypassed or cleared when the worker confirms that no stored relays exist (via `all-relays-initialized` with zero count).
4. `AppIntegration.loadGroups` must treat the relay list as pending until either cached data is rendered or the worker signals completion, and it must not show a “No relays” message while pending data is expected.

## R4. Relay Loading UX Feedback
1. The groups view must include a visible status component capable of showing loading messages and progress updates during worker/relay initialization.
2. The status component must react to the new `relay-loading` message, as well as existing worker status events, showing contextual text such as “Loading your relays…”, “Joining P2P relay network…”, or per-relay initialization notices.
3. The default empty-state message must only appear when initialization is complete and zero relays are confirmed.
4. The status component must hide automatically once relay initialization completes and at least one relay is available (or when the worker reports no relays).
5. Status updates must be accessible across both the legacy worker log list and the new groups page without duplicating business logic.

## R5. Progress Bar Loading Experience
1. Replace the existing relay status banner with a compact progress bar element rendered beneath the “Your Relays” header, accompanied by static text “Loading your relays…”.
2. The progress bar must initialize in a hidden state and become visible when the first loading signal (worker status, onboarding stage, or `relay-loading` event) is received.
3. Progress should advance in discrete intervals that correspond to relay initialization milestones. When worker payloads disclose the number of relays expected, set `totalSteps` equal to that value (minimum of 1) and advance the bar as each relay completes (`initialized`, `already-active`, or `relay-registered`).
4. When the relay count is unknown, fall back to a deterministic three-step sequence (worker ready, gateway ready, relays synced) so the bar still animates smoothly.
5. Clamp visible progress at 95% until a terminal event (`all-relays-initialized` or explicit completion) arrives, then animate the bar to 100% and fade the component away after a short delay (~750 ms) if relays exist. If no relays are found, show an empty-state message once the bar completes.
6. Debounce rapid event bursts to maintain readability: each advancement should animate over at least 150 ms, and consecutive updates should not jump backwards.
7. Provide a simple controller API (`start`, `advance`, `complete`, `reset`) accessible from onboarding, worker message handlers, and future flows without duplicating logic.
