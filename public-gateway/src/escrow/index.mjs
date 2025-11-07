import http from 'node:http';
import express from 'express';
import { config as loadEnv } from 'dotenv';

import { createLogger } from '../logger.mjs';
import { loadEscrowConfig } from './config.mjs';
import AutobaseKeyEscrowService from './AutobaseKeyEscrowService.mjs';
import { createEscrowRouter } from './AutobaseKeyEscrowRouter.mjs';

async function main() {
  loadEnv();
  const logger = createLogger().child({ service: 'AutobaseKeyEscrow' });
  const config = loadEscrowConfig();

  const service = new AutobaseKeyEscrowService({ config, logger });
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

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      logger.info({
        host: config.host,
        port: config.port,
        basePath: config.basePath
      }, 'AutobaseKeyEscrow service listening');
      resolve();
    });
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down escrow service');
    await service.stop();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[EscrowService] Failed to start', error);
  process.exitCode = 1;
});
