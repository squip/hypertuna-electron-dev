# Public Gateway Docker Bundle

This directory contains a turnkey docker-compose setup that launches the public gateway, a Redis cache, and a Traefik reverse proxy with automatic Let's Encrypt certificates.

## Quick Start

1. **Install prerequisites**
   - Docker and Docker Compose Plugin (or docker-compose v2)
   - DNS A record pointing `your.domain` at the VPS

2. **Configure secrets**
   ```bash
   cd deploy
   cp .env.example .env
   # edit .env and set:
   # GATEWAY_HOST=your.domain
   # LETSENCRYPT_EMAIL=admin@domain
   # GATEWAY_REGISTRATION_SECRET=openssl rand -hex 32
   ```

3. **Start the stack**
   ```bash
   docker compose up -d --build
   ```

Traefik listens on ports 80/443, requests certificates from Let's Encrypt, and proxies HTTPS traffic to the public gateway container. Redis stores registration state so the gateway can scale horizontally or survive restarts.

## Services

| Service        | Description                                           |
| -------------- | ----------------------------------------------------- |
| `proxy`        | Traefik reverse proxy + automatic TLS certificates    |
| `redis`        | Redis cache for relay registrations                   |
| `public-gateway` | Hypertuna public gateway (builds from repo source)  |

Volumes `traefik-lets` and `redis-data` persist ACME certificates and Redis data respectively.

## Updating

Pull repository updates and rebuild:
```bash
docker compose pull
docker compose up -d --build
```

## Stopping / Removing
```bash
docker compose down
```
Add `-v` to remove persisted volumes.

## Desktop Configuration
In the desktop app, enable the Public Gateway bridge and set the base URL to `https://your.domain` with the same registration secret used above.
