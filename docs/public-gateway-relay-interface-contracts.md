# Public Gateway Relay Interface Contracts (Phase 0)

This document captures the agreed contracts for the core services that will be implemented during subsequent phases of the public gateway relay integration. The shapes below provide the baseline for implementation work and unit-test scaffolding.

## HyperbeeRelayHost

**Responsibilities**

- Own the writable Hyperbee instance used by the gateway relay.
- Provide lifecycle hooks for initialisation, replication, and graceful shutdown.
- Offer a consistent telemetry surface (stats, replication status, error events).

**Contract**

```ts
export interface HyperbeeRelayHost {
  initialize(options: HyperbeeRelayOptions): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  applyEvent(event: NostrEvent): Promise<HyperbeeApplyResult>;
  replicateWithPeer(peer: RelayPeerDescriptor): Promise<void>;
  getStats(): Promise<HyperbeeRelayStats>;
  registerTelemetrySink(sink: TelemetrySink): () => void;
}
```

See the accompanying type definitions in `shared/types/public-gateway-relay.d.ts` for supporting shapes.

## RelayDispatcherService

**Responsibilities**

- Accept subscription jobs from the websocket controller and assign them to healthy peers.
- Track in-flight work, manage failover, and enforce concurrency limits per peer.
- Surface scheduling metrics for observability and adaptive tuning.

**Contract**

```ts
export interface RelayDispatcherService {
  schedule(job: SubscriptionJob): DispatchDecision;
  acknowledge(jobId: string, result: DispatchOutcome): void;
  fail(jobId: string, reason: DispatchFailure): void;
  reportPeerMetrics(peerId: string, metrics: PeerLoadMetrics): void;
  applyPolicyUpdate(policy: DispatcherPolicy): void;
  shutdown(): Promise<void>;
}
```

## RelayTokenService

**Responsibilities**

- Issue, refresh, verify, and revoke per-peer websocket access tokens.
- Persist token metadata (TTL, sequence numbers) to the configured store.
- Emit signed control frames when tokens are revoked or refreshed.

**Contract**

```ts
export interface RelayTokenService {
  issueToken(peerId: string, context: TokenIssueContext): Promise<IssuedToken>;
  refreshToken(peerId: string, refreshRequest: TokenRefreshRequest): Promise<IssuedToken>;
  revokeToken(peerId: string, options?: TokenRevokeOptions): Promise<void>;
  verifyToken(token: string): Promise<TokenVerificationResult>;
  getTokenState(peerId: string): Promise<TokenState | null>;
}
```

## Knowledge Sharing & Coordination

- **Registration payloads**: Public gateway relay registrations now reply with Hyperbee metadata (`hyperbeeKey`, `discoveryKey`, `replicationTopic`) plus operational hints (`defaultTokenTtl`, `tokenRefreshWindowSeconds`, dispatcher policy weights). Consumers should persist these values and seed replication before marking the relay available.
- **Discovery announcements**: Gateway discovery broadcasts include the relay metadata and policy hints above. Downstream clients MUST tolerate older gateways that omit these fields (treat missing values as null) and should fall back to sane defaults when numbers are absent.
- **Settings schema**: `PublicGatewaySettings` exposes dispatcher and token refresh tuning knobs (`dispatcherMaxConcurrent`, `dispatcherFailureWeight`, `tokenRefreshWindowSeconds`, etc.). Validation should clamp non-positive values back to defaults.

- **Architecture review**: Present the Phase 0 outputs to gateway + worker leads (scheduled once feature flag scaffolding lands).
- **Configuration rollout plan**: Share the new environment toggles with the operations team alongside default values and rollback instructions.
- **Documentation sync**: Ensure desktop and worker maintainers are aware of the new shared type definitions to avoid drift.

These action items should be completed before beginning Phase 1 implementation to guarantee alignment across teams.
