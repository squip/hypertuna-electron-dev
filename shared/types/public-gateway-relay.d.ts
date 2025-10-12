// Type definitions supporting the public gateway relay integration (Phase 0)
// These interfaces formalise the contracts referenced in docs/public-gateway-relay-interface-contracts.md
// and should be kept in sync with runtime implementations as phases progress.

export interface NostrTag extends Array<string> {}

export interface NostrEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: NostrTag[];
  content: string;
  sig: string;
}

export interface HyperbeeRelayOptions {
  storageDir: string;
  writable: boolean;
  discoveryKeyHex: string;
  adminKeyPair: {
    publicKey: string;
    secretKey: string;
  };
  statsIntervalMs?: number;
  replicationTopic?: string;
}

export interface HyperbeeApplyResult {
  id: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}

export interface RelayPeerDescriptor {
  peerId: string;
  publicKey: string;
  connectionInfo?: Record<string, unknown>;
}

export interface HyperbeeRelayStats {
  version: number;
  eventCount: number;
  lastAppendAt?: number;
  replicationPeers: Array<{ peerId: string; lastSyncAt?: number; lagBlocks?: number }>;
}

export interface GatewayRelayMetadata {
  hyperbeeKey: string | null;
  discoveryKey?: string | null;
  replicationTopic?: string | null;
  defaultTokenTtl?: number | null;
  tokenRefreshWindowSeconds?: number | null;
  dispatcher?: DispatcherPolicy | null;
}

export interface GatewayRegistrationResponse {
  status: string;
  hyperbee?: GatewayRelayMetadata | null;
}

export interface TelemetrySink {
  (event: TelemetryEvent): void;
}

export interface TelemetryEvent {
  type: 'hyperbee-append' | 'hyperbee-error' | 'replication' | 'dispatcher';
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface HyperbeeRelayHost {
  initialize(options: HyperbeeRelayOptions): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  applyEvent(event: NostrEvent): Promise<HyperbeeApplyResult>;
  replicateWithPeer(peer: RelayPeerDescriptor): Promise<void>;
  getStats(): Promise<HyperbeeRelayStats>;
  registerTelemetrySink(sink: TelemetrySink): () => void;
}

export interface SubscriptionJob {
  id: string;
  filters: Array<Record<string, unknown>>;
  requester: RelayPeerDescriptor;
  createdAt: number;
}

export interface DispatchDecision {
  jobId: string;
  assignedPeer: string | null;
  status: 'queued' | 'assigned' | 'rejected';
  reason?: string;
}

export interface DispatchOutcome {
  jobId: string;
  peerId: string;
  deliveredCount: number;
  completedAt: number;
}

export interface DispatchFailure {
  jobId: string;
  peerId: string;
  error: string;
  retryable: boolean;
}

export interface PeerLoadMetrics {
  peerId: string;
  latencyMs: number;
  inFlightJobs: number;
  failureRate: number;
  hyperbeeVersion?: number;
  hyperbeeLag?: number;
  reportedAt: number;
  queueDepth?: number;
  tokenExpiresAt?: number;
}

export interface DispatcherPolicy {
  maxConcurrentJobsPerPeer: number;
  maxFailureRate: number;
  reassignOnLagBlocks?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerDurationMs?: number;
  inFlightWeight?: number;
  latencyWeight?: number;
  failureWeight?: number;
}

export interface RelayDispatcherService {
  schedule(job: SubscriptionJob): DispatchDecision;
  acknowledge(jobId: string, result: DispatchOutcome): void;
  fail(jobId: string, reason: DispatchFailure): void;
  reportPeerMetrics(peerId: string, metrics: PeerLoadMetrics): void;
  applyPolicyUpdate(policy: DispatcherPolicy): void;
  shutdown(): Promise<void>;
}

export interface TokenIssueContext {
  scopes: string[];
  ttlSeconds: number;
  issuedBy: string;
  sequence: number;
}

export interface TokenRefreshRequest {
  token: string;
  sequence: number;
  requestedTtlSeconds?: number;
}

export interface TokenRevokeOptions {
  reason?: string;
  sequence?: number;
  broadcast?: boolean;
}

export interface IssuedToken {
  token: string;
  expiresAt: number;
  sequence: number;
}

export interface TokenVerificationResult {
  valid: boolean;
  peerId?: string;
  expiresAt?: number;
  reason?: string;
}

export interface TokenState {
  peerId: string;
  token: string;
  expiresAt: number;
  sequence: number;
  lastRefreshedAt: number;
  refreshAfter?: number;
  pubkey?: string | null;
  scope?: string | null;
  relayAuthToken?: string | null;
  revokedAt?: number | null;
}

export interface RelayTokenService {
  issueToken(peerId: string, context: TokenIssueContext): Promise<IssuedToken>;
  refreshToken(peerId: string, refreshRequest: TokenRefreshRequest): Promise<IssuedToken>;
  revokeToken(peerId: string, options?: TokenRevokeOptions): Promise<void>;
  verifyToken(token: string): Promise<TokenVerificationResult>;
  getTokenState(peerId: string): Promise<TokenState | null>;
}

export interface PeerHeartbeatPayload extends PeerLoadMetrics {
  peerId: string;
  gatewayRelayVersion?: string;
  queueDepth?: number;
}
