# Gateway Pending Writes Runbook

This runbook explains how to inspect, force, and clear gateway pending writes while keeping Autobase escrow policy in a healthy state. For deeper coverage of escrow policy, TLS renewal, and database maintenance, refer to [docs/escrow-operations.md](./escrow-operations.md).

### Lifecycle at a glance
```
Worker online? ── yes ──> requests served directly
        │
        no
        │
Gateway writes to blind peer drive + Autobase
        │
        ├─> `/gateway/pending-writes` push (state + lease metadata)
        │
PendingWriteCoordinator enqueues jobs → mirrors gateway drive → resyncs Autobase
        │
Worker rotates escrow deposit (new lease) → clears gateway metadata
```
Keep an eye on `gateway_escrow_lease_time_to_expiry_seconds` and the desktop “Gateway Pending Writes” card to understand which phase the system is currently in.

## 1. Confirm Current Pending State
1. From the worker desktop UI (or IPC stream), listen for `gateway-pending-writes` events. Each event includes the relay key, reason, types (`autobase`, `drive`), drive identifier/version, lease metadata, and `leaseVersion`.
2. Query the gateway Prometheus / Grafana panels:
   ```text
   gateway_pending_writes{relay="<relayKey>"}
   gateway_pending_write_push_total{relay="<relayKey>"}
   gateway_pending_write_push_wait_seconds{relay="<relayKey>"}
   gateway_escrow_lease_time_to_expiry_seconds{relay="<relayKey>"}
   gateway_escrow_lease_lag_seconds_bucket{relay="<relayKey>"}
   gateway_replica_fallback_total{relay="<relayKey>"}
   ```
3. Call `GET /api/blind-peer/replicas` on the gateway to verify the blind-peer mirrors are healthy. Look for `lagMs` and `healthy` flags for the affected relay.

## 2. Force Pending Writes (Gateway)
1. Temporarily disable the worker for a relay (e.g., `stop-gateway` IPC message or bring down the worker) and perform a drive upload through the gateway HTTP surface (`PUT /drive/:identifier/:file`).
2. Check `public-gateway/src/PublicGatewayService` logs for “Stored drive upload” and “marking pending writes”.
3. Verify `gateway_pending_writes{relay="<relayKey>"} == 1`.

## 3. Monitor Worker Resync Progress
1. Use the desktop `gateway-pending-writes` event stream (emitted by `PendingWriteCoordinator`) to monitor queue/in-flight jobs. Each record shows the latest notification, queue size, and timestamps.
2. Inspect `pending-writes-state.json` (in the worker storage directory) for the durable queue snapshot.
3. Tail worker logs for `[PendingWrites] Job failed` or `[PendingWrites] Job complete` messages.

## 4. Clear Stuck Jobs
1. If a job stalls, restart the worker gateway service (`stop-gateway` → `start-gateway`). The coordinator will reload `pending-writes-state.json` and resume processing.
2. If the queue remains stuck, delete `pending-writes-state.json`, restart the gateway, and force the gateway to reissue `/gateway/pending-writes` by toggling `gatewayPendingWrites` via `relay_metadata` or by re-registering the relay (`/api/relays`).
3. As a last resort, manually call `POST /api/relays/:relayKey/resync-complete` with the shared secret signature to clear gateway metadata (only after double-checking that mirrors contain the latest state).

## 5. Manually Trigger Writer Rotation
1. After confirming the worker has ingested gateway writes, call the worker IPC action `rotate-gateway-writer` (or run `gatewayService.rotateGatewayWriter(relayKey)` in a REPL). This forces a new escrow deposit and registration refresh.
2. Watch worker logs for `[PublicGateway] Gateway writer rotation failed` or `Escrow deposit request failed`. Resolve any errors (usually escrow service unreachable or shared-secret mismatch).
3. Confirm the new escrow package by checking the gateway registration via `/api/relays` or inspecting the HTTP response from the worker rotation call.

## 6. Validate Everything is Clear
1. `gateway_pending_writes{relay="<relayKey>"} == 0`.
2. `pendingWriteCoordinator` snapshot shows `status: "completed"` and empty queue.
3. Gateway logs show `notifyCleared` push and `AutobaseKeyEscrowCoordinator` lease release. `gateway_escrow_lease_time_to_expiry_seconds{relay="<relayKey>"}` should reset to the new TTL.
4. Optional: re-run the offline flow to ensure metrics react as expected and verify the dashboards/alerts in `deploy/observability/`.

## References
- `public-gateway/src/PublicGatewayService.mjs`
- `hypertuna-worker/gateway/GatewayService.mjs`
- `hypertuna-worker/index.js` (`PendingWriteCoordinator`, queue processor)
- Prometheus metrics: `gateway_pending_writes`, `gateway_pending_write_push_total`, `gateway_pending_write_push_wait_seconds`, `gateway_escrow_lease_time_to_expiry_seconds`, `gateway_escrow_lease_lag_seconds`
- [docs/escrow-operations.md](./escrow-operations.md) for escrow rotation, TLS, and Postgres procedures
