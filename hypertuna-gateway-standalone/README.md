# hypertuna-proxy-server
a simple proxy server module to coordinate NOSTR websocket request traffic across a swarm of Hypertuna Relay peers

**Note:**
- This module is an ongoing work-in-progress to be used as part of a larger integrated application, but I'd like to make the current proof-of-concept state available to any NOSTR / Pear builders who may be interested. Feel free to fork, provide feedback / improvements, or use in your project if useful.
- the Hypertuna Proxy Server is currently optimized for use on a local dedicated network with port-forwarding set-up, or on a VPS with a registered domain / encryption certs. using this proxy server module with a local instance of Hypertuna Relay Server is currently for experimental use.

**Set-Up:**
1. `git clone https://github.com/squip/hypertuna-proxy-server`
2. `npm install`
3. run `node hypertuna-proxy-server.js` - this will initialize the proxy server and generate a /certs directory with self-signed .pem files to run the https / wss server.
4. if you are running the Hypertuna Proxy Server instance on your local machine and don't have port-forwarding set-up, import the .pem files in /certs to your OS's keychain access manager
5. navigate to your ip / open port (i.e. https://127.0.0.1:8443) in your browser, click 'proceed' if you encounter a security warning.
6. once proxy server is initialized / running, initialize the Hypertuna Relay Server in a separate terminal
   - follow install / set-up instructions here: https://github.com/squip/hypertuna-relay-server



## Desktop Control Panel (Electron)

The project now includes an Electron-based desktop application that can start or stop the Hypertuna gateway, surface live logs, and monitor the health of connected peers and relays.

### Getting started
1. Install dependencies: `npm install`
2. Launch the desktop app: `npm start`
3. Use the UI to start the gateway (the default configuration is `gateway-config.json` in the project root).

### Useful scripts
- `npm run start:electron` – Launch the Electron shell without attaching to npm's default alias.
- `npm run start:gateway` – Run the Node gateway directly from the terminal for headless usage.

The desktop app streams logs straight from the gateway process and polls the built-in `/health` and `/debug/connections` endpoints to keep the dashboard up to date.
