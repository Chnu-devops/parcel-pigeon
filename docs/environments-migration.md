# dev → staging → prod: environments in the config repo — step by step

This is the guide for turning the config repo
[`Chnu-devops/parcel-pigeon-gitops`](https://github.com/Chnu-devops/parcel-pigeon-gitops)
from "one environment" into a production-style layout with **dev, staging
and prod**, image promotion by pull request, and a `clusters/` folder that
says what runs where. It builds on `docs/config-repo-migration.md`.

Answer keys: the config repo's `environments` branch (`git diff main`
there), and `git diff add-config-repo` on the app repo's `add-environments`
branch (one line of CI).

## The target layout

```
apps/
├── gateway/
│   ├── base/                 # the Helm chart — shared by all environments
│   │   ├── Chart.yaml
│   │   ├── values.yaml       # defaults
│   │   └── templates/
│   └── overlays/
│       ├── dev/values.yaml   # image.tag, LOG_LEVEL: debug
│       ├── staging/values.yaml
│       └── prod/values.yaml  # replicas: 2
├── web/  shipments-service/  tracking-service/
├── postgres/  redis/  rabbitmq/  mailhog/
lib/
└── parcelpigeon-common/      # library chart (labels)
clusters/
├── dev/                      # the dev cluster runs dev + staging
│   ├── root.yaml
│   └── apps/
│       ├── parcelpigeon-dev.yaml
│       └── parcelpigeon-staging.yaml
└── prod/
    ├── root.yaml
    └── apps/parcelpigeon-prod.yaml
.github/workflows/promote.yml
```

`base/overlays` is Kustomize's vocabulary, but we keep Helm: **base is the
chart, an overlay is a values file**. Argo CD passes both to Helm
(`-f base/values.yaml -f overlays/prod/values.yaml`). The later file wins,
and maps are merged key by key, so an overlay holds *only the differences*.
Setting `config.LOG_LEVEL: debug` in dev keeps the other four gateway config
keys from base.

Two questions, two folders:

| | `apps/` | `clusters/` |
|---|---|---|
| answers | *how* is a component deployed, per env | *what* runs on which cluster |
| changes when | config/version of a service changes | an env or cluster is added/moved |

All three environments run on the one minikube, each in its own namespace
(`parcelpigeon-dev`, `-staging`, `-prod`). On real infrastructure, prod would
be a separate cluster: register it with `argocd cluster add` and change
`destination.server` in `clusters/prod/`. Nothing in `apps/` would change.

## What changes, what stays

| Before (`main`) | After (`environments`) |
|---|---|
| `helm/charts/<c>/` | `apps/<c>/base/` (unchanged chart) |
| `helm/library/parcelpigeon-common` | `lib/parcelpigeon-common` |
| one `values.yaml` per chart incl. `image.tag` | base defaults + `overlays/<env>/values.yaml` (tag lives here) |
| `argocd/root-app.yaml` | `clusters/{dev,prod}/root.yaml` |
| one ApplicationSet → `parcelpigeon-<c>` | one ApplicationSet per env → `<c>-<env>` (24 apps) |
| namespace `parcelpigeon` | `parcelpigeon-{dev,staging,prod}` |
| CI bumps the tag → deployed | CI bumps **dev** → PR to staging → PR to prod |
| host `parcelpigeon.local` | `dev.` / `staging.` / plain `parcelpigeon.local` (prod) |

## Prerequisites

- The config repo migration is done and running (`docs/config-repo-migration.md`).
- Three full stacks plus Argo CD need about **2 GiB of requests**, and more
  when pods are busy. Check what the node has:

  ```bash
  kubectl describe node minikube | grep -A6 'Allocated resources'
  minikube config get memory
  ```

  minikube can't resize a running cluster. If it's below ~6 GB, recreate it
  with `minikube delete && minikube start --memory 8g --cpus 4`, then
  `minikube addons enable ingress` and reinstall Argo CD (`docs/gitops-migration.md`
  Step 1). That's a clean slate anyway, so skip Step 6's cleanup.

All work happens in the config repo on a branch:

```bash
cd ../parcel-pigeon-gitops
git switch -c environments
```

## Step 1 — Charts become `base`

```bash
mkdir -p apps lib
git mv helm/library/parcelpigeon-common lib/parcelpigeon-common
for c in $(ls helm/charts); do
  mkdir -p apps/$c
  git mv helm/charts/$c apps/$c/base
done
```

The library is now one level deeper relative to each chart. Fix the
dependency path in every `apps/*/base/Chart.yaml`:

```bash
sed -i '' 's|file://../../library/parcelpigeon-common|file://../../../lib/parcelpigeon-common|' \
  apps/*/base/Chart.yaml
for d in apps/*/base; do helm dependency update $d; done   # rewrites Chart.lock
```

and in `.gitignore`, `helm/charts/*/charts/` becomes `apps/*/base/charts/`.

The charts' own `values.yaml` stay as they are. They're now the defaults
every environment starts from. `image.tag: latest` there is only a fallback;
each environment pins its own tag in its overlay.

## Step 2 — Overlays: only what differs

One `values.yaml` per component per environment. For the four app services
the overlay **owns the image tag**. That's the line CI and promotion PRs edit.

`apps/gateway/overlays/dev/values.yaml`:

```yaml
# gateway — dev overrides on top of ../../base/values.yaml.
image:
  tag: latest # bumped by app-repo CI on every push to main
config:
  LOG_LEVEL: debug
```

`apps/gateway/overlays/prod/values.yaml`:

```yaml
# gateway — prod overrides on top of ../../base/values.yaml.
image:
  tag: latest # promoted from staging by a reviewed PR
replicas: 2
```

What we vary, and why:

| | dev | staging | prod |
|---|---|---|---|
| `image.tag` (gateway, web, shipments, tracking) | CI | promotion PR | promotion PR |
| `gateway.config.LOG_LEVEL` / `shipments` `SHIPMENTS_LOG_LEVEL` | `debug` / `DEBUG` | base | base |
| `web.ingress.host` | `dev.parcelpigeon.local` | `staging.parcelpigeon.local` | `parcelpigeon.local` |
| `replicas` | 1 | 1 | **2** for gateway + web |
| `postgres.persistence.size` | 1Gi | 1Gi | **5Gi** |

`shipments-service` stays at 1 replica everywhere: its entrypoint runs
`alembic upgrade head`, and two pods starting together would race on the
migration. `tracking-service` stays at 1 because it's the single RabbitMQ
consumer that keeps the Redis read model in order.

The datastores' overlays have no overrides (except prod postgres), but the
**folder must exist**. Its existence is what deploys the component to that
environment (Step 3):

```yaml
# redis — dev overrides on top of ../../base/values.yaml.
# None: base defaults are fine here. The folder must exist — it's what
# makes the dev ApplicationSet deploy redis to dev.
```

Checkpoint: render every component in every env exactly as Argo CD will:

```bash
for env in dev staging prod; do
  for d in apps/*/; do c=$(basename $d)
    helm template $c $d/base -n parcelpigeon-$env \
      -f $d/base/values.yaml -f $d/overlays/$env/values.yaml
  done > /tmp/$env.yaml
  echo "$env: $(grep -c '^kind:' /tmp/$env.yaml) objects"     # 27 each
done
grep -h 'host:' /tmp/{dev,staging,prod}.yaml
```

## Step 3 — `clusters/`: one ApplicationSet per environment

`git rm -r argocd`, and replace it with `clusters/`.

`clusters/dev/apps/parcelpigeon-dev.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: parcelpigeon-dev
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - git:
        repoURL: https://github.com/Chnu-devops/parcel-pigeon-gitops.git
        revision: main
        directories:
          - path: apps/*/overlays/dev
  template:
    metadata:
      name: "{{ index .path.segments 1 }}-dev"
      labels:
        env: dev
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: default
      source:
        repoURL: https://github.com/Chnu-devops/parcel-pigeon-gitops.git
        targetRevision: main
        path: "apps/{{ index .path.segments 1 }}/base"
        helm:
          releaseName: "{{ index .path.segments 1 }}"
          valueFiles:
            - values.yaml
            - ../overlays/dev/values.yaml
      destination:
        server: https://kubernetes.default.svc
        namespace: parcelpigeon-dev
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

- The generator now matches **overlay folders**, not charts:
  `apps/gateway/overlays/dev` → `.path.segments` = `[apps, gateway, overlays, dev]`,
  so `index .path.segments 1` is the component.
- `source.path` is the chart (`base`), and `valueFiles` reaches *out* of it
  with `../overlays/dev/values.yaml`. Argo CD allows value files anywhere
  inside the same repo.
- `parcelpigeon-staging.yaml` and `parcelpigeon-prod.yaml` are the same file
  with `dev` replaced. They're deliberately three plain files rather than one
  clever matrix generator: each env can drift (e.g. prod without
  `selfHeal`, or a different `destination.server`) without touching the
  others.

`clusters/dev/root.yaml` (and the same for `prod`) is the bootstrap
Application for that cluster. It syncs `clusters/dev/apps/`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cluster-dev
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/Chnu-devops/parcel-pigeon-gitops.git
    targetRevision: main
    path: clusters/dev/apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

Roots get **no finalizer**: deleting `cluster-prod` by accident must not
cascade into deleting prod.

## Step 4 — Promotion by pull request

`.github/workflows/promote.yml` in the config repo copies image tags from one
environment's overlays to the next and opens a PR. **Merging the PR is the
deploy.**

- **dev → staging, automatic.** It runs on every push to `main` that touches
  `apps/*/overlays/dev/values.yaml` (i.e. every CI bump). It keeps a single
  rolling PR, *Promote dev → staging*, on branch `promote/staging`. Each new
  dev bump updates it, and if staging already matches dev there's no PR.
- **staging → prod, manual.** *Actions → Promote → Run workflow* (from
  `staging`, to `prod`) opens *Promote staging → prod*. A person reviews the
  list of services/SHAs in the PR and merges it.
- Any other direction (dev → prod) is refused, so nothing skips staging.

The core of it:

```bash
for from_values in apps/*/overlays/"$FROM"/values.yaml; do
  app=$(echo "$from_values" | cut -d/ -f2)
  to_values="apps/${app}/overlays/${TO}/values.yaml"
  [ -f "$to_values" ] || continue                 # not deployed to $TO
  tag=$(yq '.image.tag // ""' "$from_values")
  [ -n "$tag" ] || continue                       # datastores: no tag
  [ "$(yq '.image.tag // ""' "$to_values")" = "$tag" ] && continue
  TAG="$tag" yq -i '.image.tag = strenv(TAG)' "$to_values"
done
```

followed by `peter-evans/create-pull-request`, which commits the diff to
`promote/<env>` and opens/updates the PR.

Config repo settings (GitHub UI):

- **Settings → Actions → General → Workflow permissions**: tick *Allow GitHub
  Actions to create and approve pull requests*. In an organization this may
  also have to be allowed at org level first (**Chnu-devops → Settings →
  Actions → General**).
- Pushes made with the CI **deploy key** trigger workflows (unlike pushes
  made with `GITHUB_TOKEN`), so the app repo's dev bump is what kicks off
  `promote.yml`.

Production-style hardening, optional for the sandbox:

- Protect `main` with *Require a pull request* and add the CI deploy key as a
  bypass actor (it pushes dev bumps directly).
- A `CODEOWNERS` line such as `apps/*/overlays/prod/ @Chnu-devops/release-managers`
  plus *Require review from Code Owners*: only that team can approve prod.

## Step 5 — App repo: CI writes to the dev overlay

On the app repo's `add-environments` branch, one path changes in
`bump-image-tags`:

```diff
-              values="gitops/helm/charts/${svc}/values.yaml"
+              values="gitops/apps/${svc}/overlays/dev/values.yaml"
```

and the commit message says which env it deployed:
`deploy(dev): gateway,web a1b2c3d`. CI never touches staging or prod.

## Step 6 — Cut over

The running setup is `root` → ApplicationSet `parcelpigeon` → 8 apps in
namespace `parcelpigeon`. The new environments use new namespaces, so this
is a **fresh deploy**, not an in-place adoption. PVCs are per namespace and
can't be moved. Data in the old namespace is demo data; reseed it after
(dump it first with `pg_dump` if you care).

Order matters, because merging removes `argocd/`, which the old `root` reads:

```bash
# 1. detach the old root so it can't act on the merge
#    (no finalizer on it → only the root object goes, nothing below it)
kubectl -n argocd delete application root

# 2. merge `environments` into main in the config repo,
#    then right away merge `add-environments` in the app repo
#    (until both are merged, the app repo's CI bump points at a path that doesn't exist)

# 3. retire the old stack — the old ApplicationSet now finds no helm/charts/*,
#    deletes its 8 apps, and their finalizers delete the workloads (PVCs kept)
kubectl -n argocd delete applicationset parcelpigeon --ignore-not-found
kubectl delete namespace parcelpigeon        # drops the old PVCs too

# 4. bootstrap the new layout
kubectl apply -f clusters/dev/root.yaml -f clusters/prod/root.yaml
```

The old stack must be gone before prod comes up: both Ingresses claim
`parcelpigeon.local`, and the ingress-nginx admission webhook rejects the
second one.

Check:

```bash
kubectl -n argocd get applications -L env      # 2 roots + 24 apps, Synced / Healthy
kubectl get ns | grep parcelpigeon              # -dev, -staging, -prod
kubectl -n parcelpigeon-prod get deploy         # gateway + web at 2/2

# hosts: all three point at the ingress
echo "$(minikube ip) dev.parcelpigeon.local staging.parcelpigeon.local parcelpigeon.local" \
  | sudo tee -a /etc/hosts
curl -s http://dev.parcelpigeon.local/healthz

# demo data, per environment
for env in dev staging prod; do
  kubectl -n parcelpigeon-$env exec deploy/shipments-service -- python -m app.seed
done
```

## Step 7 — Walk one change to prod

```bash
# app repo
echo "// touch" >> web/src/main.tsx && git commit -am "web: touch" && git push
```

1. **App repo CI**: tests → `ghcr.io/chnu-devops/web:<sha>` →
   config repo commit `deploy(dev): web <sha7>` → **`web-dev`** syncs.
2. **Config repo**: `promote.yml` opens/updates *Promote dev → staging*
   listing `` `web` → `<sha7>` ``. Merge → **`web-staging`** syncs.
3. **Actions → Promote → Run workflow** (staging → prod) → *Promote staging
   → prod*. Review, merge → **`web-prod`** syncs, both replicas roll.

Each environment's history is its own folder's history:

```bash
git log --oneline -- apps/web/overlays/prod/
argocd app history web-prod
```

Rollback in prod = revert the promotion commit, by PR like everything else
in prod:

```bash
git revert <promotion-commit>   # on a branch → PR → merge → web-prod syncs back
```

## Step 8 — Things that are now one small PR

```bash
# prod-only change: more memory for gateway in prod
yq -i '.resources.limits.memory = "256Mi"' apps/gateway/overlays/prod/values.yaml

# try a new component in dev only: give it only an overlays/dev folder
mkdir -p apps/eta-service/overlays/dev     # + apps/eta-service/base chart
# → eta-service-dev appears; staging/prod get it when their folders are added

# take a component out of staging
git rm -r apps/mailhog/overlays/staging    # → mailhog-staging is deleted
```

## Later (not in this branch)

`AppProject` per environment (prod apps may only deploy to
`parcelpigeon-prod`, plus Argo CD RBAC on who can sync prod); a real second
cluster for prod (`argocd cluster add`); a validation workflow in the config
repo that `helm template`s every app × env on each PR; per-env secrets
(prod must not share the dev passwords in `base/values.yaml`) via Sealed
Secrets / External Secrets; Argo CD sync windows for prod — see
`docs/lecture-map.md`.
