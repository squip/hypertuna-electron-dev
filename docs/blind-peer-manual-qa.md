# Blind Peer Manual QA Checklist

This checklist validates the blind-peering integration end-to-end, including dispatcher assignments, mirror rehydration, and operator tooling.

## Preconditions
- Gateway and worker running on the same test network.
- `GATEWAY_BLINDPEER_ENABLED=true` with a writable storage directory.
- Worker configured with `blindPeerEnabled=true` and manual mirror overrides (if required).

## Checklist
1. **Baseline handshake**
   - Start the gateway and worker.
   - Verify the worker log shows `[BlindPeering] Manager started` and the CLI command `npm run blind-peer:status` returns an enabled summary.
2. **Dispatcher-driven assignment**
   - Issue a delegated subscription via the public gateway (e.g. using `nostcat` or the internal test client).
   - Confirm the gateway logs `DelegationDebug: forward-to-peer` with `dispatcherEnabled=true`.
   - Run `npm run blind-peer:status -- --detail` and verify the `dispatcherAssignments` array contains the worker’s peer key.
3. **Automatic mirror refresh**
   - On the worker, confirm log entries `[BlindPeering] Refresh requested` with reason `dispatcher-assignment` followed by `Rehydration cycle completed`.
   - Inspect `blind-peering-metadata.json` for the assigned relay identifier.
4. **Admin tooling**
   - Trigger a GC cycle using `npm run blind-peer:status -- --gc --reason "qa"` and confirm a `status.result` payload is returned.
   - Delete a mirror using `npm run blind-peer:status -- --delete-core <coreId>` and verify the gateway logs the deletion.
5. **Fallback resiliency**
   - Restart the worker and observe that it fetches `/api/blind-peer` fallback metadata (log entry `[PublicGateway] Blind peer metadata refreshed via REST fallback`).
   - Ensure dispatcher assignments rehydrate automatically after restart.
6. **Regression capture**
   - Record snapshots of `/metrics`, `/api/blind-peer?detail=true`, and worker `get-blind-peering-status` output for attachment to the release ticket.

Complete all steps before promoting a build that modifies blind-peer or dispatcher logic.
