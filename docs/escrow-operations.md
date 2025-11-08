# Escrow Operations Guide

This document captures the day‑to‑day operational procedures for the Hypertuna public gateway escrow subsystem. It complements the pending write runbook by focusing on the Autobase escrow service, lease governance, certificate renewal, and database maintenance.

---

## 1. Topology Overview

| Component | Purpose | Notes |
| --- | --- | --- |
| AutibaseKeyEscrowService (`public-gateway/src/escrow`) | Stores encrypted writer packages, validates unlock policy, issues leases | Runs alongside Postgres + pgcrypto |
| AutobaseKeyEscrowCoordinator (gateway) | Requests leases, tracks active lease vault, propagates metadata to replicas | Emits Prometheus metrics + pending write payloads |
| LeaseVault (gateway + escrow) | In‑memory storage for decrypted writer packages | Zeroizes buffers on signal/TTL |
| GatewayPendingWritePushService | Notifies workers when gateway performs offline writes | Payload now includes `leaseVersion`, `leaseActive`, and expiry hints |
| Observability stack | Grafana dashboards + Prometheus alerts defined in `deploy/observability/` | Tracks blind peer lag, fallback usage, escrow health |

---

## 2. Lease Lifecycle

```
Worker deposit ──> Escrow Service (pg storage + audit log)
    │                     │
    │ unlock request      │ policy evaluation
    │                     ▼
    └──────< AutobaseKeyEscrowCoordinator (gateway) >───────┐
                      │                                    │
                      │ lease issued (writer key)          │
                      ▼                                    │
           Gateway LeaseVault (secure buffer)              │
                      │                                    │
        ┌─────────────┴──────────────┐                     │
        │ gateway fallback reads     │                     │
        │ & writes (with lease)      │                     │
        └──────┬──────────────┬──────┘                     │
               │              │                            │
       pending-write push   lease metadata                 │
               │              │                            │
               ▼              ▼                            │
     Workers resync from blind peer, rotate deposit <──────┘
```

Lease states are mirrored via `/api/blind-peer/replicas`, Prometheus (`gateway_escrow_lease_lag_seconds`, `gateway_escrow_lease_time_to_expiry_seconds`), and the desktop UI pending write panel.

---

## 3. Rotation & Resync Workflows

### Automatic rotations
1. Worker reconnects or finishes processing a pending write job.
2. Worker revokes the prior escrow deposit via `/revoke`, submits a fresh deposit, and re-registers the relay.
3. Gateway LeaseVault releases the lease (`lease-released` audit entry recorded) and clears fallback state.

### Manual rotation (operator)
```bash
# From worker shell
node hypertuna-worker/index.js rotate-gateway-writer --relay <relayKey>
```
Use when the gateway shows `leaseActive=false` for an extended period but workers are healthy.

### Replica / resync flow
1. Gateway writes to its blind-peer replica/hyperdrive while workers are offline.
2. `/gateway/pending-writes` pushes include `leaseVersion`, `leaseActive`, and expiry times.
3. Worker’s PendingWriteCoordinator mirrors the gateway drive, applies Autobase updates, and rotates the writer key.

---

## 4. TLS & Certificate Renewal

1. Escrow service consumes `ESCROW_TLS_*` env vars. Certificates live outside the repo and are hot‑reloaded by the TLS watcher.
2. For renewal, replace the cert/key files and (optionally) reload the process:
   ```bash
   sudo systemctl reload hypertuna-escrow.service
   ```
   or rely on the file watcher to refresh contexts automatically.
3. Gateway/worker clients mount the updated CA + client certificates (see `ESCROW_TLS_CA`, `ESCROW_TLS_CLIENT_CERT`, `ESCROW_TLS_CLIENT_KEY`).
4. Verify with:
   ```bash
   curl --cacert <ca.pem> --cert <client.pem> --key <client.key> https://escrow.example.com/api/escrow/health
   ```

---

## 5. Postgres Maintenance

* Database lives inside the public gateway container (`ESCROW_DATABASE_URL`).
* Migrations: `npm run escrow:migrate`.
* Backups: `pg_dump $ESCROW_DATABASE_URL > backup.sql`.
* Common tasks:
  - **Vacuum / Analyze:** `psql -c "VACUUM (ANALYZE) escrow_deposits;"`.
  - **Rotate logs:** rely on container log rotation or copy to `logs/escrow/`.
  - **Restore:** `psql $ESCROW_DATABASE_URL < backup.sql` (ensure service is stopped).

---

## 6. Troubleshooting Drills

| Symptom | Steps | Metrics/Logs |
| --- | --- | --- |
| Gateway writes blocked (`gateway-escrow-lease-missing`) | Check `/api/escrow/leases/query` output, ensure `gateway_escrow_leases_active{relay=...}` is 1, rerun worker rotation | `gateway_escrow_lease_time_to_expiry_seconds`, `gateway-pending-writes` desktop card |
| Escrow unlock failures (policy) | Inspect `escrow_policy_rejections_total{reason}`, grep escrow logs for `unlock-rejected` entries | Alerts fire when rate > 0.05/sec |
| Replica lag grows | View Grafana “Blind Peer Mirror Lag”, confirm handshake metadata, run `POST /api/blind-peer/gc` | `gateway_blind_peer_mirror_lag_ms` |
| TLS errors | Validate certificates, ensure client CA bundle matches, check `AutobaseKeyEscrowClient` logs | Escrow service logs will show `Authorization check failed` or TLS stack traces |
| Postgres unavailable | `docker compose logs postgres`, run `psql -c 'SELECT 1'`, fall back to JSON store by clearing `ESCROW_DATABASE_URL` (dev only) | `escrow_service_db_connection_error` (if configured) |

---

## 7. Observability References

* Dashboards: import JSON files from `deploy/observability/`.
* Alerts: apply `deploy/observability/prometheus-alerts.yaml`.
* Key metrics:
  - `gateway_replica_fallback_total{mode}`
  - `gateway_escrow_lease_lag_seconds` + `gateway_escrow_lease_time_to_expiry_seconds`
  - `escrow_unlock_total{result}`, `escrow_policy_rejections_total{reason}`
  - `gateway_pending_write_push_wait_seconds`

---

## 8. Appendices

### A. Emergency Lease Flush
```bash
# Gateway (REPL or script)
curl -X POST -H 'x-signature: ...' https://gateway/api/relays/<relayKey>/escrow/revoke
```

### B. Lifecycle Diagram Legend
* **Blind peer replica** – always-on storage of Autobase cores + hyperdrives.
* **Escrow lease** – encrypted writer secret, time-limited, required for gateway writes.
* **Pending write** – offline artifact requiring worker resync; tracked in desktop UI.

Refer back to this guide whenever performing rotations, TLS renewals, or database work related to Autobase escrow.
