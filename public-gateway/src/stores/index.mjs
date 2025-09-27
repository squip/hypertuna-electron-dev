import MemoryRegistrationStore from './MemoryRegistrationStore.mjs';
import RedisRegistrationStore from './RedisRegistrationStore.mjs';

async function createRegistrationStore(config = {}, logger) {
  if (config?.redisUrl) {
    try {
      const store = new RedisRegistrationStore({
        url: config.redisUrl,
        ttlSeconds: config.cacheTtlSeconds,
        prefix: config.redisPrefix,
        logger
      });
      await store.connect();
      logger?.info?.('Using Redis registration store');
      return store;
    } catch (error) {
      logger?.error?.('Failed to initialize Redis registration store, falling back to memory cache', { error: error.message });
    }
  }

  return new MemoryRegistrationStore(config?.cacheTtlSeconds);
}

export {
  createRegistrationStore
};
