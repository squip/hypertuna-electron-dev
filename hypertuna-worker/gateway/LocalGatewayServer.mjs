import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';

export class LocalGatewayServer {
  constructor(config = {}) {
    const {
      hostname = 'localhost',
      ip = null,
      port = 8443,
      protocol,
      listenHost = '127.0.0.1',
      requestHandler = null,
      tlsOptions = null
    } = config;

    this.config = {
      hostname,
      ip,
      port,
      protocol,
      listenHost,
      requestHandler,
      tlsOptions
    };

    this.server = null;
    this.wss = null;
    this.localIps = [];
  }

  async init() {
    this.#initializeIpAddresses();
    return this;
  }

  #initializeIpAddresses() {
    const listenHost = this.config.listenHost || '127.0.0.1';
    const primary = this.config.ip || listenHost || '127.0.0.1';
    this.config.ip = primary;
    this.localIps = [primary];
  }

  startServer(connectionHandler, requestHandler, onListening) {
    const httpHandler = typeof requestHandler === 'function'
      ? requestHandler
      : this.config.requestHandler || this.#buildDefaultRequestHandler();

    this.server = this.config.tlsOptions
      ? https.createServer(this.config.tlsOptions, httpHandler)
      : http.createServer(httpHandler);

    this.wss = new WebSocketServer({ server: this.server });

    if (typeof connectionHandler === 'function') {
      this.wss.on('connection', connectionHandler);
    } else {
      this.wss.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress;
        console.log('[LocalGatewayServer] Client connected:', clientIp);
        ws.on('message', (message) => ws.send(message));
      });
    }

    const httpProtocol = this.config.tlsOptions ? 'https' : 'http';
    this.server.listen(this.config.port, this.config.listenHost, () => {
      console.log(`[LocalGatewayServer] Listening on ${httpProtocol}://${this.config.hostname}:${this.config.port}`);
      if (typeof onListening === 'function') {
        Promise.resolve(onListening({
          server: this.server,
          wss: this.wss,
          urls: this.getServerUrls()
        })).catch(error => {
          console.error('[LocalGatewayServer] onListening callback failed:', error);
        });
      }
    });

    return { server: this.server, wss: this.wss };
  }

  stopServer() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getServerUrls() {
    const wsProtocol = this.config.protocol || (this.config.tlsOptions ? 'wss' : 'ws');
    const urls = {
      hostname: `${wsProtocol}://${this.config.hostname}:${this.config.port}`,
      local: this.localIps
        .filter(ip => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))
        .map(ip => `${wsProtocol}://${ip}:${this.config.port}`)
    };
    return urls;
  }

  getIpAddresses() {
    return {
      local: [...this.localIps],
      primary: this.config.ip
    };
  }

  #buildDefaultRequestHandler() {
    const wsProtocol = this.config.protocol || (this.config.tlsOptions ? 'wss' : 'ws');
    return (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Hypertuna Gateway listening on ${wsProtocol}://${this.config.ip}:${this.config.port}\n`);
    };
  }
}

export default LocalGatewayServer;
