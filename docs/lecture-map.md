# Lecture map — where to demo each DevOps topic

Phase 1 (this repo today) gives you a running polyglot system. Each topic below
either has a hook already, or a clear place to add one in a later phase. Build
the later phases live during the lectures — that is the point of the sandbox.

## Available now (Phase 1)

> On the `local-no-docker` branch the two rows below are the **live-coding
> exercise**: only the datastores are containerised (`docker-compose.yml`), the
> services run natively (`docs/running-locally.md`), and you write the four
> Dockerfiles + the full compose in front of the class. `git diff main` is the
> reference / answer key.

| Topic | Where / how |
|-------|-------------|
| **Containerisation** | One `Dockerfile` per service. Three patterns to contrast: Python multi-stage with `--prefix` install (`services/shipments-service`), Go multi-stage → `distroless/static:nonroot` (`services/tracking-service`), Node build stage → prod-deps-only runtime (`services/gateway`), static build → Nginx (`web`). |
| **Docker Compose** | `docker-compose.yml` — service DNS, `depends_on` health conditions, named volumes, healthchecks, env wiring. |
| **12-factor config** | Every service is env-only; `docker-compose.yml` is the single wiring point. |
| **Testing** | `./scripts/dev.sh test`. Pure-function unit tests (`shipment_status.py`, `projection.go`), API tests (`TestClient`, `httptest`+`miniredis`), proxy tests with a stub upstream (gateway), RTL component tests (web). |
| **Test doubles / fakes** | `miniredis`, monkeypatched broker publisher, Fastify stub upstream, stubbed `fetch`. |
| **Static analysis / linting** | `./scripts/dev.sh lint` — `ruff`, `go vet` + `gofmt`, `eslint` + `prettier`. Config: `pyproject.toml`, `.golangci.yml`, `.eslintrc.cjs`. |
| **Health & readiness** | `/healthz` vs `/readyz` on every service; `/readyz` actually probes dependencies and returns 503. |
| **Metrics instrumentation** | `/metrics` on every service: RED metrics + business counters (`shipments_created_total`, `shipment_status_changed_total`, `tracking_cache_hits_total`, `tracking_notifications_sent_total`). |
| **Messaging / async** | RabbitMQ topic exchange, durable queue, manual ack/nack, poison-message handling, idempotent consumer. Inspect live in the management UI (`:15672`). |
| **CQRS / event-driven** | Write model (Postgres) vs event-fed read model (Redis); rebuildable projection. |
| **DB migrations** | Alembic (`services/shipments-service/alembic`), run on container start via `docker-entrypoint.sh`. |
| **End-to-end smoke testing** | `scripts/smoke.sh` — black-box, drives the real stack through the gateway. |

## Add during later phases

| Topic | Plan |
|-------|------|
| **CI (GitHub Actions)** | `.github/workflows/`: per-service matrix (lint → test → build), image push to GHCR, then image scan gate. Nothing in the repo assumes a CI system yet. |
| **Supply-chain / security scanning** | `hadolint` on Dockerfiles, `gitleaks`, `trivy fs` + `trivy image`, `syft` SBOM, optional `semgrep`. Wire into CI and as a `dev.sh scan` target. |
| **Metrics platform** | Add `prometheus` + `grafana` + `alertmanager` compose services (or a `docker-compose.observability.yml`). Scrape configs point at the existing `/metrics`. Dashboards + alert rules as code. |
| **Distributed tracing** | OpenTelemetry SDK in each service → OTel Collector → Jaeger/Tempo. The `x-request-id` the gateway already sets becomes the correlation seed. |
| **Centralised logs** | Structured JSON logs are already emitted (pino, slog, uvicorn). Add Loki + Promtail / Alloy. |
| **Kubernetes** | `deploy/k8s/`: Deployment/Service/Ingress/HPA/PDB, liveness=`/healthz`, readiness=`/readyz`, `ServiceMonitor` for the metrics. Local cluster on minikube. |
| **Helm** | `helm/parcelpigeon` single chart (done on `add-helm`, see `docs/helm-migration.md`). Later: `values-dev.yaml` / `values-prod.yaml`. |
| **GitOps (Argo CD)** | Argo CD `Application` (app-of-apps) reconciling the Helm chart from Git; CI bumps the image tag in the values file. Argo UI for the demo. |
| **Progressive delivery** | Argo Rollouts canary on `gateway`, driven by the Prometheus success-rate metric. |
| **IDP / Backstage** | `catalog-info.yaml` per service, System/Domain descriptors, TechDocs (mkdocs from `docs/`), a Scaffolder "new service" template — demoed by adding a 4th backend, a **Rust (axum) ETA service** backed by Redis, as the golden path. |
| **Secrets management** | Replace `.env` with Sealed Secrets / External Secrets + a vault; show the `GATEWAY_API_KEY` flowing through. |

## Suggested lecture ordering

1. Run `./scripts/dev.sh up`, walk the architecture, hit every URL.
2. Containers & Compose — read the four Dockerfiles side by side.
3. Tests & static analysis — `dev.sh test`, `dev.sh lint`, look at the pure cores.
4. Messaging — watch events in the RabbitMQ UI while adding scans.
5. Metrics — curl `/metrics`, then stand up Prometheus + Grafana.
6. CI — turn steps 3–4 into a GitHub Actions pipeline.
7. Kubernetes — raw manifests, then Helm.
8. GitOps — Argo CD reconciling the chart.
9. IDP — Backstage catalog + a scaffolded Rust service.
