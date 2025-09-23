// local-wss.js - Local HTTP + WS Server Module (no certificates)
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const os = require('os');
const dns = require('dns').promises;

class LocalWSSServer {
  constructor(config = {}) {
    // Default configuration
    this.config = {
      hostname: config.hostname || 'localhost',
      ip: config.ip || null, // Will be auto-detected if null
      port: config.port || 8443,
      detectPublicIp: config.detectPublicIp !== undefined ? config.detectPublicIp : true,
      publicIpServices: config.publicIpServices || [
        'https://api.ipify.org',
        'https://ifconfig.me/ip',
        'https://icanhazip.com'
      ],
      listenHost: config.listenHost || '0.0.0.0',
      requestHandler: config.requestHandler || null,
      tlsOptions: config.tlsOptions || null,
      protocol: config.protocol || (config.tlsOptions ? 'wss' : 'ws'),
      ...config
    };

    this.server = null;
    this.wss = null;
    this.localIps = [];
    this.publicIp = null;
  }

  /**
   * Initialize the module by detecting available network addresses
   */
  async init() {
    console.log('Initializing Local WebSocket Server...');

    // Detect IP addresses
    await this._detectIpAddresses();

    return this;
  }

  /**
   * Detect local and public IP addresses
   * @private
   */
  async _detectIpAddresses() {
    // Get local IP addresses
    this.localIps = this._getLocalIps();
    
    // Use provided IP if specified
    if (this.config.ip) {
      if (!this.localIps.includes(this.config.ip)) {
        this.localIps.push(this.config.ip);
      }
    } else if (this.localIps.length > 0) {
      // Use the first non-localhost IP as the default
      this.config.ip = this.localIps.find(ip => !ip.startsWith('127.') && ip !== 'localhost') || '127.0.0.1';
    }

    console.log(`Detected local IP addresses: ${this.localIps.join(', ')}`);
    console.log(`Using primary IP: ${this.config.ip}`);

    // Get public IP if enabled
    if (this.config.detectPublicIp) {
      try {
        this.publicIp = await this._getPublicIp();
        if (this.publicIp) {
          console.log(`Detected public IP address: ${this.publicIp}`);
          // Add public IP to the list if not already there
          if (!this.localIps.includes(this.publicIp)) {
            this.localIps.push(this.publicIp);
          }
        }
      } catch (error) {
        console.warn(`Warning: Failed to detect public IP address: ${error.message}`);
      }
    }

    // Attempt to resolve hostname to check if it's configured
    try {
      const resolvedIps = await dns.lookup(this.config.hostname, { all: true });
      const resolvedAddresses = resolvedIps.map(entry => entry.address);
      console.log(`Hostname ${this.config.hostname} resolves to: ${resolvedAddresses.join(', ') || 'Not resolvable'}`);
    } catch (error) {
      console.warn(`Warning: Hostname ${this.config.hostname} is not resolvable. You may need to add it to your hosts file.`);
    }
  }

  /**
   * Get all local IP addresses from network interfaces
   * @private
   * @returns {string[]} Array of IP addresses
   */
  _getLocalIps() {
    const interfaces = os.networkInterfaces();
    const ipAddresses = ['127.0.0.1'];
    
    // Get all IPv4 addresses from all network interfaces
    Object.values(interfaces).forEach(iface => {
      iface.forEach(addr => {
        if (addr.family === 'IPv4' && !addr.internal) {
          ipAddresses.push(addr.address);
        }
      });
    });
    
    return [...new Set(ipAddresses)]; // Remove duplicates
  }

  /**
   * Get public IP address from external services
   * @private
   * @returns {Promise<string>} Public IP address
   */
  async _getPublicIp() {
    // Try each service until one works
    for (const service of this.config.publicIpServices) {
      try {
        const ip = await this._fetchPublicIp(service);
        if (ip) return ip;
      } catch (error) {
        console.warn(`Warning: Failed to get public IP from ${service}: ${error.message}`);
      }
    }
    return null;
  }

  /**
   * Fetch public IP from a specific service
   * @private
   * @param {string} url Service URL
   * @returns {Promise<string>} Public IP address
   */
  _fetchPublicIp(url) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, {
        timeout: 5000, // 5 second timeout
        headers: {
          'User-Agent': 'LocalWSSServer/1.0'
        }
      }, (response) => {
        if (response.statusCode !== 200) {
          return reject(new Error(`Status code: ${response.statusCode}`));
        }
        
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => {
          const ip = data.trim();
          // Validate IP format with simple regex
          if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
            resolve(ip);
          } else {
            reject(new Error('Invalid IP format returned'));
          }
        });
      });
      
      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timed out'));
      });
    });
  }

  _buildDefaultRequestHandler() {
    const wsProtocol = this.config.protocol || (this.config.tlsOptions ? 'wss' : 'ws');

    return (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>WebSocket Server</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 20px auto; padding: 0 20px; line-height: 1.6; }
            h1 { color: #333; }
            pre { background-color: #f5f5f5; padding: 10px; border-radius: 5px; overflow-x: auto; }
            .success { color: #2a6e2a; }
            .error { color: #d8000c; }
            button { padding: 8px 16px; margin: 5px 0; cursor: pointer; }
            #status { margin-top: 20px; }
          </style>
        </head>
        <body>
          <h1>WebSocket Server</h1>
          <p>The WebSocket server is running. You can connect to it using:</p>
          <ul>
            <li><strong>Hostname:</strong> ${this.config.hostname}:${this.config.port}</li>
            <li><strong>Local IP:</strong> ${this.config.ip}:${this.config.port}</li>
            ${this.publicIp ? `<li><strong>Public IP:</strong> ${this.publicIp}:${this.config.port} (requires port forwarding)</li>` : ''}
          </ul>
          
          <h2>Quick Test</h2>
          <p>Click the button below to test the WebSocket connection:</p>
          <button id="testBtn">Test Connection</button>
          <div id="status"></div>
          
          <h2>WebSocket Client Example</h2>
          <pre>
  const socket = new WebSocket('${wsProtocol}://${this.config.ip}:${this.config.port}');
  
  socket.onopen = () => {
    console.log('Connected to the server');
    socket.send('Hello from client');
  };
  
  socket.onmessage = (event) => {
    console.log('Received from server:', event.data);
  };
  
  socket.onclose = () => {
    console.log('Disconnected from the server');
  };
          </pre>
          
          <script>
            document.getElementById('testBtn').addEventListener('click', () => {
              const statusEl = document.getElementById('status');
              statusEl.innerHTML = 'Connecting...';
              
              try {
                const socket = new WebSocket('${wsProtocol}://' + window.location.host);
                
                socket.onopen = () => {
                  statusEl.innerHTML = '<span class="success">Connected successfully!</span>';
                  socket.send('Hello from test client');
                };
                
                socket.onmessage = (event) => {
                  statusEl.innerHTML += '<br>Received: ' + event.data;
                };
                
                socket.onclose = () => {
                  statusEl.innerHTML += '<br>Connection closed';
                };
                
                socket.onerror = (error) => {
                  statusEl.innerHTML = '<span class="error">Connection failed: ' + (error.message || 'Unknown error') + '</span>';
                };
              } catch (error) {
                statusEl.innerHTML = '<span class="error">Error: ' + error.message + '</span>';
              }
            });
          </script>
        </body>
        </html>
      `);
    };
  }

  /**
   * Start HTTP and WebSocket server
   * @param {Function} connectionHandler Callback function for new WebSocket connections
   * @param {Function} requestHandler Optional custom HTTP request handler
   * @param {Function} onListening Optional callback invoked once the server is listening
   * @returns {Object} The server and wss instances
   */
  startServer(connectionHandler, requestHandler, onListening) {
    const httpHandler = typeof requestHandler === 'function'
      ? requestHandler
      : this.config.requestHandler || this._buildDefaultRequestHandler();

    if (this.config.tlsOptions) {
      this.server = https.createServer(this.config.tlsOptions, httpHandler);
    } else {
      this.server = http.createServer(httpHandler);
    }

    // Create WebSocket Server
    this.wss = new WebSocket.Server({ server: this.server });

    // Set up connection handler
    if (typeof connectionHandler === 'function') {
      this.wss.on('connection', connectionHandler);
    } else {
      // Default connection handler
      this.wss.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress;
        console.log(`Client connected from ${clientIp}`);
        
        ws.on('message', (message) => {
          console.log(`Received from ${clientIp}: ${message}`);
          // Echo the message back
          ws.send(message);
        });
        
        ws.on('close', () => {
          console.log(`Client disconnected from ${clientIp}`);
        });
      });
    }

    const httpProtocol = this.config.tlsOptions ? 'https' : 'http';

    // Listen on configured interface
    this.server.listen(this.config.port, this.config.listenHost, () => {
      console.log(`WS Server running at ${httpProtocol}://${this.config.hostname}:${this.config.port}`);
      console.log('Also accessible via IP addresses:');
      this.localIps.forEach(ip => {
        console.log(`- ${httpProtocol}://${ip}:${this.config.port}`);
      });
      if (this.publicIp) {
        console.log(`- From external networks: ${httpProtocol}://${this.publicIp}:${this.config.port} (if port is forwarded)`);
      }

      if (typeof onListening === 'function') {
        Promise.resolve(onListening({
          server: this.server,
          wss: this.wss,
          urls: this.getServerUrls()
        })).catch(callbackError => {
          console.error('Error during onListening callback:', callbackError);
        });
      }
    });

    return { server: this.server, wss: this.wss };
  }

  /**
   * Stop the server
   */
  stopServer() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    
    console.log('Server stopped');
  }
  
  /**
   * Get the list of detected IP addresses
   * @returns {Object} Object containing local and public IPs
   */
  getIpAddresses() {
    return {
      local: this.localIps,
      public: this.publicIp,
      primary: this.config.ip
    };
  }
  
  /**
   * Get the server URL(s)
   * @returns {Object} Object containing server URLs
   */
  getServerUrls() {
    const wsProtocol = this.config.protocol || (this.config.tlsOptions ? 'wss' : 'ws');
    const urls = {
      hostname: `${wsProtocol}://${this.config.hostname}:${this.config.port}`,
      local: this.localIps
        .filter(ip => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip))
        .map(ip => `${wsProtocol}://${ip}:${this.config.port}`)
    };
    
    if (this.publicIp) {
      urls.public = `${wsProtocol}://${this.publicIp}:${this.config.port}`;
    }
    
    return urls;
  }

  /**
   * Check if port forwarding is configured properly for public access
   * @returns {Promise<boolean>} Is port forwarding configured
   */
  async checkPortForwarding() {
    if (!this.publicIp) {
      console.warn('Cannot check port forwarding without a public IP');
      return false;
    }
    
    try {
      const url = `http://${this.publicIp}:${this.config.port}`;
      console.log(`Checking port forwarding by connecting to ${url}`);
      
      // Attempt to connect to our own server through the public IP
      // This may not work from inside some networks due to NAT loopback limitations
      return new Promise((resolve) => {
        const req = http.get(url, {
          timeout: 5000,
        }, (res) => {
          resolve(res.statusCode === 200);
          res.destroy();
        });
        
        req.on('error', () => {
          resolve(false);
        });
        
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
    } catch (error) {
      console.warn(`Port forwarding check failed: ${error.message}`);
      return false;
    }
  }
}

module.exports = LocalWSSServer;
