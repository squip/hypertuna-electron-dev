# Hypertuna Public Web Client

Browser build of the Hypertuna client served from the public gateway. Scope is reduced (no create/join/uploads/worker actions) but supports login, settings, relay token handling, group read, and replication-aware messaging.

## Build & Run
- Install deps: `npm install`
- Dev server: `npm run dev`
- Production build: `npm run build`
- Preview build: `npm run preview`

## Config / Env
- Served under `/public` by the gateway; output path `public-web/dist`.
- Gateway base URL + shared secret pulled from `PublicGatewaySettings` (persisted in `localStorage` for the web client).
- CSP defaults are set in the gateway; adjust via `publicWeb.cspDirectives` in `public-gateway/src/config.mjs` if needed for extra origins.

## Features (current)
- Nostr key load (nsec/hex) and gateway settings.
- Relay token issue/refresh (HMAC-signed) and tokenized relay URL generation.
- Connect to the gateway relay, list groups/messages (read-only metadata), send group messages.
- Replication-aware: fetches 30078 secrets via gateway, mirrors group messages and shared-secret envelopes to Hyperbee when enabled, and consumes mirrored secrets for offline fallback.

## Exclusions
- No relay create/join flows, file uploads, or worker IPC.

