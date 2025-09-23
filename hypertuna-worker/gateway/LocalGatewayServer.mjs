import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { promises as dns } from 'node:dns';
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
      tlsOptions = null,
      detectLanAddresses = false,
      detectPublicIp = false,
      publicIpServices = [
        'https://api.ipify.org',
        'https://ifconfig.me/ip',
        'https://icanhazip.com'
      ]
    } = config;

    this.config = {
      hostname,
      ip,
      port,
      protocol,
      listenHost,
      requestHandler,
      tlsOptions,
      detectLanAddresses,
      detectPublicIp,
      publicIpServices
    };

    this.server = null;
    this.wss = null;
    this.localIps = [];
    this.publicIp = null;
  }

  async init() {
    await this.#detectIpAddresses();
    return this;
  }

  async #detectIpAddresses() {
    this.localIps = this.#collectLocalIps();

    if (this.config.ip) {
      if (!this.localIps.includes(this.config.ip)) {
        this.localIps.push(this.config.ip);
      }
    } else {
      const preferred = this.localIps.find(ip => ip !== '127.0.0.1');
      this.config.ip = preferred || '127.0.0.1';
    }

    if (this.config.detectPublicIp) {
      try {
        this.publicIp = await this.#resolvePublicIp();
        if (this.publicIp && !this.localIps.includes(this.publicIp)) {
          this.localIps.push(this.publicIp);
        }
      } catch (error) {
        console.warn('[LocalGatewayServer] Failed to determine public IP:', error.message);
      }
    }

    if (this.config.detectLanAddresses || this.config.detectPublicIp) {
      try {
        const resolved = await dns.lookup(this.config.hostname, { all: true });
        const addresses = resolved.map(entry => entry.address);
        console.log('[LocalGatewayServer] Hostname resolved addresses:', addresses.join(', ') || 'none');
      } catch (error) {
        console.warn('[LocalGatewayServer] Hostname resolution failed:', error.message);
      }
    }
  }

  #collectLocalIps() {
    const ips = new Set(['127.0.0.1']);
    if (!this.config.detectLanAddresses) {
      return Array.from(ips);
    }

    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          ips.add(entry.address);
        }
      }
    }
    return Array.from(ips);
  }

  async #resolvePublicIp() {
    for (const service of this.config.publicIpServices) {
      try {
        const ip = await this.#fetchPublicIp(service);
        if (ip) return ip;
      } catch (error) {
        console.warn(`[LocalGatewayServer] Public IP service failed (${service}):`, error.message);
      }
    }
    return null;
  }

  #fetchPublicIp(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 5000, headers: { 'User-Agent': 'HypertunaGateway/1.0' } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Status code ${res.statusCode}`));
          res.resume();
          return;
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          const ip = data.trim();
          if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
            resolve(ip);
          } else {
            reject(new Error('Invalid IP format'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
    });
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
    if (this.publicIp && this.config.detectPublicIp) {
      urls.public = `${wsProtocol}://${this.publicIp}:${this.config.port}`;
    }
    return urls;
  }

  getIpAddresses() {
    return {
      local: [...this.localIps],
      public: this.publicIp,
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
