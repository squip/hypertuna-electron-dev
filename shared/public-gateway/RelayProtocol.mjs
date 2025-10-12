import Protomux from 'protomux';
import * as c from 'compact-encoding';
import { EventEmitter } from 'node:events';

const REQUEST_TIMEOUT = 30000; // 30 seconds

const httpMessageEncoding = {
  preencode(state, m) {
    c.string.preencode(state, m.method || 'GET');
    c.string.preencode(state, m.path || '/');
    c.string.preencode(state, JSON.stringify(m.headers || {}));
    c.buffer.preencode(state, m.body || Buffer.alloc(0));
  },
  encode(state, m) {
    c.string.encode(state, m.method || 'GET');
    c.string.encode(state, m.path || '/');
    c.string.encode(state, JSON.stringify(m.headers || {}));
    c.buffer.encode(state, m.body || Buffer.alloc(0));
  },
  decode(state) {
    return {
      method: c.string.decode(state),
      path: c.string.decode(state),
      headers: JSON.parse(c.string.decode(state)),
      body: c.buffer.decode(state)
    };
  }
};

const httpResponseEncoding = {
  preencode(state, m) {
    c.uint.preencode(state, m.statusCode || 200);
    c.string.preencode(state, JSON.stringify(m.headers || {}));
    c.buffer.preencode(state, m.body || Buffer.alloc(0));
  },
  encode(state, m) {
    c.uint.encode(state, m.statusCode || 200);
    c.string.encode(state, JSON.stringify(m.headers || {}));
    c.buffer.encode(state, m.body || Buffer.alloc(0));
  },
  decode(state) {
    return {
      statusCode: c.uint.decode(state),
      headers: JSON.parse(c.string.decode(state)),
      body: c.buffer.decode(state)
    };
  }
};

export class RelayProtocol extends EventEmitter {
  constructor(stream, isServer = false, handshakeData = {}) {
    super();
    
    this.isServer = isServer;
    this.handshakeData = handshakeData || {};
    this.stream = stream;
    this.mux = Protomux.from(stream);
    this.channel = null;
    this.requests = new Map(); // For tracking pending requests
    this.requestId = 0;
    this.handlers = new Map(); // For request handlers on server side
    
    this._setupChannel();
  }
  
  _setupChannel() {
    this.channel = this.mux.createChannel({
      protocol: 'hypertuna-relay-v2',
      id: null,
      handshake: c.json,
      onopen: this._onopen.bind(this),
      onclose: this._onclose.bind(this),
      ondestroy: this._ondestroy.bind(this)
    });
    
    if (!this.channel) {
      throw new Error('Failed to create channel - duplicate protocol?');
    }
    
    // Message type 0: HTTP-like request
    this.channel.addMessage({
      encoding: c.json,
      onmessage: this._onrequest.bind(this)
    });
    
    // Message type 1: HTTP-like response
    this.channel.addMessage({
      encoding: c.json,
      onmessage: this._onresponse.bind(this)
    });
    
    // Message type 2: WebSocket frame (for relay messages)
    this.channel.addMessage({
      encoding: c.json,
      onmessage: this._onwsframe.bind(this)
    });
    
    // Message type 3: Health check
    this.channel.addMessage({
      encoding: c.json,
      onmessage: this._onhealthcheck.bind(this)
    });
    
    // Message type 4: Health check response
    this.channel.addMessage({
      encoding: c.json,
      onmessage: this._onhealthresponse.bind(this)
    });

    // Message type 5: Telemetry payloads
    this.channel.addMessage({
      encoding: c.json,
      onmessage: this._ontelemetry.bind(this)
    });
    
    // Open the channel
    const handshake = {
      version: '2.0',
      isServer: this.isServer,
      capabilities: ['http', 'websocket', 'health', 'telemetry']
    };

    if (this.handshakeData && typeof this.handshakeData === 'object') {
      Object.assign(handshake, this.handshakeData);
    }
    this.channel.open(handshake);
  }
  
  _onopen(handshake) {
    this.emit('open', handshake);
  }
  
  _onclose() {
    this.emit('close');
    
    // Reject all pending requests
    for (const [id, request] of this.requests) {
      request.reject(new Error('Channel closed'));
    }
    this.requests.clear();
  }
  
  _ondestroy() {
    this.emit('destroy');
  }
  
  _onrequest(message) {
    // Convert the message to HTTP-like format
    const request = {
      id: message.id,
      method: message.method,
      path: message.path,
      headers: message.headers || {},
      body: message.body ? Buffer.from(message.body) : Buffer.alloc(0)
    };
    
    // Check if we have a handler for this path pattern
    let handled = false;
    for (const [pattern, handler] of this.handlers) {
      const match = this._matchPath(pattern, request.path);
      if (match) {
        request.params = match.params;
        request.query = match.query;
        handled = true;
        
        // Call the handler and send response
        this._handleRequest(request, handler);
        break;
      }
    }
    
    if (!handled) {
      // Emit as generic request if no handler found
      this.emit('request', request);
    }
  }
  
  _matchPath(pattern, path) {
    // Simple path matching with parameter extraction
    const patternParts = pattern.split('/').filter(Boolean);
    const pathParts = path.split('?')[0].split('/').filter(Boolean);
    
    if (patternParts.length !== pathParts.length) return null;
    
    const params = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].substring(1)] = pathParts[i];
      } else if (patternParts[i] !== pathParts[i]) {
        return null;
      }
    }
    
    // Parse query string
    const query = {};
    const queryIndex = path.indexOf('?');
    if (queryIndex !== -1) {
      const queryString = path.substring(queryIndex + 1);
      for (const pair of queryString.split('&')) {
        const [key, value] = pair.split('=');
        query[decodeURIComponent(key)] = decodeURIComponent(value || '');
      }
    }
    
    return { params, query };
  }
  
  async _handleRequest(request, handler) {
    try {
      const response = await handler(request);
      this.sendResponse({
        id: request.id,
        statusCode: response.statusCode || 200,
        headers: response.headers || {},
        body: response.body || Buffer.alloc(0)
      });
    } catch (err) {
      this.sendResponse({
        id: request.id,
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: err.message }))
      });
    }
  }
  
  _onresponse(message) {
    const request = this.requests.get(message.id);
    if (request) {
      clearTimeout(request.timeout);
      this.requests.delete(message.id);
      
      const response = {
        statusCode: message.statusCode,
        headers: message.headers || {},
        body: message.body ? Buffer.from(message.body) : Buffer.alloc(0)
      };
      
      request.resolve(response);
    }
  }
  
  _onwsframe(message) {
    this.emit('wsframe', message);
  }
  
  _onhealthcheck(message) {
    this.sendHealthResponse({
      id: message.id,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        relay: 'active',
        protocol: 'connected'
      }
    });
  }
  
  _onhealthresponse(message) {
    const request = this.requests.get(message.id);
    if (request) {
      clearTimeout(request.timeout);
      this.requests.delete(message.id);
      request.resolve(message);
    }
  }

  _ontelemetry(message) {
    this.emit('telemetry', message);
  }
  
  // Register a request handler for a specific path pattern
  handle(pattern, handler) {
    this.handlers.set(pattern, handler);
  }
  
  // Send an HTTP-like request
  async sendRequest(request) {
    const id = this.requestId++;
    const message = {
      id,
      method: request.method || 'GET',
      path: request.path || '/',
      headers: request.headers || {},
      body: request.body ? Array.from(request.body) : null
    };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('Request timeout'));
      }, REQUEST_TIMEOUT);
      
      this.requests.set(id, { resolve, reject, timeout });
      
      try {
        this.channel.messages[0].send(message);
      } catch (err) {
        clearTimeout(timeout);
        this.requests.delete(id);
        reject(err);
      }
    });
  }
  
  // Send an HTTP-like response
  sendResponse(response) {
    try {
      const message = {
        id: response.id,
        statusCode: response.statusCode || 200,
        headers: response.headers || {},
        body: response.body ? Array.from(response.body) : null
      };
      this.channel.messages[1].send(message);
    } catch (err) {
      console.error('[RelayProtocol] Failed to send response:', err);
    }
  }
  
  // Send a WebSocket frame
  sendWebSocketFrame(frame) {
    try {
      this.channel.messages[2].send(frame);
    } catch (err) {
      console.error('[RelayProtocol] Failed to send WebSocket frame:', err);
    }
  }
  
  // Send a health check
  async sendHealthCheck() {
    const id = this.requestId++;
    const message = {
      id,
      timestamp: new Date().toISOString()
    };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('Health check timeout'));
      }, 5000);
      
      this.requests.set(id, { resolve, reject, timeout });
      
      try {
        this.channel.messages[3].send(message);
      } catch (err) {
        clearTimeout(timeout);
        this.requests.delete(id);
        reject(err);
      }
    });
  }
  
  // Send a health check response
  sendHealthResponse(response) {
    try {
      this.channel.messages[4].send(response);
    } catch (err) {
      console.error('[RelayProtocol] Failed to send health response:', err);
    }
  }

  // Send a telemetry payload
  sendTelemetry(payload) {
    try {
      this.channel.messages[5].send(payload);
    } catch (err) {
      console.error('[RelayProtocol] Failed to send telemetry:', err);
    }
  }
  
  // Register request handler
  registerHandler(path, handler) {
    this.handle(path, handler);
  }
  
  // Destroy protocol
  destroy() {
    if (this.channel) {
      this.channel.close();
    }
    this.requests.clear();
  }
}

export default RelayProtocol;
