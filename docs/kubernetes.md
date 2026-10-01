# Kubernetes manifests — building them by hand

> On the `add-helm` branch `k8s/` has been replaced by the Helm chart in
> `helm/parcelpigeon` — see `docs/helm-migration.md` for the migration.

This is the step-by-step for live-coding the `k8s/` folder from scratch instead
of copy-pasting it — the same live-coding pattern `docker-compose.yml` uses on
the `local-no-docker` branch (see `docs/lecture-map.md`). Each step uses
`kubectl create ... --dry-run=client -o yaml` to scaffold a resource, then a
short hand-edit to wire in what the app actually needs. `git diff main` on the
`add-k8s` branch is the reference / answer key.

## Prerequisites

```bash
kubectl version --client
minikube start
minikube addons enable ingress   # gives us an nginx ingress controller
```

## The shape of what we're building

One namespace, `parcelpigeon`, holding 8 components. Each app service gets a
Deployment + Service (+ ConfigMap for plain config, + Secret for connection
strings); each datastore gets a Deployment + Service (+ PVC if it's
stateful); one Ingress ties `web` to the outside world.

| Component | Deployment | Service | ConfigMap | Secret | PVC |
|---|---|---|---|---|---|
| postgres | ✅ | ✅ | – | ✅ | ✅ |
| redis | ✅ | ✅ | – | – | ✅ |
| rabbitmq | ✅ | ✅ | – | – | ✅ |
| mailhog | ✅ | ✅ | – | – | – |
| shipments-service | ✅ | ✅ | ✅ | ✅ | – |
| tracking-service | ✅ | ✅ | ✅ | ✅ | – |
| gateway | ✅ | ✅ | ✅ | ✅ | – |
| web | ✅ | ✅ | – | – | – |

## Step 1 — Namespace

```bash
mkdir -p k8s
kubectl create namespace parcelpigeon --dry-run=client -o yaml > k8s/namespace.yaml
```

Everything below is scaffolded the same way, then applied with `-n parcelpigeon`
(add `namespace: parcelpigeon` under `metadata:` by hand — `kubectl create
--dry-run=client` doesn't stamp it in).

## Step 2 — Walk through one datastore end to end: postgres

**Secret** — imperative generator, no hand-typed base64:

```bash
mkdir -p k8s/postgres
kubectl create secret generic postgres-secret -n parcelpigeon \
  --from-literal=POSTGRES_USER=parcelpigeon \
  --from-literal=POSTGRES_PASSWORD=parcelpigeon \
  --from-literal=POSTGRES_DB=shipments \
  --dry-run=client -o yaml > k8s/postgres/secret.yaml
```

**PVC** — `kubectl create` has no generator for this kind, write it by hand:

```yaml
# k8s/postgres/pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: parcelpigeon
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
```

**Deployment** — scaffold the container, then hand-edit:

```bash
kubectl create deployment postgres -n parcelpigeon \
  --image=postgres:16-alpine \
  --dry-run=client -o yaml > k8s/postgres/deployment.yaml
```

Edit `k8s/postgres/deployment.yaml` to add, under the container spec:
- `envFrom: [{secretRef: {name: postgres-secret}}]` — this is exactly what
  `docker-compose.yml`'s `environment:` block for `postgres` sets.
- `volumeMounts`/`volumes` mounting `postgres-data` at
  `/var/lib/postgresql/data` — the compose named volume `pgdata`.
- `readinessProbe`/`livenessProbe` running `pg_isready -U parcelpigeon` (exec
  probe) — same command as the compose `healthcheck:`.
- `resources.requests`/`limits` (e.g. `50m`/`128Mi` requests, `250m`/`512Mi`
  limits) — compose has no equivalent, this is k8s-only.

**Service**:

```bash
kubectl create service clusterip postgres -n parcelpigeon \
  --tcp=5432:5432 \
  --dry-run=client -o yaml > k8s/postgres/service.yaml
```

Fix the generated `selector` to `app: postgres` (matching the Deployment's pod
label) if the generator didn't infer it.

## Step 3 — Repeat for the other datastores

Same three-or-four-resource pattern, different flags:

| | image | ports | probe command | volume mount |
|---|---|---|---|---|
| **redis** | `redis:7-alpine` | 6379 | `redis-cli ping` | `/data` |
| **rabbitmq** | `rabbitmq:3.13-management-alpine` | 5672, 15672 | `rabbitmq-diagnostics -q ping` | `/var/lib/rabbitmq` |
| **mailhog** | `mailhog/mailhog:v1.0.1` | 1025, 8025 | none needed (stateless, no PVC) | none |

redis also needs a custom `command:` on the container
(`["redis-server", "--save", "60", "1", "--loglevel", "warning"]`) — same as
compose. Neither redis nor rabbitmq needs a Secret (redis is unauthenticated,
rabbitmq falls back to `guest`/`guest`); the consuming *app* services hold the
connection string instead (next step).

## Step 4 — App services: config/secret split

For each of `gateway`, `shipments-service`, `tracking-service`, split every
env var from its section of `docker-compose.yml` into two buckets: plain
config → ConfigMap, anything with a credential or connection string → Secret.

**ConfigMap**, e.g. for `gateway`:

```bash
mkdir -p k8s/gateway
kubectl create configmap gateway-config -n parcelpigeon \
  --from-literal=PORT=8000 \
  --from-literal=HOST=0.0.0.0 \
  --from-literal=SHIPMENTS_URL=http://shipments-service:8000 \
  --from-literal=TRACKING_URL=http://tracking-service:8002 \
  --from-literal=LOG_LEVEL=info \
  --dry-run=client -o yaml > k8s/gateway/configmap.yaml
```

**Secret**, e.g. for `gateway` (the compose file has one credential-shaped
var here, `GATEWAY_API_KEY`):

```bash
kubectl create secret generic gateway-secret -n parcelpigeon \
  --from-literal=GATEWAY_API_KEY="" \
  --dry-run=client -o yaml > k8s/gateway/secret.yaml
```

Do the same for `shipments-service` (`SHIPMENTS_RABBITMQ_EXCHANGE`,
`SHIPMENTS_PUBLISH_EVENTS`, `SHIPMENTS_ETA_HOURS`, `SHIPMENTS_LOG_LEVEL` →
ConfigMap; `SHIPMENTS_DATABASE_URL`, `SHIPMENTS_RABBITMQ_URL` → Secret) and
`tracking-service` (everything except `TRACKING_RABBITMQ_URL` → ConfigMap;
`TRACKING_RABBITMQ_URL` → Secret). Cross-check each var and its default
against the service's own config module — `services/gateway/src/config.ts`,
`services/shipments-service/app/config.py`,
`services/tracking-service/internal/config/config.go` — not just the compose
file, since the compose file only overrides a subset.

**Deployment** — scaffold, then wire both `envFrom` entries plus HTTP probes:

```bash
kubectl create deployment gateway -n parcelpigeon \
  --image=ghcr.io/rostyslavdiachuk/gateway:latest \
  --dry-run=client -o yaml > k8s/gateway/deployment.yaml
```

Edit in:
```yaml
envFrom:
  - configMapRef: {name: gateway-config}
  - secretRef: {name: gateway-secret}
readinessProbe:
  httpGet: {path: /readyz, port: 8000}
livenessProbe:
  httpGet: {path: /healthz, port: 8000}
```

Every one of the four app services already implements both `/healthz` and
`/readyz` (`/readyz` actually checks its dependencies) — use them as-is for
the two probes, no extra work needed on the app side.

**Service**: same `kubectl create service clusterip <name> --tcp=<port>:<port>`
pattern as the datastores. Repeat the Deployment+Service pair for
`shipments-service` (port 8000) and `tracking-service` (port 8002), and for
`web` (port 8080, no ConfigMap/Secret — it's a static Nginx build whose
`nginx.conf` already hardcodes `http://gateway:8000` for its `/api/*` proxy).

## Step 5 — Ingress

```bash
kubectl create ingress parcelpigeon -n parcelpigeon \
  --class=nginx \
  --rule="parcelpigeon.local/*=web:8080" \
  --dry-run=client -o yaml > k8s/ingress.yaml
```

Only `web` needs a rule — its Nginx config already reverse-proxies `/api/*`
to `gateway` internally, so duplicating that routing at the ingress layer
would be redundant.

## Step 6 — Apply and verify

```bash
kubectl apply -R -f k8s/
kubectl -n parcelpigeon get pods,svc,ingress
kubectl -n parcelpigeon rollout status deployment/gateway
```

Point `parcelpigeon.local` at the ingress and hit it, or skip DNS/hosts setup
for a quick check:

```bash
kubectl -n parcelpigeon port-forward svc/web 8080:8080
curl http://localhost:8080/healthz
```

## Step 7 — Sanity-check against docker-compose

For each service, diff its k8s env vars against its `docker-compose.yml`
block one more time — it's easy to drop a var while splitting into
ConfigMap/Secret. The one intentional deviation: `docker-compose.yml`'s
`shipments-service.build` path has a typo (`./service/shipment-service`);
the k8s Deployment correctly uses image name `shipments-service`, matching
both the real directory (`services/shipments-service`) and the
`.github/workflows/ci.yml` build matrix.
