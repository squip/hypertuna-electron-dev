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

register.registerMetric(sessionGauge);
register.registerMetric(peerGauge);
register.registerMetric(requestCounter);

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
  metricsMiddleware
};
