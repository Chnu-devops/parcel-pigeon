# Migrating from raw k8s manifests to Helm — step by step

This is the live-coding guide for turning the hand-written `k8s/` folder from
the `add-k8s` branch (see `docs/kubernetes.md`) into a single Helm chart at
`helm/parcelpigeon`. `git diff add-k8s` on the `add-helm` branch is the
reference / answer key.

The goal of the migration is **zero behaviour change**: the chart, rendered
with its default values, produces the same 27 resources the raw manifests
did — same names, ports, env vars, probes and resources. Helm only adds
labels, annotations, and the ability to change things through values instead
of editing YAML.

## Prerequisites

```bash
helm version
kubectl version --client
minikube start
minikube addons enable ingress
```

## What changes, what stays

| Raw manifests (`k8s/`) | Helm chart (`helm/parcelpigeon/`) |
|---|---|
| `k8s/namespace.yaml` | gone — `helm install -n parcelpigeon --create-namespace` |
| `namespace: parcelpigeon` in every file | gone — Helm installs into the release namespace |
| `k8s/<component>/*.yaml` | `templates/<component>/*.yaml` (same files, templated) |
| image tags, ports, replicas, resources, env vars hardcoded | lifted into `values.yaml` |
| `labels: {app: <name>}` | `app: <name>` kept + standard `app.kubernetes.io/*` labels |
| `kubectl apply -R -f k8s/` | `helm upgrade --install …` |
| no history / rollback | `helm history`, `helm rollback` |

Resource **names stay identical** (`gateway`, `postgres-data`,
`shipments-service-secret`, …). The services find each other by DNS name
(`http://shipments-service:8000`, `redis:6379`, …), so renaming anything —
e.g. prefixing with the release name, which `helm create` does by default —
would break the wiring.

## Step 1 — Scaffold the chart

```bash
mkdir -p helm
helm create helm/parcelpigeon
```

`helm create` generates an nginx demo. Throw most of it away:

```bash
cd helm/parcelpigeon
rm -rf templates/* charts/
: > values.yaml
```

Keep `Chart.yaml` and `.helmignore`. Edit `Chart.yaml` down to:

```yaml
apiVersion: v2
name: parcelpigeon
description: ParcelPigeon — web, gateway, shipments/tracking services and their datastores
type: application
version: 0.1.0      # version of the chart itself
appVersion: "latest" # version of the app it deploys
```

## Step 2 — Move the manifests in as-is

```bash
cd ../..                      # repo root
git mv k8s/* helm/parcelpigeon/templates/
git rm helm/parcelpigeon/templates/namespace.yaml
```

Now delete the `namespace: parcelpigeon` line from every file under
`templates/` (Helm sets the namespace from `-n`):

```bash
grep -rl 'namespace: parcelpigeon' helm/parcelpigeon/templates \
  | xargs sed -i '' '/namespace: parcelpigeon/d'   # GNU sed: drop the ''
```

Checkpoint — this is already a working (if pointless) chart:

```bash
helm lint helm/parcelpigeon
helm template parcelpigeon helm/parcelpigeon -n parcelpigeon | less
```

Templates without any `{{ }}` are rendered verbatim. Everything from here on
is incremental: template one thing, re-run `helm template`, check the output.

## Step 3 — Shared labels in `_helpers.tpl`

Create `templates/_helpers.tpl`. Files starting with `_` are not rendered —
they only hold named templates (`define`) you `include` elsewhere.

```gotemplate
{{- define "parcelpigeon.chart" -}}
{{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "parcelpigeon.selectorLabels" -}}
app: {{ . }}
{{- end }}

{{- define "parcelpigeon.labels" -}}
{{ include "parcelpigeon.selectorLabels" .name }}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/part-of: parcelpigeon
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ include "parcelpigeon.chart" .ctx }}
{{- end }}
```

Two things worth pointing out in class:

- `selectorLabels` is **only** `app: <name>` — exactly what the raw
  manifests used. A Deployment's `spec.selector` is immutable, so changing it
  would make in-place upgrades of existing Deployments fail.
- `labels` needs both the component name and the root context (`$`, for
  `.Release`), and `include` takes one argument — hence the
  `(dict "name" "gateway" "ctx" $)` pattern.

## Step 4 — Walk one component end to end: gateway

### 4a. Values

Add a block to `values.yaml` holding everything that was hardcoded in
`templates/gateway/*.yaml`:

```yaml
gateway:
  image:
    repository: ghcr.io/rostyslavdiachuk/gateway
    tag: latest
  replicas: 1
  port: 8000
  config:                # → ConfigMap gateway-config
    PORT: "8000"
    HOST: "0.0.0.0"
    SHIPMENTS_URL: "http://shipments-service:8000"
    TRACKING_URL: "http://tracking-service:8002"
    LOG_LEVEL: "info"
  secret:                # → Secret gateway-secret
    GATEWAY_API_KEY: ""
  resources:
    requests: {cpu: 50m, memory: 64Mi}
    limits:   {cpu: 250m, memory: 128Mi}
```

### 4b. ConfigMap and Secret — `range` over a map

`templates/gateway/configmap.yaml`:

```gotemplate
apiVersion: v1
kind: ConfigMap
metadata:
  name: gateway-config
  labels:
    {{- include "parcelpigeon.labels" (dict "name" "gateway" "ctx" $) | nindent 4 }}
data:
  {{- range $key, $value := .Values.gateway.config }}
  {{ $key }}: {{ $value | quote }}
  {{- end }}
```

`templates/gateway/secret.yaml` is the same shape with `kind: Secret`,
`type: Opaque`, `stringData:` and `.Values.gateway.secret`.

`| quote` matters: ConfigMap values must be strings, and without it
`"8000"` / `"true"` from values would render as a YAML number / bool and the
API server would reject the ConfigMap.

### 4c. Deployment

In `templates/gateway/deployment.yaml` replace the hardcoded bits:

```gotemplate
metadata:
  name: gateway
  labels:
    {{- include "parcelpigeon.labels" (dict "name" "gateway" "ctx" $) | nindent 4 }}
spec:
  replicas: {{ .Values.gateway.replicas }}
  selector:
    matchLabels:
      {{- include "parcelpigeon.selectorLabels" "gateway" | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "parcelpigeon.labels" (dict "name" "gateway" "ctx" $) | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/gateway/configmap.yaml") . | sha256sum }}
        checksum/secret: {{ include (print $.Template.BasePath "/gateway/secret.yaml") . | sha256sum }}
    spec:
      containers:
        - name: gateway
          image: "{{ .Values.gateway.image.repository }}:{{ .Values.gateway.image.tag }}"
          ports:
            - containerPort: {{ .Values.gateway.port }}
          # envFrom unchanged
          readinessProbe:
            httpGet:
              path: /readyz
              port: {{ .Values.gateway.port }}
            # …delays unchanged
          livenessProbe:
            httpGet:
              path: /healthz
              port: {{ .Values.gateway.port }}
          resources:
            {{- toYaml .Values.gateway.resources | nindent 12 }}
```

New concepts here:

- **`nindent N`** — newline + indent by N spaces. Count the spaces to the
  key's column; getting it wrong is the #1 Helm bug. `{{-` trims the
  whitespace before the tag so you don't get a blank line.
- **`toYaml`** — dumps a whole values sub-tree, so new resource keys
  (e.g. `ephemeral-storage`) need no template change.
- **`checksum/*` annotations** — pods only read `envFrom` at start-up, so
  `kubectl apply` of a changed ConfigMap never reached running pods. Hashing
  the rendered ConfigMap/Secret into the pod template means any config change
  changes the pod spec, and `helm upgrade` rolls the Deployment automatically.

### 4d. Service

```gotemplate
spec:
  selector:
    {{- include "parcelpigeon.selectorLabels" "gateway" | nindent 4 }}
  ports:
    - port: {{ .Values.gateway.port }}
      targetPort: {{ .Values.gateway.port }}
```

Checkpoint:

```bash
helm template parcelpigeon helm/parcelpigeon -n parcelpigeon -s templates/gateway/deployment.yaml
helm template parcelpigeon helm/parcelpigeon -n parcelpigeon --set gateway.image.tag=abc123 \
  -s templates/gateway/deployment.yaml | grep image:
```

## Step 5 — Repeat for the other components

Same pattern; the values key is camelCase because Go templates can't read
`.Values.shipments-service`.

| Component | values key | Lifted into values | Notes |
|---|---|---|---|
| shipments-service | `shipmentsService` | image, replicas, port `8000`, config, secret, resources | identical to gateway |
| tracking-service | `trackingService` | image, replicas, port `8002`, config, secret, resources | identical to gateway |
| web | `web` | image, replicas, port `8080`, resources | no ConfigMap/Secret, no checksums |
| postgres | `postgres` | image, replicas, port, `persistence.size`, secret, resources | probe user from `.Values.postgres.secret.POSTGRES_USER`; checksum on the secret only |
| redis | `redis` | image, replicas, port, `persistence.size`, resources | keep the `command:` hardcoded |
| rabbitmq | `rabbitmq` | image, replicas, `ports: {amqp, management}`, `persistence.size`, resources | fixes a bug in the raw manifests: add a `startupProbe` (TCP 5672) and `timeoutSeconds: 10` on the `rabbitmq-diagnostics` probes — otherwise the 1s default timeout makes the pod CrashLoop and shipments/gateway never get Ready |
| mailhog | `mailhog` | image, replicas, `ports: {smtp, ui}`, resources | no PVC |

For the two multi-port Services, `range` over the `ports` map so each map
key becomes the port name:

```gotemplate
  ports:
    {{- range $name, $port := .Values.rabbitmq.ports }}
    - name: {{ $name }}
      port: {{ $port }}
      targetPort: {{ $port }}
    {{- end }}
```

For the three PVCs, template the size and add one annotation:

```gotemplate
metadata:
  name: postgres-data
  annotations:
    helm.sh/resource-policy: keep
spec:
  resources:
    requests:
      storage: {{ .Values.postgres.persistence.size }}
```

`resource-policy: keep` tells Helm not to delete the volume on
`helm uninstall`, so a reinstall gets its data back. It also means you have
to delete PVCs by hand when you really want a clean slate (Step 9).

## Step 6 — Ingress toggle and NOTES.txt

Wrap `templates/ingress.yaml` in a condition and template the host/class/port:

```gotemplate
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: parcelpigeon
spec:
  ingressClassName: {{ .Values.ingress.className }}
  rules:
    - host: {{ .Values.ingress.host }}
      # … backend: service web, port {{ .Values.web.port }}
{{- end }}
```

```yaml
# values.yaml
ingress:
  enabled: true
  className: nginx
  host: parcelpigeon.local
```

Add `templates/NOTES.txt` — it's rendered and printed after every
`helm install`/`upgrade`. Ours prints the port-forward + curl check.

## Step 7 — Prove nothing changed

```bash
helm lint helm/parcelpigeon
helm template parcelpigeon helm/parcelpigeon -n parcelpigeon > /tmp/helm.yaml
grep -c '^kind:' /tmp/helm.yaml          # 27 — the old 28 minus the Namespace
```

Compare it against the old manifests:

```bash
for f in $(git ls-tree -r --name-only add-k8s k8s); do echo '---'; git show add-k8s:$f; done > /tmp/k8s.yaml
```

If a cluster is still running the raw manifests, the most convincing check is
a server-side diff — only labels and the checksum annotations should show up:

```bash
kubectl diff -n parcelpigeon -f /tmp/helm.yaml
```

## Step 8 — Cut over a running cluster

You have two options.

**A. Clean slate (simplest, loses data).** Fine for this sandbox:

```bash
kubectl delete namespace parcelpigeon            # removes everything, incl. PVCs
helm upgrade --install parcelpigeon helm/parcelpigeon \
  -n parcelpigeon --create-namespace
```

**B. Adopt the existing resources (keeps PVC data).** Helm refuses to touch
objects it doesn't own (`invalid ownership metadata`). Mark every object as
owned by the release, then install over them:

```bash
for kind in deploy svc cm secret pvc ingress; do
  kubectl -n parcelpigeon label    "$kind" --all app.kubernetes.io/managed-by=Helm --overwrite
  kubectl -n parcelpigeon annotate "$kind" --all \
    meta.helm.sh/release-name=parcelpigeon \
    meta.helm.sh/release-namespace=parcelpigeon --overwrite
done
helm upgrade --install parcelpigeon helm/parcelpigeon -n parcelpigeon
```

(`--all` also hits the auto-created `kube-root-ca.crt` ConfigMap and any
token Secrets — harmless, Helm ignores objects not in its manifest.) This
works because the selectors (`app: <name>`) did not change; the Deployments
just roll once for the new pod labels/annotations.

Then check:

```bash
helm list -n parcelpigeon
kubectl -n parcelpigeon get pods,svc,ingress
kubectl -n parcelpigeon port-forward svc/web 8080:8080
curl http://localhost:8080/healthz
```

## Step 9 — Day-2 operations (what Helm buys us)

```bash
# ship a new image without editing YAML
helm upgrade parcelpigeon helm/parcelpigeon -n parcelpigeon --reuse-values \
  --set gateway.image.tag=sha-abc123

# change config → checksum changes → gateway pods roll by themselves
helm upgrade parcelpigeon helm/parcelpigeon -n parcelpigeon --reuse-values \
  --set gateway.config.LOG_LEVEL=debug

helm history  parcelpigeon -n parcelpigeon
helm rollback parcelpigeon 1 -n parcelpigeon
helm get values parcelpigeon -n parcelpigeon

# tear down (PVCs survive because of resource-policy: keep)
helm uninstall parcelpigeon -n parcelpigeon
kubectl -n parcelpigeon delete pvc --all      # only if you want the data gone
```

## Later (not in this branch)

`values-dev.yaml` / `values-prod.yaml` overlays, HPA/PDB, `ServiceMonitor`,
and Argo CD reconciling this chart from Git — see `docs/lecture-map.md`.
The Argo CD step is on the `add-gitops` branch: `docs/gitops-migration.md`.
