import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const unlockCounter = new client.Counter({
  name: 'escrow_unlock_total',
  help: 'Count of escrow unlock requests processed by the escrow service',
  labelNames: ['result']
});

const policyRejectionCounter = new client.Counter({
  name: 'escrow_policy_rejections_total',
  help: 'Count of escrow unlock requests rejected by policy evaluation',
  labelNames: ['reason']
});

const activeLeaseGauge = new client.Gauge({
  name: 'escrow_active_leases',
  help: 'Current number of active writer leases stored in the escrow service'
});

const unlockDurationHistogram = new client.Histogram({
  name: 'escrow_unlock_duration_seconds',
  help: 'Time spent handling escrow unlock requests end-to-end',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});

function recordUnlock(result) {
  const label = typeof result === 'string' && result.trim().length ? result.trim() : 'unknown';
  unlockCounter.labels(label).inc();
}

function recordPolicyRejection(reasons = []) {
  const list = Array.isArray(reasons) && reasons.length ? reasons : ['unknown'];
  for (const reason of list) {
    const label = typeof reason === 'string' && reason.trim().length ? reason.trim() : 'unknown';
    policyRejectionCounter.labels(label).inc();
  }
}

function setActiveLeases(count = 0) {
  const value = Number.isFinite(count) && count >= 0 ? count : 0;
  activeLeaseGauge.set(value);
}

function observeUnlockDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  unlockDurationHistogram.observe(seconds);
}

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

const escrowMetrics = {
  recordUnlock,
  recordPolicyRejection,
  setActiveLeases,
  observeUnlockDuration
};

export {
  register,
  escrowMetrics,
  metricsMiddleware,
  recordUnlock,
  recordPolicyRejection,
  setActiveLeases,
  observeUnlockDuration
};
