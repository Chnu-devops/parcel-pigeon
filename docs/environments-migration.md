# dev → prod: environments in the config repo — step by step

> Just want it running from scratch? See `docs/running-gitops.md`.

This is the guide for turning the config repo
[`Chnu-devops/parcel-pigeon-gitops`](https://github.com/Chnu-devops/parcel-pigeon-gitops)
from "one environment" into a production-style layout with **dev and
prod**, image promotion by pull request, our services and the datastores
in separate folders, and a `clusters/` folder that says what runs where.
It builds on `docs/config-repo-migration.md`.

Answer keys: the config repo's `environments` branch (`git diff main`
there), and `git diff add-config-repo` on the app repo's `add-environments`
branch (one line of CI).

## The target layout

```
apps/                         # our services — images built by app-repo CI
├── gateway/
│   ├── base/                 # the Helm chart — shared by all environments
│   │   ├── Chart.yaml
│   │   ├── values.yaml       # defaults
│   │   └── templates/
│   └── overlays/
│       ├── dev/values.yaml   # image.tag (CI), LOG_LEVEL: debug
│       └── prod/values.yaml  # image.tag (promotion PR), replicas: 2
├── web/  shipments-service/  tracking-service/
services/                     # datastores & infra — upstream images
├── postgres/                 # same base/ + overlays/ shape
├── redis/  rabbitmq/  mailhog/
lib/
└── parcelpigeon-common/      # library chart (labels)
clusters/
├── dev/
│   ├── root.yaml
│   └── apps/parcelpigeon-dev.yaml
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

Why `apps/` vs `services/`:

| | `apps/` | `services/` |
|---|---|---|
| what | gateway, web, shipments-service, tracking-service | postgres, redis, rabbitmq, mailhog |
| image | ours, `ghcr.io/chnu-devops/*:<sha>` | upstream (`postgres:16-alpine`, …) |
| tag changes by | CI (dev) → promotion PR (prod) | a person, by PR, rarely |
| lifecycle | many deploys a day | stateful, upgraded carefully |
| in prod, later | stays here | often replaced by managed services (RDS, ElastiCache, …) |

`clusters/` answers a different question from both: *what runs on which
cluster*.

Both environments run on the one minikube, each in its own namespace
(`parcelpigeon-dev`, `parcelpigeon-prod`). On real infrastructure, prod would
be a separate cluster: register it with `argocd cluster add` and change
`destination.server` in `clusters/prod/`. Nothing in `apps/` or `services/`
would change.

## What changes, what stays

| Before (`main`) | After (`environments`) |
|---|---|
| `helm/charts/{gateway,web,shipments-service,tracking-service}/` | `apps/<c>/base/` (unchanged chart) |
| `helm/charts/{postgres,redis,rabbitmq,mailhog}/` | `services/<c>/base/` (unchanged chart) |
| `helm/library/parcelpigeon-common` | `lib/parcelpigeon-common` |
| one `values.yaml` per chart incl. `image.tag` | base defaults + `overlays/<env>/values.yaml` (tag lives here) |
| `argocd/root-app.yaml` | `clusters/{dev,prod}/root.yaml` |
| one ApplicationSet → `parcelpigeon-<c>` | one ApplicationSet per env → `<c>-<env>` (16 apps) |
| namespace `parcelpigeon` | `parcelpigeon-dev`, `parcelpigeon-prod` |
| CI bumps the tag → deployed | CI bumps **dev** → reviewed PR → prod |
| host `parcelpigeon.local` | `dev.parcelpigeon.local` / `parcelpigeon.local` (prod) |

## Prerequisites

- The config repo migration is done and running (`docs/config-repo-migration.md`).
- Two full stacks plus Argo CD need about **1.5 GiB of requests**, and more
  when pods are busy. Check what the node has:

  ```bash
  kubectl describe node minikube | grep -A6 'Allocated resources'
  minikube config get memory
  ```

  minikube can't resize a running cluster. If it's below ~4 GB, recreate it
  with `minikube delete && minikube start --memory 6g --cpus 4`, then
  `minikube addons enable ingress` and reinstall Argo CD (`docs/gitops-migration.md`
  Step 1). That's a clean slate anyway, so skip Step 6's cleanup.

All work happens in the config repo on a branch:

```bash
cd ../parcel-pigeon-gitops
git switch -c environments
```

## Step 1 — Charts become `base`, split into `apps/` and `services/`

```bash
mkdir -p apps services lib
git mv helm/library/parcelpigeon-common lib/parcelpigeon-common
for c in gateway web shipments-service tracking-service; do
  mkdir -p apps/$c && git mv helm/charts/$c apps/$c/base
done
for c in postgres redis rabbitmq mailhog; do
  mkdir -p services/$c && git mv helm/charts/$c services/$c/base
done
```

The library is now one level deeper relative to each chart (the same depth
from both folders). Fix the dependency path and rebuild the lock files:

```bash
sed -i '' 's|file://../../library/parcelpigeon-common|file://../../../lib/parcelpigeon-common|' \
  apps/*/base/Chart.yaml services/*/base/Chart.yaml
for d in apps/*/base services/*/base; do helm dependency update $d; done
```

In `.gitignore`, `helm/charts/*/charts/` becomes:

```gitignore
apps/*/base/charts/
services/*/base/charts/
```

The charts' own `values.yaml` stay as they are. They're now the defaults
every environment starts from. `image.tag: latest` there is only a fallback;
each environment pins its own tag in its overlay.

## Step 2 — Overlays: only what differs

One `values.yaml` per component per environment. For the four `apps/` the
overlay **owns the image tag**. That's the line CI and the promotion PR edit.

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
  tag: latest # promoted from dev by a reviewed "Promote dev → prod" PR
replicas: 2
```

What we vary, and why:

| | dev | prod |
|---|---|---|
| `image.tag` (all of `apps/`) | CI | promotion PR |
| gateway `LOG_LEVEL` / shipments `SHIPMENTS_LOG_LEVEL` | `debug` / `DEBUG` | base |
| web `ingress.host` | `dev.parcelpigeon.local` | `parcelpigeon.local` |
| `replicas` | 1 | **2** for gateway + web |
| postgres `persistence.size` | 1Gi | **5Gi** |

`shipments-service` stays at 1 replica everywhere: its entrypoint runs
`alembic upgrade head`, and two pods starting together would race on the
migration. `tracking-service` stays at 1 because it's the single RabbitMQ
consumer that keeps the Redis read model in order.

`services/` overlays have no overrides (except prod postgres), but the
**folder must exist**. Its existence is what deploys the component to that
environment (Step 3):

```yaml
# redis — dev overrides on top of ../../base/values.yaml.
# None: base defaults are fine here. The folder must exist — it's what
# makes the dev ApplicationSet deploy redis to dev.
```

Checkpoint: render every component in both envs exactly as Argo CD will:

```bash
for env in dev prod; do
  for o in apps/*/overlays/$env services/*/overlays/$env; do
    b=$(dirname $(dirname $o))/base; c=$(basename $(dirname $(dirname $o)))
    helm dependency build $b >/dev/null
    helm template $c $b -n parcelpigeon-$env -f $b/values.yaml -f $o/values.yaml
  done > /tmp/$env.yaml
  echo "$env: $(grep -c '^kind:' /tmp/$env.yaml) objects"     # 27 each
done
grep -h 'host:' /tmp/{dev,prod}.yaml
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
          - path: services/*/overlays/dev
  template:
    metadata:
      name: "{{ index .path.segments 1 }}-dev"
      labels:
        env: dev
        tier: "{{ index .path.segments 0 }}"
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: default
      source:
        repoURL: https://github.com/Chnu-devops/parcel-pigeon-gitops.git
        targetRevision: main
        path: "{{ index .path.segments 0 }}/{{ index .path.segments 1 }}/base"
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

- The generator matches **overlay folders** in both trees:
  `services/postgres/overlays/dev` → `.path.segments` =
  `[services, postgres, overlays, dev]`. Segment 0 is the folder (which also
  becomes the `tier` label), segment 1 is the component.
- `source.path` is the chart (`base`), and `valueFiles` reaches *out* of it
  with `../overlays/dev/values.yaml`. Argo CD allows value files anywhere
  inside the same repo.
- `parcelpigeon-prod.yaml` is the same file with `dev` replaced. They're
  deliberately two plain files rather than one clever matrix generator: prod
  can drift (e.g. no `selfHeal`, or a different `destination.server`)
  without touching dev.
- Want a different policy for datastores (e.g. no auto-prune)? Split the
  generator into a second ApplicationSet for `services/*` only.

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

`.github/workflows/promote.yml` in the config repo copies image tags from
`apps/*/overlays/dev` to `apps/*/overlays/prod` and opens a PR. **Reviewing
and merging the PR is the deploy to prod.**

- It runs on every push to `main` that touches `apps/*/overlays/dev/values.yaml`
  (i.e. every CI bump), and on demand via *Actions → Promote → Run workflow*.
- It keeps a single rolling PR, *Promote dev → prod*, on branch
  `promote/prod`. Each new dev bump updates it with the list of services and
  SHAs that differ. If prod already matches dev, there's no PR.
- `services/` are never promoted automatically: datastore versions change
  by a normal PR to each overlay or base.

The core of it:

```bash
for dev_values in apps/*/overlays/dev/values.yaml; do
  app=$(echo "$dev_values" | cut -d/ -f2)
  prod_values="apps/${app}/overlays/prod/values.yaml"
  [ -f "$prod_values" ] || continue               # not deployed to prod (yet)
  tag=$(yq '.image.tag // ""' "$dev_values")
  [ -n "$tag" ] || continue
  [ "$(yq '.image.tag // ""' "$prod_values")" = "$tag" ] && continue
  TAG="$tag" yq -i '.image.tag = strenv(TAG)' "$prod_values"
done
```

followed by `peter-evans/create-pull-request`, which commits the diff to
`promote/prod` and opens/updates the PR.

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
- A `CODEOWNERS` line such as `*/*/overlays/prod/ @Chnu-devops/release-managers`
  plus *Require review from Code Owners*: only that team can approve prod.

## Step 5 — App repo: CI writes to the dev overlay

On the app repo's `add-environments` branch, one path changes in
`bump-image-tags`:

```diff
-              values="gitops/helm/charts/${svc}/values.yaml"
+              values="gitops/apps/${svc}/overlays/dev/values.yaml"
```

and the commit message says which env it deployed:
`deploy(dev): gateway,web a1b2c3d`. CI never touches prod.

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
kubectl -n argocd get applications -L env,tier  # 2 roots + 16 apps, Synced / Healthy
kubectl get ns | grep parcelpigeon              # -dev, -prod
kubectl -n parcelpigeon-prod get deploy         # gateway + web at 2/2

# hosts: both point at the ingress
echo "$(minikube ip) dev.parcelpigeon.local parcelpigeon.local" | sudo tee -a /etc/hosts
curl -s http://dev.parcelpigeon.local/healthz

# demo data, per environment
for env in dev prod; do
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
2. **Config repo**: `promote.yml` opens/updates *Promote dev → prod* listing
   `` `web` → `<sha7>` ``. Check it on `dev.parcelpigeon.local`, then review
   and merge → **`web-prod`** syncs, both replicas roll.

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

# upgrade a datastore in dev first, then in prod
yq -i '.image.tag = "7.4-alpine"' services/redis/overlays/dev/values.yaml

# try a new service in dev only: give it only an overlays/dev folder
mkdir -p apps/eta-service/overlays/dev     # + apps/eta-service/base chart
# → eta-service-dev appears; prod gets it when overlays/prod is added
```

## Later (not in this branch)

`AppProject` per environment (prod apps may only deploy to
`parcelpigeon-prod`, plus Argo CD RBAC on who can sync prod); a real second
cluster for prod (`argocd cluster add`); a validation workflow in the config
repo that `helm template`s every component × env on each PR; per-env secrets
(prod must not share the dev passwords in `base/values.yaml`) via Sealed
Secrets / External Secrets; Argo CD sync windows for prod — see
`docs/lecture-map.md`.
