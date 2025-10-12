import b4a from 'b4a';

const HEX_EVENT_ID = /^[0-9a-f]{64}$/i;
const DEFAULT_MAX_SCAN = 4096;

function coerceLimit(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num <= 0) return 0;
  return Math.floor(num);
}

function ensureString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return JSON.stringify(value);
  }
  return String(value);
}

export default class PublicGatewayHyperbeeAdapter {
  constructor({ relayClient = null, logger = console, maxIndexScan = DEFAULT_MAX_SCAN } = {}) {
    this.logger = logger;
    this.maxIndexScan = Number.isFinite(maxIndexScan) && maxIndexScan > 0
      ? Math.floor(maxIndexScan)
      : DEFAULT_MAX_SCAN;
    this.relayClient = null;
    this.setRelayClient(relayClient);
  }

  setRelayClient(relayClient) {
    this.relayClient = relayClient || null;
  }

  get hyperbee() {
    if (!this.relayClient) return null;
    if (typeof this.relayClient.getHyperbee === 'function') {
      return this.relayClient.getHyperbee();
    }
    return this.relayClient.db || null;
  }

  get core() {
    if (!this.relayClient) return null;
    if (typeof this.relayClient.getCore === 'function') {
      return this.relayClient.getCore();
    }
    return this.relayClient.core || null;
  }

  hasReplica() {
    return !!this.hyperbee;
  }

  async getReplicaStats() {
    const core = this.core;
    if (!core) {
      return {
        length: 0,
        downloaded: 0,
        lag: 0
      };
    }

    try {
      const info = await core.info?.().catch(() => null);
      const length = info?.length ?? (typeof core.length === 'number' ? core.length : 0);
      const downloaded = info?.contiguousLength ?? (typeof core.contiguousLength === 'number' ? core.contiguousLength : 0);
      return {
        length,
        downloaded,
        lag: Math.max(0, length - downloaded)
      };
    } catch (error) {
      this.logger?.debug?.('[PublicGatewayHyperbeeAdapter] Failed to read replica stats', {
        error: error?.message || error
      });
      const length = typeof core.length === 'number' ? core.length : 0;
      const contiguous = typeof core.contiguousLength === 'number' ? core.contiguousLength : 0;
      return {
        length,
        downloaded: contiguous,
        lag: Math.max(0, length - contiguous)
      };
    }
  }

  async query(filters = [], options = {}) {
    if (!this.hasReplica()) {
      return {
        events: [],
        stats: {
          served: false,
          reason: 'replica-unavailable'
        }
      };
    }

    const resultMap = new Map();
    let truncated = false;

    for (const filter of Array.isArray(filters) ? filters : []) {
      if (!filter || typeof filter !== 'object') continue;

      const limit = coerceLimit(filter.limit);
      if (limit === 0) {
        truncated = truncated || false;
        continue;
      }

      try {
        const { events, truncated: wasTruncated } = await this.#querySingleFilter(filter, { ...options, limit });
        for (const event of events) {
          if (!event?.id) continue;
          resultMap.set(event.id, event);
        }
        truncated = truncated || wasTruncated;
      } catch (error) {
        this.logger?.debug?.('[PublicGatewayHyperbeeAdapter] Filter query error', {
          error: error?.message || error
        });
      }
    }

    const events = Array.from(resultMap.values());
    events.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));

    return {
      events,
      stats: {
        served: true,
        truncated,
        returned: events.length
      }
    };
  }

  async #querySingleFilter(filter, options) {
    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      return this.#queryByIds(filter, options);
    }
    return this.#queryByIndexes(filter, options);
  }

  async #queryByIds(filter, options) {
    const events = [];
    let truncated = false;
    const limit = options.limit;

    for (const id of filter.ids) {
      if (limit && events.length >= limit) {
        truncated = true;
        break;
      }
      const event = await this.#getEventById(id);
      if (!event) continue;
      if (!this.#eventMatchesFilter(event, filter)) continue;
      events.push(event);
    }

    events.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));
    if (limit && events.length > limit) {
      events.splice(limit);
      truncated = true;
    }

    return { events, truncated };
  }

  async #queryByIndexes(filter, options) {
    const groups = this.#buildQueryGroups(filter);
    if (groups.length === 0) {
      return { events: [], truncated: false };
    }

    const scanCap = this.#computeScanCap(options.limit);
    const groupResultSets = [];

    for (const group of groups) {
      const union = new Set();
      for (const query of group) {
        const ids = await this.#scanIndex(query, scanCap);
        for (const id of ids) union.add(id);
      }
      if (union.size === 0) {
        return { events: [], truncated: false };
      }
      groupResultSets.push(union);
    }

    let candidateIds = groupResultSets.shift();
    for (const set of groupResultSets) {
      candidateIds = this.#intersectSets(candidateIds, set);
      if (!candidateIds.size) {
        return { events: [], truncated: false };
      }
    }

    const events = [];
    const limit = options.limit || this.maxIndexScan;
    for (const id of candidateIds) {
      if (limit && events.length >= limit) {
        return { events, truncated: true };
      }
      const event = await this.#getEventById(id);
      if (!event) continue;
      if (!this.#eventMatchesFilter(event, filter)) continue;
      events.push(event);
    }

    events.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));
    if (limit && events.length > limit) {
      events.splice(limit);
      return { events, truncated: true };
    }

    return { events, truncated: false };
  }

  async #scanIndex(query, scanCap) {
    const hyperbee = this.hyperbee;
    if (!hyperbee) return [];

    const { index, values, order = 'desc' } = query;
    if (!index || !Array.isArray(values) || !values.length) {
      return [];
    }

    const indexPrefix = `idx:${index}:`;
    const ids = new Set();

    for (const value of values) {
      const target = `${indexPrefix}${value}`;
      const iterator = hyperbee.createReadStream({
        gte: b4a.from(target),
        lte: b4a.from(`${target}\uffff`),
        reverse: order === 'desc'
      });

      for await (const { value: raw } of iterator) {
        if (ids.size >= scanCap) break;
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.id) {
            ids.add(parsed.id);
          }
        } catch (_) {}
      }
    }

    return Array.from(ids);
  }

  #computeScanCap(limit) {
    if (!Number.isFinite(limit) || limit <= 0) {
      return this.maxIndexScan;
    }
    return Math.min(this.maxIndexScan, Math.max(1, Math.floor(limit * 4)));
  }

  #intersectSets(a, b) {
    const result = new Set();
    for (const value of a) {
      if (b.has(value)) {
        result.add(value);
      }
    }
    return result;
  }

  async #getEventById(id) {
    if (!HEX_EVENT_ID.test(id)) {
      return null;
    }

    const hyperbee = this.hyperbee;
    if (!hyperbee) return null;

    const key = b4a.from(id, 'hex');
    const result = await hyperbee.get(key);
    if (!result?.value) return null;

    try {
      return JSON.parse(result.value);
    } catch (error) {
      this.logger?.debug?.('[PublicGatewayHyperbeeAdapter] Failed to parse event JSON', {
        id,
        error: error?.message || error
      });
      return null;
    }
  }

  #eventMatchesFilter(event, filter) {
    if (!event || typeof event !== 'object') return false;

    if (Array.isArray(filter.kinds) && filter.kinds.length > 0) {
      if (!filter.kinds.includes(event.kind)) {
        return false;
      }
    }

    if (Array.isArray(filter.authors) && filter.authors.length > 0) {
      if (!filter.authors.includes(event.pubkey)) {
        return false;
      }
    }

    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      if (!filter.ids.includes(event.id)) {
        return false;
      }
    }

    if (Array.isArray(filter['#d']) && filter['#d'].length > 0) {
      const dTags = (event.tags || []).filter(([t]) => t === 'd').map(([, value]) => value);
      const matchesD = filter['#d'].some(tag => dTags.includes(tag));
      if (!matchesD) {
        return false;
      }
    }

    if (Array.isArray(filter['#p']) && filter['#p'].length > 0) {
      const pTags = (event.tags || []).filter(([t]) => t === 'p').map(([, value]) => value);
      const matchesP = filter['#p'].some(tag => pTags.includes(tag));
      if (!matchesP) {
        return false;
      }
    }

    if (filter.since && Number.isFinite(filter.since)) {
      if ((event.created_at || 0) < filter.since) {
        return false;
      }
    }

    if (filter.until && Number.isFinite(filter.until)) {
      if ((event.created_at || 0) > filter.until) {
        return false;
      }
    }

    return true;
  }

  #buildQueryGroups(filter) {
    const groups = [];

    const tagGroups = [];
    for (const [key, value] of Object.entries(filter)) {
      if (!key.startsWith('#') || !Array.isArray(value) || value.length === 0) continue;
      const cleanKey = key.slice(1);
      tagGroups.push({ index: `tag:${cleanKey}`, values: value });
    }

    if (tagGroups.length) {
      groups.push(tagGroups);
    }

    const authorValues = Array.isArray(filter.authors) ? filter.authors.filter(Boolean) : [];
    if (authorValues.length) {
      groups.push([{ index: 'author', values: authorValues }]);
    }

    const kindValues = Array.isArray(filter.kinds) ? filter.kinds.filter(v => Number.isFinite(v)) : [];
    if (kindValues.length) {
      groups.push([{ index: 'kind', values: kindValues }]);
    }

    return groups;
  }
}

