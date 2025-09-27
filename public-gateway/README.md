# Public Gateway Revamp

This document captures the high-level goals and task breakdown for reviving a public Hyperswarm-backed gateway that reuses the existing relay protocol end-to-end.

## Goals
- Allow remote clients to reach user-hosted relays via a public HTTPS/WebSocket edge.
- Preserve existing worker-side behaviour while proxying traffic over Hyperswarm using the shared `RelayProtocol`.
- Support optional observability and security features so the gateway can operate in shared infrastructure.

## Deliverables
1. **Shared Hyperswarm Client Library**
   - Extract/rewrite the legacy gateway client into an ES module that can be consumed by the public gateway.
   - Responsibilities: connection pooling, health checks, forwarding of HTTP/WebSocket frames, event streaming.

2. **Public Gateway Service**
   - New Node.js service (Express + `ws`) that terminates HTTPS/WebSocket, validates tokens, and bridges messages to the shared client library.
   - Provide configuration via env/config file for bind address, TLS, Redis, metrics, etc.

3. **Registration and Auth Flow**
   - Worker API endpoint to register a relay with the public gateway.
   - Signed registration payloads and token generation/validation utilities shared between worker and gateway.

4. **Session & Event Plumbing**
   - Adapter that mirrors `handleWebSocket` semantics: connection bookkeeping, message queueing, event polling, error propagation.
   - Health-check scheduling and failover matching the worker’s expectations.

5. **Observability & Ops** (optional but planned)
   - Structured logging hooks.
   - Prometheus-style metrics exporter (sessions, peer health, throughput).
   - Rate limiting and per-token usage accounting.

6. **Documentation & Tooling**
   - Deployment instructions (Dockerfile, env sample).
   - Developer testing workflow for end-to-end relay access through the public gateway.

## Task Breakdown
- [x] Create shared client module under `shared/public-gateway/HyperswarmClient.mjs` reusing protocol logic.
- [x] Implement connection pool with health tracking and peer selection.
- [x] Build public gateway service entrypoint (`public-gateway/server.mjs`) with Express, `ws`, TLS support.
- [x] Implement registration API in worker (`hypertuna-worker`) to produce signed payloads and manage relay listings.
- [x] Add token issuing/validation helpers in `shared/auth/PublicGatewayTokens.mjs`.
- [x] Wire worker to call public gateway registration endpoint when user enables remote access.
- [x] Implement WebSocket session adapter bridging to `RelayProtocol` requests.
- [x] Add metrics/logging middleware and expose `/metrics` endpoint.
- [x] Provide Dockerfile + configuration examples for deployment.
- [x] Document operational runbook in this folder.

## Open Questions
- Where to persist registration metadata for multi-node deployments (initial pass can use in-memory store with optional Redis adapter).
- Desired token lifetime and renewal UX.

This roadmap will be updated as implementation proceeds.

## Running the Gateway

### Local Development

```bash
cd public-gateway
npm install
npm run dev # loads configuration from .env.local if present
```

By default the service listens on `4430` and expects signed registration payloads from the desktop worker. Use `GATEWAY_REGISTRATION_SECRET` to set the shared HMAC secret.

### Docker

The repository ships with a Dockerfile rooted at `public-gateway/Dockerfile`.

```bash
# build from the repository root
docker build -f public-gateway/Dockerfile -t hypertuna/public-gateway .

# run with TLS disabled and local Redis cache
docker run -p 4430:4430 \
  -e GATEWAY_PUBLIC_URL=https://hypertuna.com \
  -e GATEWAY_REGISTRATION_SECRET=change-me \
  -e GATEWAY_REGISTRATION_REDIS=redis://redis:6379 \
  hypertuna/public-gateway
```

For Compose deployments ensure the `shared/` directory remains mounted so the service can import the shared protocol modules.

### Configuration Reference

| Environment Variable | Description |
| -------------------- | ----------- |
| `GATEWAY_PUBLIC_URL` | External HTTPS base used when generating share links. |
| `GATEWAY_REGISTRATION_SECRET` | Shared HMAC secret the worker uses to sign registration payloads and tokens. |
| `GATEWAY_REGISTRATION_REDIS` | Optional Redis connection string for distributed registration state. Falls back to in-memory cache when omitted or unavailable. |
| `GATEWAY_REGISTRATION_REDIS_PREFIX` | Namespace prefix for Redis keys. Defaults to `gateway:registrations:`. |
| `GATEWAY_REGISTRATION_TTL` | Registration TTL in seconds. Defaults to `300`. |
| `GATEWAY_DEFAULT_TOKEN_TTL` | Default token lifetime in seconds for link generation. Defaults to `3600`. |

### Testing

```bash
cd public-gateway
npm test
```

This runs lightweight unit tests for token helpers and the in-memory registration store using Node's built-in test runner.
