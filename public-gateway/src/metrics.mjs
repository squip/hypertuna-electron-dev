import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const sessionGauge = new client.Gauge({
  name: 'gateway_active_sessions',
  help: 'Number of active websocket sessions'
});

const peerGauge = new client.Gauge({
  name: 'gateway_active_peers',
  help: 'Number of active hyperswarm peers'
});

const requestCounter = new client.Counter({
  name: 'gateway_forwarded_messages_total',
  help: 'Count of messages forwarded through the gateway',
  labelNames: ['relay']
});

const relayEventCounter = new client.Counter({
  name: 'gateway_relay_events_total',
  help: 'Count of EVENT frames processed by the gateway relay host',
  labelNames: ['result']
});

const relayReqCounter = new client.Counter({
  name: 'gateway_relay_requests_total',
  help: 'Count of REQ frames processed by the gateway relay pipeline',
  labelNames: ['path']
});

const relayErrorCounter = new client.Counter({
  name: 'gateway_relay_websocket_errors_total',
  help: 'Count of errors encountered while handling relay websocket messages',
  labelNames: ['stage']
});

const relayFallbackReadCounter = new client.Counter({
  name: 'gateway_relay_fallback_reads_total',
  help: 'Count of relay reads served via local replicas',
  labelNames: ['relay', 'reason']
});

const relayFallbackWriteCounter = new client.Counter({
  name: 'gateway_relay_fallback_writes_total',
  help: 'Count of relay EVENT writes handled via local replicas',
  labelNames: ['relay', 'result']
});

const relayReplicaSessionsGauge = new client.Gauge({
  name: 'gateway_relay_replica_sessions',
  help: 'Number of websocket sessions currently served via replica fallback',
  labelNames: ['relay']
});

const relayFallbackDurationHistogram = new client.Histogram({
  name: 'gateway_relay_fallback_duration_seconds',
  help: 'Duration spent serving a websocket session via replica fallback',
  labelNames: ['relay'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120]
});

const relayTokenIssueCounter = new client.Counter({
  name: 'gateway_relay_token_issues_total',
  help: 'Count of relay tokens issued by the gateway',
  labelNames: ['result']
});

const relayTokenRefreshCounter = new client.Counter({
  name: 'gateway_relay_token_refresh_total',
  help: 'Count of relay token refresh operations',
  labelNames: ['result']
});

const relayTokenRevocationCounter = new client.Counter({
  name: 'gateway_relay_token_revocations_total',
  help: 'Count of relay token revocations initiated by the gateway',
  labelNames: ['result']
});

const blindPeerActiveGauge = new client.Gauge({
  name: 'gateway_blind_peer_active',
  help: 'Indicates whether the blind-peer service is active (1) or disabled (0)'
});

const blindPeerTrustedPeersGauge = new client.Gauge({
  name: 'gateway_blind_peer_trusted_peers',
  help: 'Number of trusted peers registered with the blind-peer service'
});

const blindPeerBytesGauge = new client.Gauge({
  name: 'gateway_blind_peer_bytes_allocated',
  help: 'Bytes allocated by the blind-peer storage subsystem'
});

const blindPeerGcRunsCounter = new client.Counter({
  name: 'gateway_blind_peer_gc_runs_total',
  help: 'Count of hygiene/GC runs triggered for the blind-peer service'
});

const blindPeerEvictionsCounter = new client.Counter({
  name: 'gateway_blind_peer_evictions_total',
  help: 'Count of blind-peer core evictions performed by hygiene',
  labelNames: ['reason']
});

const blindPeerMirrorStateGauge = new client.Gauge({
  name: 'gateway_blind_peer_mirror_state',
  help: 'Mirror readiness state (1 = healthy, 0 = stale)',
  labelNames: ['identifier', 'owner', 'type']
});

const blindPeerMirrorLagGauge = new client.Gauge({
  name: 'gateway_blind_peer_mirror_lag_ms',
  help: 'Lag in milliseconds since the mirror last reported activity',
  labelNames: ['identifier', 'owner', 'type']
});

const pendingWritesGauge = new client.Gauge({
  name: 'gateway_pending_writes',
  help: 'Indicates whether a relay currently has pending gateway-authored writes (1 = pending, 0 = clear)',
  labelNames: ['relay']
});

const pendingWritePushCounter = new client.Counter({
  name: 'gateway_pending_write_push_total',
  help: 'Count of pending-write push attempts emitted by the gateway',
  labelNames: ['result']
});

const pendingWritePushWaitHistogram = new client.Histogram({
  name: 'gateway_pending_write_push_wait_seconds',
  help: 'Time between the first pending write and the first worker acknowledgement per relay',
  labelNames: ['relay'],
  buckets: [5, 15, 30, 60, 120, 300, 600]
});

const escrowUnlockCounter = new client.Counter({
  name: 'gateway_escrow_unlock_requests_total',
  help: 'Count of escrow unlock requests issued by the gateway',
  labelNames: ['result']
});

const escrowLeaseGauge = new client.Gauge({
  name: 'gateway_escrow_leases_active',
  help: 'Number of active escrow leases tracked by the gateway per relay',
  labelNames: ['relay']
});

const escrowLeaseRotationCounter = new client.Counter({
  name: 'gateway_escrow_rotation_total',
  help: 'Count of gateway escrow lease rotations/releases grouped by reason/result',
  labelNames: ['reason', 'result']
});

const escrowPolicyRejectionCounter = new client.Counter({
  name: 'gateway_escrow_policy_rejections_total',
  help: 'Count of escrow unlock attempts rejected by policy',
  labelNames: ['reason']
});

const escrowLeaseLagHistogram = new client.Histogram({
  name: 'gateway_escrow_lease_lag_seconds',
  help: 'Time between lease issuance and release/peer recovery',
  labelNames: ['relay', 'reason'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1200]
});

const escrowLeaseExpiryGauge = new client.Gauge({
  name: 'gateway_escrow_lease_time_to_expiry_seconds',
  help: 'Seconds until the current lease expires for each relay (0 when inactive)',
  labelNames: ['relay']
});

const gatewayReplicaFallbackCounter = new client.Counter({
  name: 'gateway_replica_fallback_total',
  help: 'Count of replica fallback events served locally by the gateway',
  labelNames: ['relay', 'mode']
});

register.registerMetric(sessionGauge);
register.registerMetric(peerGauge);
register.registerMetric(requestCounter);
register.registerMetric(relayEventCounter);
register.registerMetric(relayReqCounter);
register.registerMetric(relayErrorCounter);
register.registerMetric(relayFallbackReadCounter);
register.registerMetric(relayFallbackWriteCounter);
register.registerMetric(relayReplicaSessionsGauge);
register.registerMetric(relayFallbackDurationHistogram);
register.registerMetric(relayTokenIssueCounter);
register.registerMetric(relayTokenRefreshCounter);
register.registerMetric(relayTokenRevocationCounter);
register.registerMetric(blindPeerActiveGauge);
register.registerMetric(blindPeerTrustedPeersGauge);
register.registerMetric(blindPeerBytesGauge);
register.registerMetric(blindPeerGcRunsCounter);
register.registerMetric(blindPeerEvictionsCounter);
register.registerMetric(blindPeerMirrorStateGauge);
register.registerMetric(blindPeerMirrorLagGauge);
register.registerMetric(pendingWritesGauge);
register.registerMetric(pendingWritePushCounter);
register.registerMetric(pendingWritePushWaitHistogram);
register.registerMetric(escrowUnlockCounter);
register.registerMetric(escrowLeaseGauge);
register.registerMetric(escrowLeaseRotationCounter);
register.registerMetric(escrowPolicyRejectionCounter);
register.registerMetric(escrowLeaseLagHistogram);
register.registerMetric(escrowLeaseExpiryGauge);
register.registerMetric(gatewayReplicaFallbackCounter);

function metricsMiddleware(path = '/metrics') {
  return async (req, res, next) => {
    if (req.path !== path) return next();
    try {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (error) {
      next(error);
    }
  };
}

export {
  register,
  sessionGauge,
  peerGauge,
  requestCounter,
  relayEventCounter,
  relayReqCounter,
  relayErrorCounter,
  relayFallbackReadCounter,
  relayFallbackWriteCounter,
  relayReplicaSessionsGauge,
  relayFallbackDurationHistogram,
  relayTokenIssueCounter,
  relayTokenRefreshCounter,
  relayTokenRevocationCounter,
  blindPeerActiveGauge,
  blindPeerTrustedPeersGauge,
  blindPeerBytesGauge,
  blindPeerGcRunsCounter,
  blindPeerEvictionsCounter,
  blindPeerMirrorStateGauge,
  blindPeerMirrorLagGauge,
  pendingWritesGauge,
  pendingWritePushCounter,
  pendingWritePushWaitHistogram,
  escrowUnlockCounter,
  escrowLeaseGauge,
  escrowLeaseRotationCounter,
  escrowPolicyRejectionCounter,
  escrowLeaseLagHistogram,
  escrowLeaseExpiryGauge,
  gatewayReplicaFallbackCounter,
  metricsMiddleware
};
