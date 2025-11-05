// this is the script for /backend/hypertuna-relay-helper.mjs:
import Autobase from 'autobase';
import b4a from 'b4a';
import Hyperbee from 'hyperbee';

export default class Autobee extends Autobase {
  constructor (store, bootstrap, handlers = {}) {
    if (bootstrap && typeof bootstrap !== 'string' && !b4a.isBuffer(bootstrap)) {
      handlers = bootstrap
      bootstrap = null
    }

    const open = (viewStore) => {
      const core = viewStore.get('autobee')
      return new Hyperbee(core, {
        ...handlers,
        extension: false
      })
    }

    const apply = 'apply' in handlers ? handlers.apply : Autobee.apply;

    try {
        super(store, bootstrap, { ...handlers, open, apply });
  
        if (!this.subscriptions) {
          this.subscriptions = new Map();
        }
  
        this.cleanupInterval = setInterval(() => this.cleanupSubscriptions(), 5 * 60 * 1000);
      } catch (error) {
        console.error('Error initializing Autobee:', error);
        throw error;
      }
    }
  

  cleanupSubscriptions() {
    const now = Date.now();
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (now - subscription.lastActivity > 30 * 60 * 1000) { // 30 minutes
        this.unsubscribe(subscriptionId);
      }
    }
  }

  // Add this method to properly clean up when the instance is no longer needed
  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    // Add any other necessary cleanup logic here
  }

  static async apply (batch, view, base) {
    const b = view.batch({ update: false })
    const decodeKey = (x) => b4a.isBuffer(x) && view.keyEncoding
      ? view.keyEncoding.decode(x)
      : x
  
    try {
      for (const node of batch) {
        const op = node.value
        if (op.type === 'put') {
          const encKey = decodeKey(op.key)
          await b.put(encKey, op.value, op.opts)
        } else if (op.type === 'del') {
          const encKey = decodeKey(op.key)
          await b.del(encKey, op.opts)
        } else {
          console.warn(`Unknown operation type: ${op.type}`)
        }
      }
  
      await b.flush()
    } catch (error) {
      console.error('Error applying batch:', error)
      throw error // Re-throw the error to be handled by the caller
    }
  }

  _getEncodedKey (key, opts) {
    // Apply keyEncoding option if provided.
    // The key is preencoded so that the encoding survives being deserialized
    // from the input core
    const encKey = opts && opts.keyEncoding
      ? opts.keyEncoding.encode(key)
      : key

    // Clear keyEncoding from options as it has now been applied
    if (opts && opts.keyEncoding) {
      delete opts.keyEncoding
    }

    return encKey
  }

  async append(value) {
    try {
      await super.append(value);
      return this._bump(); // Ensure we return the Promise from _bump()
    } catch (error) {
      console.error('Error in append operation:', error);
      throw error;
    }
  }
  

  async put(key, value, opts) {
    try {
      await this.append({
        type: 'put',
        key: this._getEncodedKey(key, opts),
        value,
        opts
      });
    } catch (error) {
      console.error('Error in put operation:', error);
      throw error; // Re-throw or handle as appropriate
    }
  }

  async del(key, opts) {
    try {
      const encKey = this._getEncodedKey(key, opts);
      await this.append({
        type: 'del',
        key: encKey,
        opts
      });
    } catch (error) {
      console.error('Error in del operation:', error);
      throw error;
    }
  }

  get (key, opts) {
    return this.view.get(key, opts)
  }

  peek (opts) {
    return this.view.peek(opts)
  }

  createReadStream(range, opts) {
    if (!this.view) {
      throw new Error('View is not initialized');
    }
    return this.view.createReadStream(range, opts);
  }
  
  get core () {
    return this.localWriter?.core || this.local || null;
  }

  get wakeupCapability () {
    if (this._wakeupCapability) return this._wakeupCapability;
    const core = this.localWriter?.core || this.local || null;
    return core?.wakeupCapability || null;
  }

  set wakeupCapability(value) {
    this._wakeupCapability = value;
    if (this.localWriter?.core) this.localWriter.core.wakeupCapability = value;
    if (this.local) this.local.wakeupCapability = value;
  }
}
