# Relay AES Offload & Registration Hardening Requirements

## Background
Regression testing identified two systemic issues in the relay creation lifecycle:

1. **Renderer AES encryption failures**: private relay workflows crash when the renderer tries to encrypt relay list updates with `browserify-cipher`, because the cipher object is instantiated in the isolated renderer context where Node prototypes are stripped.
2. **Fragile gateway registration workflow**: relays continue to initialize even when Hyperswarm registration fails or stalls, leaving the gateway unaware of the relay and causing websocket authentication errors.

This document captures the implementation requirements to address both problems.

---

## Scope A: Offload AES logic to the worker

### Goals
- Move all AES encrypt/decrypt operations used for relay list management from the renderer into the worker process.
- Provide a stable IPC surface so renderer code can request encryption/decryption without handling raw crypto primitives.
- Remove direct dependency on `browserify-cipher` inside the renderer bundle.

### Functional Requirements
1. **Worker cryptography service**
   - Expose async functions on the worker (likely within `challenge-manager.mjs` or a new helper module) that accept payloads for encrypt/decrypt using shared-secret semantics consistent with existing `NostrUtils.encrypt/decrypt` behaviour.
   - Ensure the service works for both user relay list payloads and invite payloads (same AES-256-CBC scheme).
2. **IPC request handlers**
   - Extend worker message handling (`hypertuna-worker/index.js`) to support commands such as `encrypt-relay-payload` / `decrypt-relay-payload`.
   - Responses must include success flag and data/error for renderer consumption.
3. **Renderer integration**
   - Replace `NostrUtils.encrypt/decrypt` usage paths in the renderer with wrappers that forward to the worker. These functions should remain promise-based for compatibility.
   - Ensure fallback or error messages surface meaningful UI feedback if encryption fails (e.g., worker is offline).
4. **Cleanup**
   - Remove `browserify-cipher` imports from renderer modules and update build dependencies if the package is no longer required outside preload.

### Acceptance Criteria
- Private relay creation and invite flows complete without `cipherObj.update` errors.
- No direct references to `browserify-cipher` remain in renderer bundles (`hypertuna-desktop` sources).
- Unit/integration paths relying on `NostrUtils.encrypt/decrypt` continue to receive encrypted payloads identical to the previous implementation (validated via decrypt round-trip during development).

---

## Scope B: Harden relay registration flow

### Goals
- Ensure relays are only surfaced to the renderer once Hyperswarm registration with the local gateway succeeds (or a deliberate skip is acknowledged).
- Surface and retry registration failures instead of silently re-queuing while the UI assumes success.

### Functional Requirements
1. **Worker-side registration state**
   - Update `pear-relay-server.mjs` to retain registration result (success/failure/queued) and return it to the renderer.
   - Emit a dedicated error message when registration fails after retries, so the renderer can update UI state.
2. **Renderer readiness gating**
   - Modify `AppIntegration.js` / `NostrGroupClient` logic to wait for `relay-registration-complete` or an error before attempting to connect to the gateway URL.
   - Display clear feedback in the join modal when registration fails, allowing the user to retry or cancel.
3. **Retry strategy**
   - Ensure `registerWithGateway` retries queued registrations when the gateway connection re-establishes, with logging visible in renderer/worker logs.
   - Avoid infinite immediate retries; retain existing queue but add explicit notification when the first attempt fails.
4. **Health reporting**
   - Update worker logs and messages to include registration status in `relay-created` payloads so UI reflects accurate state.

### Acceptance Criteria
- Creating a closed relay results in the UI waiting for gateway acknowledgement before declaring success.
- If the gateway registration times out, the UI shows an actionable error and the relay does not appear in the list until registration eventually succeeds.
- Worker logs clearly distinguish between queued registration attempts and completed acknowledgements.

---

## Non-Functional Requirements
- Maintain ASCII-only code changes and concise comments per repository standards.
- Ensure new IPC messages are documented in code comments for maintainability.
- Provide sanity validation (manual or automated) for the two regression scenarios previously failing.

## Deliverables
- Updated worker and renderer source code fulfilling scopes A and B.
- This requirements document committed alongside the code changes.

