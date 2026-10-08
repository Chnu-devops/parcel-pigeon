# Migrating from `helm upgrade` to GitOps with Argo CD — step by step

> On the `add-split-charts` branch the single chart is split into one chart
> and one Argo CD Application per service — see `docs/split-charts-migration.md`.

This is the live-coding guide for handing the Helm chart from the `add-helm`
branch (see `docs/helm-migration.md`) over to Argo CD. `git diff add-helm` on
the `add-gitops` branch is the reference / answer key.

Before: a human runs `helm upgrade --install` from a laptop, and whatever is
in the cluster is whatever was last run. After: **Git is the source of
truth**. Argo CD, running inside the cluster, continuously renders
`helm/parcelpigeon` from the `main` branch and makes the cluster match it.
Nobody runs `helm` or `kubectl apply` against the `parcelpigeon` namespace
any more.

The chart itself barely changes — the rendered resources are the same 27
objects as on `add-helm`; PVCs get one extra annotation.

## What changes, what stays

| Helm by hand (`add-helm`) | GitOps (`add-gitops`) |
|---|---|
| `helm upgrade --install … --set gateway.image.tag=…` | commit to `values.yaml` → Argo CD syncs |
| image tag `latest`, new build needs a manual rollout | CI writes the commit SHA into `values.yaml` → Argo CD rolls it out |
| `helm rollback parcelpigeon 3` | `git revert <commit>` |
| `helm history` | `git log helm/parcelpigeon` + Argo CD history |
| `kubectl edit` by hand silently sticks | drift is shown as *OutOfSync* and reverted (self-heal) |
| release state in `sh.helm.release.v1.*` Secrets | state in the `Application` object in the `argocd` namespace |
| `helm install --create-namespace` | `syncOptions: [CreateNamespace=true]` |
| `helm.sh/resource-policy: keep` on PVCs | same + `argocd.argoproj.io/sync-options: Delete=false` |

New files:

```
argocd/
├── root-app.yaml          # app of apps — the only thing applied by hand
└── apps/
    └── parcelpigeon.yaml  # the chart as an Argo CD Application
```

## Prerequisites

```bash
kubectl version --client
minikube start
minikube addons enable ingress
brew install argocd          # optional CLI; everything below also works from the UI
```

Argo CD pulls from GitHub, not from your laptop — the manifests and the chart
must be **on `main` on GitHub** before Argo CD can see them (both
Applications track `targetRevision: main`):

```bash
git push -u origin add-helm add-gitops
# open PRs and merge add-helm, then add-gitops, into main
```

The images must be pullable by minikube: the CI pushes them to
`ghcr.io/chnu-devops/*`; make each GHCR package **public**
(GitHub → Packages → *package* → Package settings → Change visibility),
or add an `imagePullSecret`.

## Step 1 — Install Argo CD

Argo CD is just another set of Deployments in its own namespace:

```bash
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deploy/argocd-server
```

`--server-side` is required: the `ApplicationSet` CRD is too big for the
`last-applied-configuration` annotation a client-side apply writes.

Open the UI and log in as `admin`:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n argocd port-forward svc/argocd-server 8081:443
# https://localhost:8081  (self-signed cert — accept the warning)

argocd login localhost:8081 --username admin --insecure   # CLI, optional
```

What got installed, worth a quick `kubectl -n argocd get pods`:

- `argocd-repo-server` — clones Git and runs `helm template`
- `argocd-application-controller` — compares rendered vs. live, applies the diff
- `argocd-server` — UI + API

## Step 2 — Repo access

The repo is public → nothing to do; Argo CD clones over anonymous HTTPS.

If it's private, give Argo CD a read-only token (fine-grained PAT with
*Contents: read*):

```bash
argocd repo add https://github.com/Chnu-devops/parcel-pigeon.git \
  --username <your-github-user> --password <token>
```

## Step 3 — The chart as an Application

Create `argocd/apps/parcelpigeon.yaml`. An `Application` is a CRD that says
*"render this source, apply it to that destination"*:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: parcelpigeon
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/Chnu-devops/parcel-pigeon.git
    targetRevision: main
    path: helm/parcelpigeon
    helm:
      releaseName: parcelpigeon
      valueFiles:
        - values.yaml
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

Field by field:

- **`source`** — *what* to deploy: repo + branch + folder. Argo CD detects
  `Chart.yaml` in `path` and renders it with `helm template`.
- **`helm.releaseName: parcelpigeon`** — without it the release name is the
  Application name. Pinning it keeps `app.kubernetes.io/instance` and the
  rendered output identical to the old `helm install parcelpigeon`, which is
  what lets Argo CD adopt the running objects in Step 6 without restarts.
- **`helm.valueFiles`** — the same as `-f values.yaml`. Everything you used
  to pass with `--set` must now live in a file in Git.
- **`destination`** — *where*: `kubernetes.default.svc` is "the cluster Argo CD
  runs in"; the namespace replaces `-n parcelpigeon`.
- **`automated`** — sync on every new commit instead of waiting for a click.
  `prune` deletes objects that disappeared from the chart; `selfHeal`
  reverts manual changes made in the cluster.
- **`finalizers`** — deleting the Application deletes what it deployed
  (cascade). Without it, deleting the Application would just orphan the
  workloads.

Note: Argo CD does **not** run `helm install` — there is no Helm release, and
`helm list` will show nothing. Helm is only used as a templating engine.

## Step 4 — App of apps

We could `kubectl apply` the Application above and be done, but then the
Application itself isn't managed from Git. Instead, one **root** Application
syncs the `argocd/apps/` folder — whose contents are Applications.

`argocd/root-app.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/Chnu-devops/parcel-pigeon.git
    targetRevision: main
    path: argocd/apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

This is the only file ever applied by hand (the *bootstrap*). From then on,
adding a new service to the platform = adding a file to `argocd/apps/` in a
PR. That's the hook the Backstage scaffolder lecture builds on.

## Step 5 — Protect the volumes

`helm.sh/resource-policy: keep` is honoured by the `helm` CLI on
`helm uninstall`. With Argo CD the equivalent is a sync option on the
object. Add one annotation to each of the three PVC templates
(`templates/{postgres,redis,rabbitmq}/pvc.yaml`):

```yaml
  annotations:
    # Keep the data volume on `helm uninstall`.
    helm.sh/resource-policy: keep
    # Same for Argo CD: keep the volume when the Application is deleted.
    argocd.argoproj.io/sync-options: Delete=false
```

Checkpoint — the chart still renders the same 27 objects:

```bash
helm lint helm/parcelpigeon
helm template parcelpigeon helm/parcelpigeon -n parcelpigeon | grep -c '^kind:'   # 27
```

## Step 6 — Cut over the cluster

Pick one.

**A. Clean slate (simplest, loses data).**

```bash
helm uninstall parcelpigeon -n parcelpigeon 2>/dev/null
kubectl delete namespace parcelpigeon --ignore-not-found   # incl. PVCs
kubectl apply -f argocd/root-app.yaml
```

**B. Adopt the running Helm release (keeps PVC data).**

Argo CD has no ownership check like Helm's — it simply applies the rendered
manifests over whatever exists. Because the release name and values are the
same, the rendered objects are identical to what Helm installed, so adoption
is a no-op apply; pods don't restart.

```bash
kubectl apply -f argocd/root-app.yaml
argocd app get parcelpigeon        # or watch the UI
argocd app diff parcelpigeon       # empty / annotations only
```

Argo CD marks each object it manages with an
`argocd.argoproj.io/tracking-id` annotation; that's the only change.

Then retire Helm's bookkeeping, so nobody can `helm upgrade` or
`helm rollback` over an Argo-managed app (Argo CD would revert it anyway):

```bash
kubectl -n parcelpigeon delete secret -l owner=helm,name=parcelpigeon
helm list -n parcelpigeon          # empty — the release is gone, the workloads are not
```

Do **not** run `helm uninstall` for this — it would delete the workloads.

Either way, check:

```bash
kubectl -n argocd get applications          # root + parcelpigeon: Synced / Healthy
kubectl -n parcelpigeon get pods,svc,ingress
kubectl -n parcelpigeon port-forward svc/web 8080:8080
curl http://localhost:8080/healthz
```

## Step 7 — CI closes the loop: bump the image tag in Git

With `tag: latest` Argo CD never sees a change — the manifest is identical
after every build. The fix: CI writes the exact image it just pushed into
Git. New job at the end of `.github/workflows/ci.yml`:

```yaml
  bump-image-tags:
      name: gitops / bump image tags
      needs: [build-and-publish]
      if: github.event_name == 'push' && github.ref == 'refs/heads/main'
      runs-on: ubuntu-latest
      permissions:
        contents: write
      env:
        SHA: ${{ github.sha }}
        VALUES: helm/parcelpigeon/values.yaml
      steps:
        - uses: actions/checkout@v4
        - name: Set image tags to this commit
          run: |
            yq -i '
              .gateway.image.tag = strenv(SHA) |
              .web.image.tag = strenv(SHA) |
              .shipmentsService.image.tag = strenv(SHA) |
              .trackingService.image.tag = strenv(SHA)
            ' "$VALUES"
        - name: Commit and push
          run: |
            git diff --quiet && exit 0
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git commit -am "deploy: bump image tags to ${SHA::7} [skip ci]"
            git pull --rebase origin main
            git push origin HEAD:main
```

The full flow on a push to `main`:

```
push → lint/test → build + push ghcr.io/…/<svc>:<sha>
     → bump-image-tags commits values.yaml (tag: <sha>)
     → Argo CD sees the new commit → helm template → rolling update
```

Notes:

- `build-and-publish` already pushes `:<sha>` tags; this job only points the
  chart at them. `yq` is preinstalled on GitHub's Ubuntu runners.
- Pushes made with `GITHUB_TOKEN` never trigger another workflow run, so the
  bot commit can't loop; `[skip ci]` is belt-and-braces.
- Repo settings: Settings → Actions → General → *Workflow permissions* must
  allow the job's `contents: write`. If `main` is branch-protected, allow
  `github-actions[bot]` to bypass, or the push is rejected.
- CI is the only writer of the tags — don't hand-edit them in PRs, you'll get
  rebase conflicts with the bot.

## Step 8 — Day-2 operations (what GitOps buys us)

```bash
# a change is a commit
yq -i '.gateway.replicas = 2' helm/parcelpigeon/values.yaml
git commit -am "scale gateway to 2" && git push
argocd app get parcelpigeon --refresh   # Argo polls every ~3 min; this skips the wait

# drift is reverted
kubectl -n parcelpigeon scale deploy/gateway --replicas=0
kubectl -n parcelpigeon get deploy gateway -w   # back to 2 within seconds

# config change → checksum changes → pods roll (same as with helm upgrade)
yq -i '.gateway.config.LOG_LEVEL = "debug"' helm/parcelpigeon/values.yaml
git commit -am "gateway debug logs" && git push

# rollback = revert the commit
git revert HEAD && git push

argocd app history parcelpigeon
argocd app diff parcelpigeon
```

Teaching moment for self-heal: try `kubectl edit cm gateway-config` — it's
reverted. The only way to change the cluster now is a PR.

## Step 9 — Tear down

```bash
kubectl -n argocd delete application root   # cascades: root → parcelpigeon → workloads
kubectl delete namespace parcelpigeon       # PVCs survived (Delete=false); this drops them
kubectl delete namespace argocd             # Argo CD itself
```

## Later (not in this branch)

An `AppProject` restricting repos/namespaces instead of `default`;
per-environment values (`values-dev.yaml` / `values-prod.yaml`) with an
`ApplicationSet`; Argo CD Image Updater instead of the CI commit; Argo
Rollouts canaries; one chart + Application per service
(`docs/split-charts-migration.md`); Sealed Secrets / External Secrets so the secrets in
`values.yaml` leave Git — see `docs/lecture-map.md`.
