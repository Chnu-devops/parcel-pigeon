# Observability: Prometheus, Grafana, Loki — step by step

> Builds on `docs/rollouts-migration.md` (Argo Rollouts, `clusters/platform/`).
> Lecture: `slides/tema8- observability.md`.

Every service has served `/metrics` since Phase 1, but nothing has been
reading it. The rollouts lecture assumed a Prometheus that didn't exist yet.
This guide adds a real monitoring stack and connects it to the app:

- **Metrics + alerts**: kube-prometheus-stack (release `kps`), installed by
  Argo CD from `clusters/platform/`. Each app chart ships its own
  `ServiceMonitor` and `PrometheusRule`.
- **Dashboards as code**: one shared "ParcelPigeon RED" dashboard, a
  `ConfigMap` that Grafana's sidecar loads.
- **Logs**: Loki for storage, plus Grafana Alloy to collect them. All three
  services log one JSON line per request, with the gateway's `x-request-id`
  carried through every hop.
- **The rollouts loop is closed**: the gateway canary now checks its 5xx share
  in Prometheus after `/readyz`. A fault switch (`ERROR_RATE`) lets you ship a
  bad release on purpose.
- **Load**: `./scripts/dev.sh load` (k6), so there is traffic to look at.

Tracing (OpenTelemetry + Tempo) is not part of this branch; see "Later".

Answer key: the `add-observability` branch in both repos.

## The target layout

```
parcel-pigeon-gitops/
├── clusters/platform/
│   ├── apps/
│   │   ├── argo-rollouts.yaml
│   │   ├── kube-prometheus-stack.yaml   # NEW  Prometheus, Alertmanager, Grafana, exporters
│   │   ├── loki.yaml                    # NEW  log storage (SingleBinary, filesystem)
│   │   ├── alloy.yaml                   # NEW  log collector → Loki
│   │   └── parcelpigeon-observability.yaml  # NEW  syncs ../observability/
│   └── observability/
│       └── dashboard-red.yaml           # NEW  Grafana dashboard ConfigMap
└── apps/{gateway,shipments-service,tracking-service}/base/templates/
    ├── service.yaml                     # port now named `http`
    ├── servicemonitor.yaml              # NEW
    ├── prometheusrule.yaml              # NEW
    └── analysistemplate.yaml            # gateway only: + gateway-success-rate

devops-2026-new/
├── services/shipments-service/app/logs.py   # NEW  JSON log formatter
├── services/*/…                             # access-log line per request, request id
├── services/gateway/src/app.ts              # ERROR_RATE fault switch, x-request-id upstream
└── scripts/load.js                          # NEW  k6 scenario (./scripts/dev.sh load)
```

## Prerequisites

- The cluster from `docs/rollouts-migration.md`, restarted with more memory:
  `minikube start --memory 8g --cpus 4`. kube-prometheus-stack plus Loki
  needs about 2 GB on top of the apps.
- Ingress reachable as `dev.parcelpigeon.local` (see
  `docs/environments-migration.md`).
- k6 (`brew install k6`) or Docker. `dev.sh load` falls back to the
  `grafana/k6` image.

## Step 1 — The stack, through Argo CD

Three upstream charts, each one an `Application` in `clusters/platform/apps/`,
the same shape as `argo-rollouts.yaml`: pinned chart version, values inline.

| Application | Chart | What it brings |
|---|---|---|
| `kube-prometheus-stack` | `prometheus-community/kube-prometheus-stack` 92.7.0 | Prometheus Operator, Prometheus, Alertmanager, Grafana, node-exporter, kube-state-metrics, cluster dashboards + rules |
| `loki` | `grafana-community/loki` 18.16.0 | Loki in one process, chunks on a PVC |
| `alloy` | `grafana/alloy` 1.13.1 | pod discovery → labels → logs → Loki |

Values worth pointing at in class:

- `serviceMonitorSelectorNilUsesHelmValues: false` (and the same for rules). By
  default Prometheus only picks up ServiceMonitors labelled `release: kps`.
  That is the "I created a ServiceMonitor and nothing shows up" pitfall from
  the slides. Our app charts don't carry that label, so we tell Prometheus to
  take all of them.
- `kubeEtcd / kubeControllerManager / kubeScheduler / kubeProxy: false`. On
  minikube these listen on localhost only, so their `…Down` alerts would fire
  forever. That makes a good alert-fatigue story: a noisy alert nobody acts on
  is worse than no alert.
- `grafana.additionalDataSources`: Loki at `http://loki-gateway.monitoring`.
- The Loki chart moved to `grafana-community` in 2026. `grafana/loki` is now
  the Enterprise Logs chart.
- Alloy runs as a `Deployment`, not a `DaemonSet`. `loki.source.kubernetes`
  reads logs through the API (like `kubectl logs`), so one replica sees every
  pod. Tailing `/var/log/pods` would need one per node.

## Step 2 — Scrape the services

Each of gateway, shipments-service and tracking-service gets a
`ServiceMonitor`:

```yaml
spec:
  selector:
    matchLabels:
      app: gateway
  endpoints:
    - port: http        # the Service port *name*
      path: /metrics
      interval: 15s
```

- The Service ports had no name, which is the second pitfall from the slides.
  They are now called `http`.
- `gateway-canary` selects the same pods as `gateway`, so its port stays
  unnamed on purpose. Otherwise every canary pod would be scraped twice.
- The gateway ServiceMonitor also sets
  `podTargetLabels: [rollouts-pod-template-hash]`. Every gateway series then
  carries `rollouts_pod_template_hash`, which is how a query tells canary pods
  from stable ones.
- Everything sits behind `monitoring.enabled` (default `true`) in the chart
  values, so the charts still render on a cluster without the CRDs.

Check it: Prometheus → Status → Targets → `serviceMonitor/parcelpigeon-dev/…`
should show 3 targets UP (4 in prod, which has 2 gateways).

## Step 3 — Alerts

`prometheusrule.yaml` per service. There are two rules each, both on
symptoms, not causes:

| Alert | Expression (simplified) | for |
|---|---|---|
| `<Svc>HighErrorRate` | 5xx share over 2m > 5% | 2m |
| `<Svc>Down` | `absent(up{service="<svc>"} == 1)` | 1m |

`absent(… == 1)` instead of `up == 0`: when the Deployment is scaled to 0
there is no target left and `up` disappears entirely. Plain `up == 0` would
stay silent. Rules are scoped with `namespace="{{ .Release.Namespace }}"`,
so dev and prod alert separately.

Alertmanager keeps the chart's `null` receiver. Firing alerts are visible at
`:9093` and in Grafana → Alerting. A Telegram or Slack receiver is an
exercise.

## Step 4 — The dashboard

`clusters/platform/observability/dashboard-red.yaml` is a `ConfigMap` with
`grafana_dashboard: "1"`. The Grafana sidecar loads it from any namespace.

- Variables: `namespace`, `service` (multi), and a free-text `search` for
  the logs panel.
- Row 1 answers "is everything OK?" in 5 seconds: req/s, 5xx share, p95. It
  excludes `/metrics` and the probes, which are not user traffic.
- Then: per-service/status traffic, error share, p95 per route, "Gateway:
  stable vs canary" (exactly what the analysis looks at), business counters,
  container CPU.
- At the bottom, a Loki logs panel for the same namespace and service.
- Annotation: a purple line whenever a new ReplicaSet appears, i.e. a
  release.

Edit in the UI if you like, then **Export → JSON** and paste it back into the
ConfigMap. Otherwise the change disappears with the Grafana pod.

## Step 5 — Logs that are worth collecting

| Service | Before | After |
|---|---|---|
| gateway | pino JSON, `reqId` per request | + sends `x-request-id` upstream, also when it generated the id |
| shipments-service | plain-text `logging.basicConfig`, uvicorn text access log | JSON (`app/logs.py`); `shipments.access` line with method, path, route, status, duration_ms, request_id; uvicorn access log off |
| tracking-service | slog JSON, no per-request line | `metrics.Middleware` logs the same fields through `slog.Default()` |

5xx answers are logged at `error` level. The gateway's injected faults log
`"injected fault"`.

## Step 6 — The canary asks Prometheus

`apps/gateway/base/templates/analysistemplate.yaml` gains
`gateway-success-rate`:

```promql
(
  (sum(rate(http_requests_total{namespace="parcelpigeon-dev", service="gateway",
      rollouts_pod_template_hash="<canary>", route=~"/api/.*", status!~"5.."}[1m])) or vector(0))
  /
  sum(rate(http_requests_total{…same, all statuses…}[1m]))
) or vector(1)
```

It runs every 30s, four times, with `failureLimit: 0` and the condition
`result[0] >= 0.95`. The Rollout step passes the canary's hash with
`valueFrom.podTemplateHashValue: Latest`.

- Only `/api/*` counts. Probes and scrapes always succeed and would dilute
  the errors.
- `or vector(0)` on the numerator means 100% errors gives 0, not "no data".
- `or vector(1)` on the whole means no traffic passes. Nothing to judge is not
  a failure, so **run load during a release**, or this check proves nothing.

Steps are now dev: `setWeight 50` → readyz → success-rate → 100%. Prod: `setWeight 50` → pause → readyz →
success-rate → 100%.

## Step 7 — Cut over

```bash
minikube stop && minikube start --memory 8g --cpus 4
# config repo: merge add-observability into main. Then the platform root
# syncs kps / loki / alloy / the dashboard; the apps pick up their
# ServiceMonitors once the CRDs exist (Argo CD retries on its own).
kubectl -n argocd get applications
kubectl -n monitoring get pods
# app repo: merge add-observability; CI bumps the image tags in dev.
```

## Step 8 — The demo

```bash
kubectl -n monitoring port-forward svc/kps-grafana 3000:80 &
kubectl -n monitoring get secret kps-grafana -o jsonpath="{.data.admin-password}" | base64 -d; echo
kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 9090 &
kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-alertmanager 9093 &

./scripts/dev.sh load                       # 5 VUs × 5 min against dev.parcelpigeon.local
DURATION=20m ./scripts/dev.sh load          # long run for the whole demo
```

1. **Healthy**: Grafana → Dashboards → ParcelPigeon RED, namespace
   `parcelpigeon-dev`. Traffic, 0% errors, p95 in milliseconds.
2. **Bad release**: in the config repo, set this in `apps/gateway/overlays/dev/values.yaml`:
   ```yaml
   config:
     LOG_LEVEL: debug
     ERROR_RATE: "0.3"
   ```
   and push. The ConfigMap checksum changes, which starts a new canary.
   ```bash
   kubectl argo rollouts get rollout gateway -n parcelpigeon-dev --watch
   kubectl -n parcelpigeon-dev get analysisrun
   ```
   readyz passes (the pod is fine), success-rate measures about 0.7 and fails,
   and the Rollout aborts back to stable.
3. **Metrics**: the "stable vs canary" panel shows one hash at about 30% 5xx
   while it ran, and the purple annotation marks the release.
4. **Alert**: the canary aborts at the first failed measurement, within about
   a minute. That is too quick for `GatewayHighErrorRate` (`for: 2m`). To
   see the alert fire, keep the bad version up: also set
   `rollout.steps: [{setWeight: 100}]` in the dev overlay. Then
   `GatewayHighErrorRate` goes pending → firing at `:9093`. This is the
   difference between "the release stopped itself" and "a person got paged".
5. **Logs → why**: Grafana → Explore → Loki:
   ```logql
   {namespace="parcelpigeon-dev", app="gateway"} |= "injected fault"
   ```
   Copy a `reqId` and follow it through the other services:
   ```logql
   {namespace="parcelpigeon-dev"} |= "<reqId>"
   ```
6. **Clean up**: `git revert` the overlay change. k6 exits non-zero (99)
   when its `http_req_failed < 5%` threshold was crossed.

## Cheat sheet

```promql
up{namespace="parcelpigeon-dev"}
sum by (service, status) (rate(http_requests_total{namespace="parcelpigeon-dev"}[5m]))
sum(rate(http_requests_total{service="gateway", status=~"5.."}[5m])) / sum(rate(http_requests_total{service="gateway"}[5m]))
histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket{namespace="parcelpigeon-dev"}[5m])))
rate(shipments_created_total[5m]) * 60
sum by (pod) (container_memory_working_set_bytes{namespace="parcelpigeon-dev", container!=""})
```

```logql
{namespace="parcelpigeon-dev", app="shipments-service"} | json | status >= 500
{namespace="parcelpigeon-dev", app="tracking-service"} | json | duration_ms > 100
{namespace="parcelpigeon-dev", app="gateway"} | json | res_statusCode >= 500
sum by (app) (count_over_time({namespace="parcelpigeon-dev"} |= "error" [1m]))
```

Label names: gateway uses `route`, shipments and tracking use `path`. In the
logs, pino nests fields (`res.statusCode` becomes `res_statusCode` after
`| json`), while shipments and tracking log flat fields.

## Exercises (slides → ParcelPigeon)

1. Build a panel with the 5xx share and p95 of one service. Compare it with
   the shipped dashboard.
2. Add a `namespace` variable to your panel and switch between dev and prod.
3. Turn off self-heal first, or Argo CD scales it straight back:
   `argocd app set tracking-service-dev --sync-policy none`. Then run
   `kubectl -n parcelpigeon-dev scale deploy tracking-service --replicas 0`
   and watch `TrackingServiceDown` go pending, then firing. Why
   `absent(... == 1)` and not `up == 0`? Afterwards:
   `argocd app set tracking-service-dev --sync-policy automated --self-heal --auto-prune`.
4. In Loki, find every request that answered 500 (any service).
5. \* Ship a bad gateway with `ERROR_RATE` and watch `gateway-success-rate`
   abort it. Then do the same with no load running. Why does it pass?

## Pitfalls

- **Targets missing**: the port is unnamed or misnamed, or the selector label
  is wrong. With chart defaults, the `release` label is also needed (we turned
  that off).
- **Apps `OutOfSync` / "no matches for kind ServiceMonitor"**: the CRDs come
  from kps, so apply the platform root first. Argo CD retries.
- **Grafana shows no data for `rollouts_pod_template_hash`**: only pods started
  by a Rollout have it, and only the gateway ServiceMonitor copies it.
- **OOM on minikube**: 8 GB. Retention is 2 days and the Loki canary is off
  to save memory.
- **Duplicated logs**: don't run Alloy as a DaemonSet with
  `loki.source.kubernetes`. Every replica would read every pod.

## Later (not in this branch)

- Tracing: OpenTelemetry SDKs → OTel Collector (or Alloy) → Tempo, with
  `trace_id` in the logs and exemplars on the latency histogram.
- An Alertmanager receiver (Telegram) and a Watchdog → dead-man's-switch.
- SLOs and error budgets as recording rules.
