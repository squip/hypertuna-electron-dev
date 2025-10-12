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
      const downloaded = await core.downloaded();
      const length = core.length;
      return {
        length,
        downloaded,
        lag: Math.max(0, length - downloaded)
      };
    } catch (error) {
      this.logger?.debug?.('[PublicGatewayHyperbeeAdapter] Failed to read replica stats', {
        error: error?.message || error
      });
      return {
        length: core.length || 0,
        downloaded: 0,
        lag: core.length || 0
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
    for (const id of candidateIds) {
      if (options.limit && events.length >= options.limit) break;
      const event = await this.#getEventById(id);
      if (!event) continue;
      if (!this.#eventMatchesFilter(event, filter)) continue;
      events.push(event);
    }

    events.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));

    let truncated = false;
    if (options.limit && events.length > options.limit) {
      events.splice(options.limit);
      truncated = true;
    }

    return { events, truncated };
  }

  async #scanIndex(query, limit) {
    const db = this.hyperbee;
    if (!db) return [];

    const ids = [];
    const streamOptions = { ...query };
    if (limit && limit > 0) {
      streamOptions.limit = limit;
    }

    try {
      for await (const entry of db.createReadStream(streamOptions)) {
        if (!entry?.value) continue;
        ids.push(ensureString(entry.value));
        if (limit && ids.length >= limit) break;
      }
    } catch (error) {
      this.logger?.debug?.('[PublicGatewayHyperbeeAdapter] Range scan failed', {
        error: error?.message || error
      });
    }

    return ids;
  }

  #intersectSets(left, right) {
    if (!left || !right) return new Set();
    const result = new Set();
    const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
    for (const value of smaller) {
      if (larger.has(value)) result.add(value);
    }
    return result;
  }

  async #getEventById(id) {
    if (typeof id !== 'string' || !HEX_EVENT_ID.test(id)) {
      return null;
    }

    const db = this.hyperbee;
    if (!db) return null;

    try {
      const key = b4a.from(id, 'hex');
      const node = await db.get(key);
      if (!node || node.value === undefined || node.value === null) {
        return null;
      }
      const raw = ensureString(node.value);
      try {
        return JSON.parse(raw);
      } catch (error) {
        this.logger?.debug?.('[PublicGatewayHyperbeeAdapter] Failed to parse event JSON', {
          error: error?.message || error
        });
        return null;
      }
    } catch (error) {
      this.logger?.debug?.('[PublicGatewayHyperbeeAdapter] Failed to load event', {
        error: error?.message || error
      });
      return null;
    }
  }

  #eventMatchesFilter(event, filter) {
    if (!event) return false;

    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      if (!filter.ids.includes(event.id)) return false;
    }

    if (Array.isArray(filter.kinds) && filter.kinds.length > 0) {
      if (!filter.kinds.includes(event.kind)) return false;
    }

    if (Array.isArray(filter.authors) && filter.authors.length > 0) {
      if (!filter.authors.includes(event.pubkey)) return false;
    }

    const sinceTs = this.#coerceOptionalTimestamp(filter.since);
    const untilTs = this.#coerceOptionalTimestamp(filter.until);
    const created = Number(event.created_at) || 0;
    if (sinceTs !== null && created < sinceTs) return false;
    if (untilTs !== null && created > untilTs) return false;

    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#') || key.length !== 2) continue;
      if (!Array.isArray(values) || values.length === 0) continue;
      const tagName = key.slice(1);
      const tagMatches = Array.isArray(event.tags)
        ? event.tags.some((tag) => tag[0] === tagName && values.includes(tag[1]))
        : false;
      if (!tagMatches) return false;
    }

    return true;
  }

  #buildQueryGroups(filter) {
    const since = this.#coerceTimestamp(filter.since);
    const until = this.#coerceTimestamp(filter.until, 9999999999);
    const groups = [];

    const hasKindFilters = Array.isArray(filter.kinds) && filter.kinds.length > 0;
    const hasAuthorFilters = Array.isArray(filter.authors) && filter.authors.length > 0;
    const tagGroups = this.#buildTagGroups(filter, since, until);

    if (!hasKindFilters && !hasAuthorFilters && tagGroups.length === 0) {
      groups.push([this.#constructTimeRangeQuery(since, until)]);
      return groups;
    }

    if (hasKindFilters) {
      const kindGroup = filter.kinds
        .filter((kind) => Number.isInteger(kind))
        .map((kind) => this.#constructKindRangeQuery(kind, since, until));
      if (kindGroup.length) groups.push(kindGroup);
    }

    if (hasAuthorFilters) {
      const authorGroup = filter.authors
        .filter((author) => typeof author === 'string')
        .map((author) => this.#constructAuthorRangeQuery(author, since, until));
      if (authorGroup.length) groups.push(authorGroup);
    }

    groups.push(...tagGroups);

    if (groups.length === 0) {
      groups.push([this.#constructTimeRangeQuery(since, until)]);
    }

    return groups;
  }

  #buildTagGroups(filter, since, until) {
    const groups = [];
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#') || key.length !== 2) continue;
      if (!Array.isArray(values) || values.length === 0) continue;
      const tagName = key.slice(1);
      const group = values
        .map((tagValue) => this.#constructTagRangeQuery(tagName, tagValue, since, until))
        .filter(Boolean);
      if (group.length) groups.push(group);
    }
    return groups;
  }

  #constructTimeRangeQuery(since, until) {
    const gte = b4a.from(`created_at:${this.#padTimestamp(since)}:id:`, 'utf8');
    const lte = b4a.from(`created_at:${this.#padTimestamp(until)}:id:#`, 'utf8');
    return { gte, lte };
  }

  #constructKindRangeQuery(kind, since, until) {
    const paddedKind = this.#padNumber(kind, 5);
    const gte = b4a.from(`kind:${paddedKind}:created_at:${this.#padTimestamp(since)}:id:`, 'utf8');
    const lte = b4a.from(`kind:${paddedKind}:created_at:${this.#padTimestamp(until)}:id:#`, 'utf8');
    return { gte, lte };
  }

  #constructAuthorRangeQuery(author, since, until) {
    const gte = b4a.from(`pubkey:${author}:created_at:${this.#padTimestamp(since)}:id:`, 'utf8');
    const lte = b4a.from(`pubkey:${author}:created_at:${this.#padTimestamp(until)}:id:#`, 'utf8');
    return { gte, lte };
  }

  #constructTagRangeQuery(tagName, tagValue, since, until) {
    if (typeof tagValue !== 'string') return null;
    const gte = b4a.from(`tagKey:${tagName}:tagValue:${tagValue}:created_at:${this.#padTimestamp(since)}:id:`, 'utf8');
    const lte = b4a.from(`tagKey:${tagName}:tagValue:${tagValue}:created_at:${this.#padTimestamp(until)}:id:#`, 'utf8');
    return { gte, lte };
  }

  #computeScanCap(limit) {
    if (Number.isInteger(limit) && limit > 0) {
      return Math.min(this.maxIndexScan, Math.max(limit * 4, 16));
    }
    return this.maxIndexScan;
  }

  #padNumber(num, length) {
    return String(num).padStart(length, '0');
  }

  #padTimestamp(timestamp) {
    return String(timestamp).padStart(10, '0');
  }

  #coerceTimestamp(value, fallback = 0) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.floor(num));
  }

  #coerceOptionalTimestamp(value) {
    if (value === undefined || value === null) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.floor(num);
  }
}
