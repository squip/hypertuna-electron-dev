# Blind Peer Registration – Trusted Peer Auto-Onboarding

## Functional Requirements
- **Capture raw Hyperswarm public keys** during protocol setup so downstream flows can forward an actual `Buffer` to `BlindPeerService.addTrustedPeer`.
- **Normalize peer key serialization** in `BlindPeerService` so any incoming representation (raw Buffer, Hypercore ID, or hex string) is canonically stored/forwarded.
- **Maintain symmetric cleanup** ensuring trusted peers added with canonical keys are removed using the same representation when connections close.
- **Prevent regressions** by adding automated coverage that simulates a gateway registration and asserts the trusted peer list increments when a worker registers.

## Task Stubs
1. Extend `PublicGatewayService` connection bookkeeping to retain both the string identifier and the raw Uint8Array for each peer and pass the raw variant during registration.
2. Update `BlindPeerService` sanitization utilities to decode/encode strings into canonical Hypercore identifiers before persisting or delegating to the blind-peer module.
3. Ensure teardown paths (`removeTrustedPeer` and connection cleanup) use the same canonical conversion so removal works when we store normalized keys.
4. Add a targeted unit/integration test that exercises `/gateway/register` with a mocked raw key and verifies the blind-peer service records the trusted peer.
5. Skip automatic trusted-peer removal on routine Hyperswarm disconnects; only untrust peers via explicit revocation/unreachability policies.
6. Extend regression coverage (and supporting telemetry) so `/gateway/register` must result in a blind-peer trusted count greater than zero, and ensure that count survives protocol close events.
