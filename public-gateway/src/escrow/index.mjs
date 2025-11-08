import http from 'node:http';
import https from 'node:https';
import { watch } from 'node:fs';
import express from 'express';
import { config as loadEnv } from 'dotenv';

import { createLogger } from '../logger.mjs';
import { loadEscrowConfig, loadEscrowTlsOptions } from './config.mjs';
import AutobaseKeyEscrowService from './AutobaseKeyEscrowService.mjs';
import { createEscrowRouter } from './AutobaseKeyEscrowRouter.mjs';
import { createEscrowDbPool } from './db/createPool.mjs';
import { escrowMetrics, metricsMiddleware as escrowMetricsMiddleware } from './metrics.mjs';

async function main() {
  loadEnv();
  const logger = createLogger().child({ service: 'AutobaseKeyEscrow' });
  const config = loadEscrowConfig();
  const dbPool = await createEscrowDbPool(config.db, logger);

  const service = new AutobaseKeyEscrowService({ config, logger, dbPool, metrics: escrowMetrics });
  await service.init();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      policy: service.getPolicySnapshot()
    });
  });

  const router = createEscrowRouter({ service });
  app.use(config.basePath || '/api/escrow', router);
  if (config.metrics?.enabled !== false) {
    const metricsPath = config.metrics?.path || '/metrics';
    app.use(escrowMetricsMiddleware(metricsPath));
  }

  const tlsContext = await loadEscrowTlsOptions(config.tls);
  const server = tlsContext
    ? https.createServer(tlsContext.httpsOptions, app)
    : http.createServer(app);

  let stopTlsWatchers = null;
  if (tlsContext?.watchFiles?.length) {
    stopTlsWatchers = setupTlsReload(server, config, logger, tlsContext.watchFiles);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      logger.info({
        host: config.host,
        port: config.port,
        basePath: config.basePath,
        tlsEnabled: Boolean(tlsContext)
      }, 'AutobaseKeyEscrow service listening');
      resolve();
    });
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down escrow service');
    await service.stop();
    await dbPool?.end?.();
    stopTlsWatchers?.();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[EscrowService] Failed to start', error);
  process.exitCode = 1;
});

function setupTlsReload(server, config, logger, watchFiles) {
  const watchers = [];
  let reloadTimer = null;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      reloadTimer = null;
      try {
        const nextContext = await loadEscrowTlsOptions(config.tls);
        if (nextContext?.httpsOptions) {
          server.setSecureContext(nextContext.httpsOptions);
          logger.info('[EscrowTLS] Reloaded TLS certificates');
        }
      } catch (error) {
        logger.error({ err: error }, '[EscrowTLS] Failed to reload TLS certificates');
      }
    }, 300);
  };

  for (const file of watchFiles) {
    try {
      watchers.push(
        watch(file, { persistent: false }, scheduleReload)
      );
    } catch (error) {
      logger.warn({ file, err: error }, '[EscrowTLS] Failed to watch TLS file');
    }
  }
  return () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    watchers.forEach((w) => {
      try {
        w.close();
      } catch (_) {
        // ignore
      }
    });
  };
}
