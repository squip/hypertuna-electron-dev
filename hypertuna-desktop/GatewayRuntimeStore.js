const subscribers = new Set();
let runtimeInfo = null;

function cloneInfo(info) {
  if (!info) return null;
  return { ...info };
}

export const GatewayRuntimeStore = {
  getInfo() {
    return cloneInfo(runtimeInfo);
  },
  getWsBase() {
    return runtimeInfo?.wsBaseUrl || null;
  },
  getHttpBase() {
    return runtimeInfo?.httpBaseUrl || null;
  },
  update(info) {
    const nextInfo = info ? { ...info, receivedAt: Date.now() } : null;
    runtimeInfo = nextInfo;
    for (const callback of subscribers) {
      try {
        callback(cloneInfo(runtimeInfo));
      } catch (error) {
        console.error('[GatewayRuntimeStore] Subscriber callback failed:', error);
      }
    }
  },
  subscribe(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('GatewayRuntimeStore.subscribe expects a function');
    }
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }
};

if (typeof window !== 'undefined') {
  window.GatewayRuntimeStore = GatewayRuntimeStore;
}
