# Observability Assets

This folder contains the Grafana dashboards and Prometheus alert rules referenced in Phase 5 Group 4.

## Contents
- `grafana-dashboard-public-gateway.json` – gateway-centric dashboard covering blind-peer health, fallback usage, pending writes, and lease metrics.
- `grafana-dashboard-escrow-worker.json` – escrow + worker telemetry dashboard (unlock trends, policy rejections, worker lease lag).
- `prometheus-alerts.yaml` – example `PrometheusRule` definition for Kubernetes/Helm deployments that fires when:
  - the gateway serves fallback writes without an active lease,
  - a lease is <60s from expiry,
  - policy rejections exceed a configurable threshold.

## Importing Dashboards
1. Open Grafana → **Dashboards → Import**.
2. Upload the JSON file and assign your Prometheus data source.
3. Save under your preferred folder.

## Installing Alert Rules
1. Copy `prometheus-alerts.yaml` into your Prometheus rule directory (or Helm chart values).
2. Adjust the `prometheus` namespace/group names to match your environment.
3. Reload Prometheus or let your operator reconcile the new rule group.

All dashboards expect the metrics exported by the Hypertuna public gateway, worker, and escrow services after BP-P5-10.
