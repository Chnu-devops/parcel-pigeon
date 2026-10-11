# Progressive delivery with Argo Rollouts — step by step

> Builds on `docs/environments-migration.md` (dev / prod overlays, promotion
> by PR). Lecture: `slides/tema 7 - progressive delivery.md`.

Up to now, a new image tag reaches **all** pods as soon as Argo CD syncs it. A
`Deployment`'s rolling update only waits for readiness, and nothing stops it
when the new version misbehaves. This guide puts the two user-facing services
behind Argo Rollouts:

- **gateway** becomes a **canary**. Half the pods get the new version, an
  analysis asks the new pods' `/readyz`, and then the rest follow. In prod a
  person also has to `promote`.
- **web** becomes **blue-green**. The new version starts next to the old one
  on a preview Service, then the `web` Service switches to it in one step. Dev
  switches on its own. Prod waits for `promote`.
- The **controller** is installed by Argo CD from a new `clusters/platform/`
  folder, so it is GitOps like everything else.
- `samples/rollouts/` has standalone examples of everything ParcelPigeon
  doesn't use: nginx traffic routing, pre- and post-promotion analysis, the
  Job and Prometheus providers, background analysis and `workloadRef`.

Answer key: the config repo's `add-rollouts` branch (`git diff main` there).
The app repo only gains this doc. CI and `promote.yml` don't change, because
a release is still "a new image tag in an overlay".

## The target layout

```
clusters/
├── platform/                       # NEW: cluster-wide controllers
│   ├── root.yaml                   #   applied by hand once, before dev/prod
│   └── apps/argo-rollouts.yaml     #   Argo Rollouts Helm chart
├── dev/  prod/                     # unchanged
apps/
├── gateway/base/templates/
│   ├── rollout.yaml                # was deployment.yaml: + strategy.canary
│   ├── service-canary.yaml         # NEW: gateway-canary, new pods only
│   ├── analysistemplate.yaml       # NEW: gateway-readyz (web provider)
│   └── service.yaml  configmap.yaml  secret.yaml
├── gateway/base/values.yaml        # + rollout.steps (dev default)
├── gateway/overlays/prod/values.yaml   # + rollout.steps with pause: {}
├── web/base/templates/
│   ├── rollout.yaml                # was deployment.yaml: + strategy.blueGreen
│   ├── service-preview.yaml        # NEW: web-preview
│   └── service.yaml  ingress.yaml  # unchanged — `web` is the active Service
├── web/base/values.yaml            # + rollout.autoPromotionEnabled: true
└── web/overlays/prod/values.yaml   # + rollout.autoPromotionEnabled: false
samples/rollouts/                   # NEW: examples, applied by hand, never synced
```

## What changes, what stays

| | Before | After |
|---|---|---|
| gateway, web workload | `Deployment` | `Rollout` (`argoproj.io/v1alpha1`) — same pod template |
| new tag in dev | rolling update, 100% in seconds | gateway: 50% → analysis → 100%; web: preview → switch |
| new tag in prod | rolling update after the promotion PR | gateway: 50% → **wait for promote** → analysis → 100%; web: preview → **wait for promote** → switch |
| bad gateway release | all pods replaced, then you notice | canary aborted, stable keeps serving, app *Degraded* |
| Argo CD | 18 apps | + `cluster-platform`, `argo-rollouts` |
| other 6 components, CI, `promote.yml` | — | unchanged |

## Prerequisites

- The environments setup from `docs/running-gitops.md`, with all apps
  *Synced* and *Healthy*.
- The kubectl plugin:

  ```bash
  brew install argoproj/tap/kubectl-argo-rollouts
  kubectl argo rollouts version
  ```

- `helm` locally, to render the charts before pushing.

## Step 1 — The controller, through Argo CD

Argo Rollouts is a controller plus CRDs (`Rollout`, `AnalysisTemplate`,
`AnalysisRun`, …). There is one controller per **cluster**, serving every
namespace. It belongs to neither dev nor prod, so it gets its own root
alongside theirs.

`clusters/platform/apps/argo-rollouts.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: argo-rollouts
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://argoproj.github.io/argo-helm
    chart: argo-rollouts
    targetRevision: 2.43.6 # app v1.10.0 — bump by PR, like any other version
    helm:
      valuesObject:
        dashboard:
          enabled: true
  destination:
    server: https://kubernetes.default.svc
    namespace: argo-rollouts
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

- `source.chart` instead of `source.path` tells Argo CD to pull a chart from a
  Helm repository rather than from Git. The version is pinned. Find the latest
  with `helm repo add argo https://argoproj.github.io/argo-helm && helm search repo argo/argo-rollouts`.
- `ServerSideApply=true` is needed because the `Rollout` CRD is larger than
  the `last-applied-configuration` annotation that client-side apply writes.

`clusters/platform/root.yaml` has the same shape as `clusters/dev/root.yaml`:
`name: cluster-platform`, `path: clusters/platform/apps`, and no finalizer.

On real infrastructure every cluster needs its own controller, so each
cluster's root would include `argo-rollouts.yaml`. Here dev and prod share a
minikube, so there is one.

## Step 2 — gateway: `Deployment` → canary `Rollout`

```bash
git mv apps/gateway/base/templates/deployment.yaml apps/gateway/base/templates/rollout.yaml
```

The whole diff to that file:

```diff
-apiVersion: apps/v1
-kind: Deployment
+apiVersion: argoproj.io/v1alpha1
+kind: Rollout
 metadata:
   name: gateway
 ...
 spec:
   replicas: {{ .Values.replicas }}
+  progressDeadlineSeconds: 120
+  progressDeadlineAbort: true
   selector:
 ...
           resources:
             {{- toYaml .Values.resources | nindent 12 }}
+  strategy:
+    canary:
+      canaryService: gateway-canary
+      steps:
+        {{- toYaml .Values.rollout.steps | nindent 8 }}
```

`selector`, `template`, probes and the `checksum/config` annotations stay
exactly as they were. **A Rollout is a Deployment plus a `strategy`.**

**No traffic router here.** The `gateway` Service selects `app: gateway` and
web's nginx proxies `/api` to it, so it keeps selecting **both** versions.
The canary's share of real traffic is therefore its share of pods: with 2
replicas in prod, `setWeight: 50` means one old pod and one new pod. This is
the simplest canary there is. `samples/rollouts/02-canary-nginx.yaml` shows
the precise, weight-based version with an Ingress.

`progressDeadlineAbort` covers the release that never gets going. If the new
pods never pass readiness (`/readyz`) within 2 minutes, the Rollout aborts
instead of waiting forever.

## Step 3 — The canary Service and the analysis

`apps/gateway/base/templates/service-canary.yaml` is a copy of `service.yaml`
named `gateway-canary`. You don't add a selector for the new version. During a
release, Argo Rollouts adds `rollouts-pod-template-hash: <new>` to this
Service's selector, so `gateway-canary` reaches **only the canary pods**.

`apps/gateway/base/templates/analysistemplate.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: gateway-readyz
spec:
  metrics:
    - name: readyz
      interval: 10s
      count: 6
      failureLimit: 0
      consecutiveErrorLimit: 1
      successCondition: result == true
      provider:
        web:
          url: http://gateway-canary.{{ .Release.Namespace }}.svc:{{ .Values.port }}/readyz
          jsonPath: "{$.ready}"
          timeoutSeconds: 5
```

Read it as a sentence: every 10 seconds, six times, ask the **canary** pods'
`/readyz`, which returns `{"ready": true, "checks": {...}}` when the gateway
can reach shipments-service and tracking-service. Argo Rollouts treats a 503
as a measurement **error**, not a **failure**, so `consecutiveErrorLimit: 1`
is what fails the run: two bad answers in a row abort the release.

Why the web provider and not the slides' Prometheus query: there is no
Prometheus in the cluster yet. The query, written against the gateway's real
`http_requests_total{status}`, is in `samples/rollouts/04-analysis-templates.yaml`,
ready for when monitoring lands.

The readiness probe also uses `/readyz`, so a canary that can't reach its
upstreams never becomes Ready, and `progressDeadlineAbort` handles that case.
The analysis covers the other case: the pods became Ready, then something
broke during the release.

## Step 4 — Different steps per environment

The steps live in values, so the overlays can choose them. In
`apps/gateway/base/values.yaml`, the default is dev, which runs without a
human:

```yaml
rollout:
  steps:
    - setWeight: 50
    - analysis:
        templates:
          - templateName: gateway-readyz
```

In `apps/gateway/overlays/prod/values.yaml`, a person looks before the
analysis runs:

```yaml
rollout:
  steps:
    - setWeight: 50
    - pause: {}          # until `kubectl argo rollouts promote`
    - analysis:
        templates:
          - templateName: gateway-readyz
```

Helm merges maps key by key but **replaces lists**, so prod has to repeat the
whole list. After the last step the Rollout goes to 100% by itself.

Render both environments before pushing:

```bash
cd ~/Developer/parcel-pigeon-gitops
helm dependency build apps/gateway/base
for env in dev prod; do
  helm template gateway apps/gateway/base -n parcelpigeon-$env \
    -f apps/gateway/base/values.yaml -f apps/gateway/overlays/$env/values.yaml > /tmp/gw-$env.yaml
  kubectl argo rollouts lint -f /tmp/gw-$env.yaml && echo "$env ok"
done
```

`kubectl argo rollouts lint` runs the controller's own validation offline. For
example, it rejects a blue-green whose active and preview Service are the same.

## Step 5 — web: blue-green

```bash
git mv apps/web/base/templates/deployment.yaml apps/web/base/templates/rollout.yaml
```

Make the same `apiVersion`/`kind` change, then add:

```yaml
  strategy:
    blueGreen:
      activeService: web
      previewService: web-preview
      autoPromotionEnabled: {{ .Values.rollout.autoPromotionEnabled }}
      scaleDownDelaySeconds: 30
```

- `activeService: web` is the existing Service the Ingress already points at,
  so neither the Ingress nor `/etc/hosts` changes.
- `apps/web/base/templates/service-preview.yaml` is a copy of `service.yaml`
  named `web-preview`. Argo Rollouts points it at the new ReplicaSet.
- Promotion changes `web`'s selector to the new pods in one step. The old pods
  stay 30 s (`scaleDownDelaySeconds`), so an abort right after the switch is
  instant.
- `rollout.autoPromotionEnabled: true` goes in `web/base/values.yaml`, and
  `false` in `web/overlays/prod/values.yaml`.

Why blue-green for web: it serves the static SPA bundle. Mixing old and new
`index.html` and JS chunks between requests is what breaks a SPA during a
rolling update, and blue-green never mixes them.

## Step 6 — Cut over

Order matters. The Rollout CRD has to exist **before** Argo CD syncs the new
gateway and web charts. If it doesn't, the whole sync is rejected (*one or more
synchronization tasks are not valid: Rollout.argoproj.io "" not found*), and
nothing from it is applied. In the UI that looks like *Resource not found in
cluster: v1/Service:web-preview*. The old Deployments keep serving, and Argo
CD retries with backoff, so the apps fix themselves once the CRDs exist.

```bash
# 1. merge add-rollouts into main in the config repo, then right away:
kubectl apply -f clusters/platform/root.yaml
kubectl -n argocd get application cluster-platform argo-rollouts -w   # until Synced / Healthy
kubectl get crd rollouts.argoproj.io
kubectl -n argo-rollouts get pods

# 2. gateway-* / web-* pick it up on their next retry; to skip the wait:
argocd app sync gateway-dev gateway-prod web-dev web-prod
#   (or Argo CD UI → app → Sync)
```

Starting from scratch, apply `clusters/platform/root.yaml` before the dev
and prod roots (`docs/running-gitops.md`, Step 5). You can also do it in two
PRs: the `clusters/platform/` PR first, then the `apps/` PR.

What happens on that sync, per app: Argo CD creates the `Rollout` and then
prunes the `Deployment`. Both select `app: gateway`, so the Service always has
endpoints. A Rollout's **first** revision skips the steps, because there is no
stable version to compare against. So no canary yet, just a normal start.

Check:

```bash
kubectl -n argocd get applications -L env,tier          # 20 apps, Synced / Healthy
kubectl argo rollouts list rollouts -n parcelpigeon-prod # gateway + web, Healthy
kubectl -n parcelpigeon-prod get deploy                  # gateway and web gone
kubectl -n parcelpigeon-prod get svc                     # + gateway-canary, web-preview
curl -s http://parcelpigeon.local/healthz
```

In Argo CD the gateway app's resource tree now has `Rollout` → `ReplicaSet` →
pods. During a release, the `AnalysisRun` appears too.

## Step 7 — Walk one release

Push any gateway change in the app repo:

```bash
echo "// touch" >> services/gateway/src/app.ts && git commit -am "gateway: touch" && git push
```

**Dev (automatic).** CI bumps `apps/gateway/overlays/dev`. Then:

```bash
kubectl argo rollouts get rollout gateway -n parcelpigeon-dev --watch
```

You should see this, in order:

1. `Step 1/2 · SetWeight 50`: a canary pod starts next to the stable one.
2. `Step 2/2 · Analysis`: an `AnalysisRun` with six ✔ about 60 s later.
3. `Healthy`: the old ReplicaSet scales down.

**Prod (by hand).** Merge the *Promote dev → prod* PR, then:

```bash
kubectl argo rollouts get rollout gateway -n parcelpigeon-prod --watch
```

The release stops at `Step 2/3 · Pause` with one old pod and one new one,
each taking about half of the requests. Argo CD shows the app as
**Synced / Suspended**. Git and the cluster match, and the release is waiting.
Look at the logs, try the site, then:

```bash
kubectl argo rollouts promote gateway -n parcelpigeon-prod
```

The analysis runs, then 100%.

**web in prod.** The same PR also brings a new web tag:

```bash
kubectl argo rollouts get rollout web -n parcelpigeon-prod --watch   # Paused, BlueGreenPause
kubectl -n parcelpigeon-prod port-forward svc/web-preview 8081:8080  # new version on :8081
open http://localhost:8081   # its nginx proxies /api to the gateway Service, so the app works
kubectl argo rollouts promote web -n parcelpigeon-prod               # switch parcelpigeon.local
```

Or open the dashboard with `kubectl argo rollouts dashboard`
(http://localhost:3100). It has the same buttons.

## Step 8 — A bad release, and getting rid of it

Make a gateway change in dev that breaks the new pods but not the old ones:

```bash
cd ~/Developer/parcel-pigeon-gitops
yq -i '.config.TRACKING_URL = "http://tracking-service-typo:8002"' apps/gateway/overlays/dev/values.yaml
git commit -am "gateway(dev): broken tracking url" && git push
```

1. The ConfigMap changes, so the `checksum/config` annotation changes, so the
   pod template changes: a new canary revision.
2. The canary pod's `/readyz` returns 503, so it never becomes Ready.
3. After 120 s (`progressDeadlineSeconds`), the Rollout **aborts**. The canary
   scales to 0, the stable pod keeps serving, and Argo CD shows
   **Synced / Degraded**.

Abort is **not a rollback in Git.** Git still says "broken URL", so the
Rollout stays Degraded and `selfHeal` has nothing to fix. The GitOps rollback
is a revert:

```bash
git revert HEAD && git push    # the pod template matches stable again → Healthy
```

Try it in prod too: promote a canary, then
`kubectl argo rollouts abort gateway -n parcelpigeon-prod` instead of
promoting. Then revert the promotion commit by PR.

The stable pods kept the old `TRACKING_URL` only because env from a ConfigMap
is read when a pod starts, and `gateway-config` is shared by both versions. A
stable pod restarting during that window would pick up the broken value.
Config that has to change *with* a release belongs in a per-version ConfigMap,
for example one named with a hash suffix.

To see the **analysis** fail (rather than readiness), use the samples:
`04-analysis-templates.yaml` with the `argoproj/rollouts-demo:bad-red` image.

## Pitfalls

| Symptom | Cause |
|---|---|
| `kubectl argo rollouts set image gateway …` is undone within seconds | Argo CD selfHeal. Git owns the tag. Releases are commits; `set image` is for `samples/` only |
| gateway prod sits *Suspended* for hours | `pause: {}` waits for a person. Use `pause: {duration: 10m}` if nobody is on call |
| Canary gets more or less traffic than `setWeight` | No traffic router: share = pods. 50% of 2 replicas is exact, 10% of 2 is not (it rounds up to 1 pod = 50%) |
| `web-prod` uses twice the pods during a release | Blue-green runs both versions at full size until the switch, plus `scaleDownDelaySeconds` (`previewReplicaCount` reduces this) |
| After the merge, `gateway-*` / `web-*` are OutOfSync with *Rollout.argoproj.io "" not found* or *Resource not found in cluster: v1/Service:web-preview* | Controller/CRDs not installed yet: `kubectl apply -f clusters/platform/root.yaml` (Step 6); the apps recover on their next retry |
| After an abort, the app is still Degraded | Expected until Git changes: revert, or fix forward |

## Samples

`samples/rollouts/README.md` in the config repo has the lecture's practice
part: basic canary, nginx traffic routing, blue-green with pre- and
post-promotion analysis, analysis providers (web / Job / Prometheus) with
background analysis, and `workloadRef`. Each runs in a scratch
`rollouts-lab` namespace using `argoproj/rollouts-demo`.

## Later (not in this branch)

Prometheus success-rate analysis on gateway, once the metrics platform exists
(the template is in `samples/rollouts/04-analysis-templates.yaml`). An nginx
traffic router for gateway, to get precise percentages: that needs gateway
behind its own Ingress, or web's nginx proxying to a stable and canary pair.
Rollouts notifications to Slack. Argo CD `ignoreDifferences` is not needed:
Argo Rollouts' selector edits on the Services aren't in Git's manifests, so
Argo CD doesn't report them as drift. See `docs/lecture-map.md`.
