import { Duplex } from 'node:stream';
import * as c from 'compact-encoding';

const REPLICATION_PROTOCOL = 'hypertuna-hyperbee-replication';
const REPLICATION_PROTOCOL_VERSION = 1;

class ProtomuxChannelStream extends Duplex {
  constructor(channel, dataMessage, logger) {
    super();
    this.channel = channel;
    this.dataMessage = dataMessage;
    this.logger = logger;
    this._buffered = [];
    this._readBackpressure = false;
    this._writeBackpressured = false;
    this._pendingWriteCallbacks = [];
    this._closed = false;
  }

  _read() {
    if (!this._readBackpressure || this._buffered.length === 0) {
      return;
    }

    while (this._buffered.length) {
      const chunk = this._buffered.shift();
      if (!this.push(chunk)) {
        this._readBackpressure = true;
        return;
      }
    }

    this._readBackpressure = false;
  }

  _write(chunk, encoding, callback) {
    if (this._closed) {
      callback(new Error('Replication channel closed'));
      return;
    }

    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const drained = this.dataMessage.send(buffer);
      if (drained) {
        callback();
      } else {
        this._writeBackpressured = true;
        this._pendingWriteCallbacks.push(callback);
      }
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    this._closeChannel();
    callback();
  }

  _destroy(error, callback) {
    this._closeChannel(error);
    callback(error);
  }

  pushMessage(message) {
    if (this._closed) return;
    const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);

    if (!this._readBackpressure && this.push(buffer)) {
      return;
    }

    this._readBackpressure = true;
    this._buffered.push(buffer);
  }

  closeFromRemote() {
    if (this._closed) return;
    this._closed = true;
    this._flushPendingWrites(new Error('Replication channel closed by remote peer'));
    this.push(null);
  }

  handleChannelDrain() {
    if (!this._writeBackpressured && this._pendingWriteCallbacks.length === 0) {
      return;
    }
    const callbacks = this._pendingWriteCallbacks.splice(0);
    this._writeBackpressured = false;
    for (const cb of callbacks) {
      try {
        cb();
      } catch (error) {
        this.logger?.debug?.('[HyperbeeReplicationChannel] Pending write callback failed', {
          error: error?.message || error
        });
      }
    }
  }

  _closeChannel(error = null) {
    if (this._closed) return;
    this._closed = true;
    this._flushPendingWrites(error);
    try {
      this.channel.close();
    } catch (error) {
      this.logger?.debug?.('[HyperbeeReplicationChannel] Failed to close replication channel', {
        error: error?.message || error
      });
    }
  }

  _flushPendingWrites(error) {
    if (this._pendingWriteCallbacks.length === 0) {
      this._writeBackpressured = false;
      return;
    }
    const callbacks = this._pendingWriteCallbacks.splice(0);
    this._writeBackpressured = false;
    for (const cb of callbacks) {
      try {
        cb(error || null);
      } catch (err) {
        this.logger?.debug?.('[HyperbeeReplicationChannel] Error flushing pending write callback', {
          error: err?.message || err
        });
      }
    }
  }
}

export async function openHyperbeeReplicationChannel({
  protocol,
  hyperbeeKey,
  discoveryKey = null,
  isInitiator = false,
  role = null,
  replicationMode = null,
  logger = console
}) {
  if (!protocol?.mux) {
    throw new Error('Protocol missing mux for replication channel');
  }

  const handshakePayload = {
    version: REPLICATION_PROTOCOL_VERSION,
    hyperbeeKey,
    discoveryKey,
    isInitiator: !!isInitiator,
    replicationMode: replicationMode || (isInitiator ? 'initiator' : 'responder'),
    role,
    openedAt: Date.now()
  };

  const channel = protocol.mux.createChannel({
    protocol: REPLICATION_PROTOCOL,
    handshake: c.json,
    onopen: (remoteHandshake) => {
      logger?.debug?.('[HyperbeeReplicationChannel] Channel opened', {
        remoteHandshake,
        isInitiator
      });
    },
    onclose: (isRemote) => {
      logger?.debug?.('[HyperbeeReplicationChannel] Channel closed', {
        isInitiator,
        isRemote
      });
      stream?.closeFromRemote();
    },
    ondestroy: () => {
      logger?.debug?.('[HyperbeeReplicationChannel] Channel destroyed', {
        isInitiator
      });
      if (stream && stream.destroyed !== true) {
        stream.destroy();
      }
    },
    ondrain: () => {
      stream?.handleChannelDrain();
    }
  });

  if (!channel) {
    logger?.warn?.('[HyperbeeReplicationChannel] Failed to create replication channel (duplicate?)', {
      hyperbeeKey,
      replicationMode,
      role,
      isInitiator
    });
    throw new Error('Failed to create replication channel (duplicate?)');
  }

  let stream = null;

  const dataMessage = channel.addMessage({
    encoding: c.buffer,
    onmessage: (message) => {
      stream?.pushMessage(message);
    }
  });

  stream = new ProtomuxChannelStream(channel, dataMessage, logger);

  channel.open(Object.fromEntries(
    Object.entries(handshakePayload).filter(([, value]) => value !== undefined && value !== null)
  ));

  const opened = await channel.fullyOpened();
  if (!opened) {
    logger?.warn?.('[HyperbeeReplicationChannel] Replication channel rejected by remote peer', {
      hyperbeeKey,
      replicationMode,
      role,
      isInitiator,
      remoteHandshake: channel?.handshake || null
    });
    stream.destroy(new Error('Replication channel rejected by remote peer'));
    throw new Error('Replication channel rejected by remote peer');
  }

  const remoteHandshake = channel.handshake || null;

  if (remoteHandshake?.hyperbeeKey && remoteHandshake.hyperbeeKey !== hyperbeeKey) {
    const error = new Error('Replication channel mismatch – remote hyperbee key differs');
    logger?.warn?.('[HyperbeeReplicationChannel] Remote handshake key mismatch', {
      expected: hyperbeeKey,
      received: remoteHandshake.hyperbeeKey
    });
    stream.destroy(error);
    throw error;
  }

  return {
    channel,
    stream,
    remoteHandshake
  };
}
