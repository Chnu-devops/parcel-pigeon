# Splitting the umbrella chart into one chart per service — step by step

> On the `add-config-repo` branch `helm/` and `argocd/` move to the separate
> config repo `Chnu-devops/parcel-pigeon-gitops` — see `docs/config-repo-migration.md`.

This is the live-coding guide for turning the single `helm/parcelpigeon`
chart from the `add-gitops` branch (see `docs/gitops-migration.md`) into one
chart per component, each deployed by its own Argo CD Application.
`git diff add-gitops` on the `add-split-charts` branch is the reference /
answer key.

## Why split

With one chart behind one Application, Argo CD already applies only what
changed — editing gateway config only rolls the gateway. What hurts is
everything being **one unit**:

- one red component (e.g. rabbitmq CrashLooping) makes the whole app
  *Degraded*, and a failed sync blocks every service;
- history and rollback (`git revert`, Argo CD history) are all-or-nothing;
- one sync policy for stateless services and databases alike;
- CI bumped all four image tags on every push, so every push restarted
  every service.

After the split each service has its own chart, its own `values.yaml`, its
own Application with its own status/history, and CI only bumps the services
whose code changed. This is how teams usually work — a service owns its
chart.

The rendered Kubernetes objects stay the same 27 objects with the same names.
Only two labels change (`app.kubernetes.io/instance` and `helm.sh/chart`),
and so do the checksum annotations computed from them.

## What changes, what stays

| Umbrella chart (`add-gitops`) | Split charts (`add-split-charts`) |
|---|---|
| `helm/parcelpigeon/` | `helm/charts/<component>/` × 8 |
| `templates/_helpers.tpl` | `helm/library/parcelpigeon-common/` — a **library chart** each chart depends on |
| one `values.yaml`, nested per component (`.Values.gateway.port`) | one `values.yaml` per chart, flat (`.Values.port`) |
| one `Application` (`parcelpigeon`) | an `ApplicationSet` generating `parcelpigeon-<component>` × 8 |
| release `parcelpigeon` | release = component name (`gateway`, `postgres`, …) |
| CI bumps all 4 tags every push | CI bumps a tag only if that service's source changed |
| Ingress + NOTES.txt in the umbrella chart | moved into the `web` chart |

Resource **names stay identical** and everything still lands in the one
`parcelpigeon` namespace, so the DNS wiring (`postgres:5432`,
`http://shipments-service:8000`, …) is untouched.

Why not upstream charts (Bitnami etc.) for the datastores? They name their
objects after the release (`postgres-postgresql`, …) and change the
Secrets/env layout, which breaks the wiring above. That would be a separate,
deliberate migration.

## Step 1 — A library chart for the shared helpers

Every chart needs the same `parcelpigeon.labels` / `selectorLabels` helpers.
Copy-pasting `_helpers.tpl` 8 times would work, but Helm has a chart type
for exactly this:

```bash
mkdir -p helm/library/parcelpigeon-common/templates
git mv helm/parcelpigeon/templates/_helpers.tpl helm/library/parcelpigeon-common/templates/
```

`helm/library/parcelpigeon-common/Chart.yaml`:

```yaml
apiVersion: v2
name: parcelpigeon-common
description: Shared named templates (labels) for the ParcelPigeon charts
type: library
version: 0.1.0
```

`type: library` means "only `define`s, never renders objects, can't be
installed". The helpers are unchanged — when a service chart `include`s them,
`.Chart`/`.Release` refer to the *calling* chart, so `helm.sh/chart` becomes
`gateway-0.1.0` etc.

## Step 2 — One chart per component

For each component (`postgres redis rabbitmq mailhog shipments-service
tracking-service gateway web`) — shown for `gateway`:

```bash
mkdir -p helm/charts/gateway
git mv helm/parcelpigeon/templates/gateway helm/charts/gateway/templates
cp helm/parcelpigeon/.helmignore helm/charts/gateway/
```

`helm/charts/gateway/Chart.yaml` — declares the library as a dependency by
relative path:

```yaml
apiVersion: v2
name: gateway
description: ParcelPigeon gateway — public API reverse proxy
type: application
version: 0.1.0
appVersion: "latest"
dependencies:
  - name: parcelpigeon-common
    version: 0.1.0
    repository: file://../../library/parcelpigeon-common
```

`helm/charts/gateway/values.yaml` — the old `gateway:` block, **un-nested**
one level:

```yaml
image:
  repository: ghcr.io/chnu-devops/gateway
  tag: latest
replicas: 1
port: 8000
config:
  PORT: "8000"
  # …
```

Then drop the component prefix from the templates — and from the checksum
paths, since the templates now sit at the chart root:

```bash
sed -i '' -e 's/\.Values\.gateway\./.Values./g' \
          -e 's|BasePath "/gateway/|BasePath "/|g' \
          helm/charts/gateway/templates/*.yaml
```

The values key differs from the folder name for two charts: `shipmentsService`
→ `shipments-service`, `trackingService` → `tracking-service`. Use the
camelCase key in the first `sed` expression.

Extra for `web`: move `templates/ingress.yaml` and `templates/NOTES.txt` in
too (`.Values.web.port` → `.Values.port`), and append the old `ingress:`
block to `helm/charts/web/values.yaml` as is.

Finally:

```bash
git rm -r helm/parcelpigeon
for c in helm/charts/*/; do helm dependency update "$c"; done
echo 'helm/charts/*/charts/' >> .gitignore
```

`helm dependency update` writes `Chart.lock` (commit it) and packs the
library into `charts/` (git-ignored; Argo CD runs `helm dependency build`
itself when it renders the chart).

## Step 3 — Prove nothing changed

```bash
for c in helm/charts/*/; do helm lint "$c"; done
for c in helm/charts/*/; do helm template "$(basename $c)" "$c" -n parcelpigeon; done \
  > /tmp/split.yaml
grep -c '^kind:' /tmp/split.yaml        # 27, same as before

# render the old umbrella chart for a side-by-side diff
git worktree add /tmp/old add-gitops
helm template parcelpigeon /tmp/old/helm/parcelpigeon -n parcelpigeon > /tmp/umbrella.yaml
diff <(grep -v -e 'app.kubernetes.io/instance' -e 'helm.sh/chart' -e 'checksum/' /tmp/umbrella.yaml | sort) \
     <(grep -v -e 'app.kubernetes.io/instance' -e 'helm.sh/chart' -e 'checksum/' /tmp/split.yaml | sort)
git worktree remove /tmp/old
```

Empty diff = same objects, same specs. Selectors are still only
`app: <name>`, so the label change is a normal rolling update, not an
immutable-field error.

## Step 4 — An ApplicationSet instead of an Application

Writing 8 nearly identical Application files would work, but an
`ApplicationSet` generates them. The **git directory generator** creates one
Application per folder matching `helm/charts/*`, so a new chart folder
automatically becomes a new Application.

Replace `argocd/apps/parcelpigeon.yaml` with:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: parcelpigeon
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - git:
        repoURL: https://github.com/Chnu-devops/parcel-pigeon.git
        revision: main
        directories:
          - path: helm/charts/*
  template:
    metadata:
      name: "parcelpigeon-{{ .path.basename }}"
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: default
      source:
        repoURL: https://github.com/Chnu-devops/parcel-pigeon.git
        targetRevision: main
        path: "{{ .path.path }}"
        helm:
          releaseName: "{{ .path.basename }}"
      destination:
        server: https://kubernetes.default.svc
        namespace: parcelpigeon
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

- `{{ .path.path }}` = `helm/charts/gateway`, `{{ .path.basename }}` = `gateway`.
- `helm/library/` is outside `helm/charts/*`, so the library chart never
  becomes an Application (it couldn't be installed anyway).
- The root app-of-apps (`argocd/root-app.yaml`) is unchanged — it now syncs
  an ApplicationSet instead of an Application.
- Want a different policy for the datastores (e.g. no auto-prune)? Add a
  second generator/ApplicationSet over a `helm/datastores/*` folder — not
  done here, the `Delete=false` on PVCs already protects the data.

## Step 5 — CI bumps only what changed

The `bump-image-tags` job in `.github/workflows/ci.yml` now walks the four
app services and bumps a chart's tag **only if the service's source folder
changed since the commit that tag points to**:

```bash
declare -A src=(
  [gateway]=services/gateway
  [web]=web
  [shipments-service]=services/shipments-service
  [tracking-service]=services/tracking-service
)
for svc in "${!src[@]}"; do
  values="helm/charts/${svc}/values.yaml"
  current=$(yq '.image.tag' "$values")
  if git cat-file -e "${current}^{commit}" 2>/dev/null \
    && git diff --quiet "$current" "$SHA" -- "${src[$svc]}"; then
    echo "${svc}: unchanged since ${current::7}"
    continue
  fi
  yq -i '.image.tag = strenv(SHA)' "$values"
done
```

Comparing against the **deployed** commit instead of "the previous push" is
what makes it robust: if a run gets cancelled by `concurrency`, the next run
still sees the change. A tag that isn't a commit yet (`latest`) is always
bumped, so the first run after the merge pins all four. The checkout needs
`fetch-depth: 0` for the diff.

Push a web-only change → one bot commit touching `helm/charts/web/values.yaml`
→ only `parcelpigeon-web` goes OutOfSync → only the web pods roll.

## Step 6 — Cut over the cluster

The running cluster is managed by the single `parcelpigeon` Application
(from `add-gitops`). **Careful:** if you just merge, the root app prunes
the old Application, its finalizer cascades, and *every workload is deleted*
before the new Applications recreate them. Detach it first.

**A. Clean slate (simplest, loses data).**

```bash
kubectl -n argocd delete application root parcelpigeon   # cascades, deletes everything
kubectl delete namespace parcelpigeon                    # PVCs too
# merge add-split-charts into main, then:
kubectl apply -f argocd/root-app.yaml
```

**B. Hand over without downtime (keeps PVC data).**

```bash
# 1. stop the root app from acting on the merge
argocd app set root --sync-policy none

# 2. delete the old Application but NOT its resources (removes the finalizer)
argocd app delete parcelpigeon --cascade=false -y
kubectl -n parcelpigeon get deploy        # still all running, just unmanaged

# 3. merge add-split-charts into main

# 4. re-enable the root app (re-applies syncPolicy.automated from the file)
kubectl apply -f argocd/root-app.yaml
argocd app sync root
```

The root app creates the ApplicationSet; the ApplicationSet creates the 8
Applications; each adopts its existing objects. The new
`app.kubernetes.io/instance` / `helm.sh/chart` labels change each
Deployment's pod template, so every Deployment does **one** rolling update.
Selectors are unchanged, so it's an ordinary rollout, and the PVCs are
reused as they are.

Check:

```bash
kubectl -n argocd get applicationsets,applications
# root, parcelpigeon-gateway, parcelpigeon-postgres, … — all Synced / Healthy
kubectl -n parcelpigeon get pods
kubectl -n parcelpigeon port-forward svc/web 8080:8080
curl http://localhost:8080/healthz
```

## Step 7 — Day-2 operations, per service

```bash
argocd app list                                  # one row per service
argocd app history parcelpigeon-gateway          # this service only
argocd app sync parcelpigeon-web                 # sync / redeploy one service
kubectl -n parcelpigeon rollout restart deploy/web   # restart without a Git change

# roll back one service: revert only the bot commit that bumped it
git log --oneline -- helm/charts/gateway/values.yaml
git revert <commit> && git push

# a new service = a new chart folder; the ApplicationSet picks it up
cp -r helm/charts/gateway helm/charts/eta-service   # then edit names/values
```

Note: Argo CD's own *Rollback* button is disabled while auto-sync is on. In
GitOps, rolling back means a `git revert`.

## Later (not in this branch)

Separate policies for datastores vs. services (two ApplicationSets);
per-environment values via a matrix generator; publishing charts to an OCI
registry (`helm push` to GHCR) and pinning versions instead of tracking
`main`; charts living next to each service's code — see `docs/lecture-map.md`.
