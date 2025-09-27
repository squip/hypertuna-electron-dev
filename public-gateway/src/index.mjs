import { config as loadEnv } from 'dotenv';

import { loadConfig, loadTlsOptions } from './config.mjs';
import { createLogger } from './logger.mjs';
import PublicGatewayService from './PublicGatewayService.mjs';
import { createRegistrationStore } from './stores/index.mjs';

async function main() {
  loadEnv();

  const logger = createLogger();

  try {
    const config = loadConfig();
    const tlsOptions = await loadTlsOptions(config.tls);
    const registrationStore = await createRegistrationStore(config.registration, logger);

    const service = new PublicGatewayService({
      config,
      logger,
      tlsOptions,
      registrationStore
    });

    await service.init();
    await service.start();

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down');
      await service.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down');
      await service.stop();
      process.exit(0);
    });
  } catch (error) {
    logger.error({ err: error }, 'Gateway failed to start');
    process.exitCode = 1;
  }
}

main();
