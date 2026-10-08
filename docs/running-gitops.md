# ParcelPigeon GitOps — how to run it

After about an hour you have ParcelPigeon running in two environments, dev
and prod, on one minikube cluster, deployed only from Git by Argo CD. This is
the fresh-setup runbook; the migration guides next to it in `docs/` explain
how each piece was built (`gitops-migration.md` → `split-charts-migration.md`
→ `config-repo-migration.md` → `environments-migration.md`).

## Overview

What you end up with:

- **Two GitHub repos** in the Chnu-devops org: `parcel-pigeon` (code,
  Dockerfiles, CI) and `parcel-pigeon-gitops` (Helm charts, per-environment
  values, Argo CD manifests).
- **Argo CD** in the `argocd` namespace, watching `main` of the config repo only.
- **Two namespaces**, `parcelpigeon-dev` and `parcelpigeon-prod`, each running
  8 components: gateway, web, shipments-service, tracking-service, postgres,
  redis, rabbitmq and mailhog.
- **One path to production**: a code push deploys to dev automatically; prod
  changes only when someone merges the *Promote dev → prod* PR in the config repo.

```
 Developer ──push──▶ App repo CI ──push image──▶ GHCR (ghcr.io/chnu-devops/*:<sha>)
                     test, build                         │
                         │ commits dev tag               │ images pulled by both
                         ▼                               │ namespaces
                 Config repo, main ──opens PR──▶ "Promote dev → prod"
                 dev tag by CI      ◀──review + merge──  (promote.yml)
                 prod tag by PR
                         │ watches main
                         ▼
                      Argo CD  (16 apps from 2 ApplicationSets)
                     ┌───┴────────────────┐
                     ▼                    ▼
             parcelpigeon-dev      parcelpigeon-prod
          updates on every push   updates after a PR merge
```

CI only ever writes the dev tag; the prod tag changes only through the merged
promotion PR.

## Prerequisites

You need a few command-line tools, admin rights on both repos in the
Chnu-devops org, and about 6 GB of free memory for minikube.

| Tool | Used for | Check |
| --- | --- | --- |
| minikube | the local cluster | `minikube version` |
| kubectl | talking to the cluster | `kubectl version --client` |
| git | pushing repos | `git --version` |
| argocd CLI (optional) | logging in, refresh, history | `brew install argocd` |
| helm (optional) | rendering charts locally before a push | `helm version` |

On GitHub you need:

- **Admin** on `Chnu-devops/parcel-pigeon` and `Chnu-devops/parcel-pigeon-gitops`,
  to add secrets and change Actions settings.
- **Org owner**, or an owner's help, to create the org's GitHub App and org
  secrets, and if the org restricts public packages or Actions-created pull
  requests (Step 2).

Locally you need the two repos with these branches:

- App repo (`devops-2026-new`): branch `add-environments`, which contains the
  whole chain `add-helm` → `add-gitops` → `add-split-charts` →
  `add-config-repo` → `add-environments`.
- Config repo (`parcel-pigeon-gitops`): branch `environments` on top of `main`.

If you use colima as the Docker runtime, its VM must be larger than the
minikube cluster inside it: `colima start --cpu 4 --memory 8`.

## Step 1 — Put both repos on GitHub

Push the config repo's `main` first and only open, not merge, the app repo
PR: merging it triggers CI, which needs the Step 2 settings to succeed.

1. On GitHub, create **Chnu-devops → New repository → `parcel-pigeon-gitops`**,
   empty (no README, no license). Public is simplest; for a private repo see
   Step 4.5.
2. Bring the environments layout onto the config repo's `main` and push it:

   ```bash
   cd ~/Developer/parcel-pigeon-gitops
   git switch main
   git merge --ff-only environments
   git remote add origin git@github.com:Chnu-devops/parcel-pigeon-gitops.git
   git push -u origin main
   ```

3. Point the app repo at its new home in the org, and push the lecture branches:

   ```bash
   cd ~/Developer/devops-2026-new
   git remote set-url origin git@github.com:Chnu-devops/parcel-pigeon.git
   git push -u origin add-helm add-gitops add-split-charts add-config-repo add-environments
   ```

4. Open a PR **`add-environments` → `main`** on `Chnu-devops/parcel-pigeon`.
   It carries the whole chain (Helm, GitOps, split charts, config repo,
   environments). Leave it open until Step 2 is done.

Check: the config repo on GitHub shows `apps/`, `services/`, `lib/`,
`clusters/` and `.github/workflows/promote.yml`.

## Step 2 — GitHub settings and the first CI run

CI needs a GitHub App to write to the config repo, the config repo must be
allowed to open PRs, and the images CI pushes must be public so minikube can
pull them.

1. **A GitHub App for CI.** `GITHUB_TOKEN` can only write to the repo its
   workflow runs in, and the Chnu-devops org disables deploy keys by policy.
   An org-owned GitHub App is the replacement: installed on the config repo
   only, with only *Contents: write*, and CI mints a token from it that
   expires after an hour.

   1. **Chnu-devops → Settings → Developer settings → GitHub Apps → New GitHub App**:
      - Name: `parcel-pigeon-gitops-bot` (must be unique on GitHub; add a suffix if taken)
      - Homepage URL: `https://github.com/Chnu-devops/parcel-pigeon`
      - Webhook: untick **Active**
      - Repository permissions: **Contents → Read and write** (Metadata → Read-only is added automatically); nothing else
      - Where can this app be installed: **Only on this account**
      - **Create GitHub App**, then note the **App ID** at the top of its page.
   2. On the app's page: **Private keys → Generate a private key**. A `.pem`
      file downloads.
   3. **Install App** (left menu) → **Chnu-devops** → **Only select
      repositories → `parcel-pigeon-gitops`** → Install.
   4. **Chnu-devops → Settings → Secrets and variables → Actions**, limit both
      to the repo that runs the CI (**Repository access → Selected
      repositories → `parcel-pigeon`**):
      - **Variables** tab → New organization variable: `GITOPS_APP_ID` = the App ID.
      - **Secrets** tab → New organization secret: `GITOPS_APP_PRIVATE_KEY` =
        the whole content of the `.pem` file, `BEGIN`/`END` lines included.
   5. Delete the downloaded `.pem`; GitHub can generate a new one any time.

   On the GitHub Free plan, org secrets and variables aren't available to
   **private** repos. If `parcel-pigeon` is private, create the same two as
   repository secret/variable in `parcel-pigeon` instead.

2. **Let the config repo open promotion PRs.** Config repo → **Settings →
   Actions → General → Workflow permissions** → tick *Allow GitHub Actions to
   create and approve pull requests*. If it's greyed out, an org owner enables
   it first under **Chnu-devops → Settings → Actions → General**.
3. **Merge the PR** from Step 1 into `main`. The CI run on `main` then:
   - lints, tests and builds the four images, and pushes them as
     `ghcr.io/chnu-devops/<service>:<commit sha>` and `:latest`;
   - runs `bump-image-tags`, which commits `deploy(dev): … <sha7>` to the
     config repo, pinning all four dev tags (they start as `latest`);
   - that commit starts `promote.yml` in the config repo, which opens the PR
     **Promote dev → prod**. Leave it open for now.
4. **Make the images public.** The packages exist only after that first run.
   For each of `gateway`, `web`, `shipments-service` and `tracking-service`:
   **Chnu-devops → Packages → the package → Package settings → Change
   visibility → Public**. If public packages are disabled, an org owner allows
   them under **Settings → Packages**.

Check: the app repo's Actions run is green including *gitops / bump image
tags*; the config repo has a `deploy(dev)` commit and an open *Promote dev →
prod* PR; `docker pull ghcr.io/chnu-devops/web:latest` works without logging in.

## Step 3 — Start minikube

Use a separate minikube profile named `parcelpigeon` with 6 GB and 4 CPUs, so
the cluster you already use for other projects stays untouched.

```bash
minikube start -p parcelpigeon --memory 6g --cpus 4
minikube profile parcelpigeon          # later minikube commands use this profile
minikube addons enable ingress
kubectl config current-context         # parcelpigeon
```

Two full stacks plus Argo CD request about 1.5 GiB, and use more when busy.
minikube can't resize a running cluster: if pods stay `Pending` later, run
`minikube delete -p parcelpigeon` and start again with more memory.

Reaching the ingress depends on the driver:

- **macOS with the Docker driver (Docker Desktop or colima):** the minikube IP
  isn't routable from the Mac. Keep `minikube tunnel` running in a separate
  terminal (it asks for sudo) and use `127.0.0.1` in `/etc/hosts` (Step 6).
- **Linux, or a VM driver (hyperkit, qemu, VirtualBox):** use the address from
  `minikube ip` in `/etc/hosts`.

Check: `kubectl -n ingress-nginx get pods` shows the controller `Running`.

## Step 4 — Install Argo CD

Argo CD is installed once with `kubectl`; it is the only thing in the cluster
that isn't deployed from Git.

1. Install it and wait for the server:

   ```bash
   kubectl create namespace argocd
   kubectl apply -n argocd --server-side --force-conflicts \
     -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
   kubectl -n argocd rollout status deploy/argocd-server
   ```

   `--server-side` is required: one of Argo CD's CRDs is too large for a
   client-side apply.

2. Read the admin password and open the UI (keep the port-forward running in
   its own terminal):

   ```bash
   kubectl -n argocd get secret argocd-initial-admin-secret \
     -o jsonpath='{.data.password}' | base64 -d; echo
   kubectl -n argocd port-forward svc/argocd-server 8081:443
   ```

   Open https://localhost:8081, accept the self-signed certificate, and log in
   as `admin`.

3. Log in with the CLI (optional):
   `argocd login localhost:8081 --username admin --insecure`.
4. Faster pickup for demos (optional). Argo CD checks Git about every 3
   minutes, and GitHub webhooks can't reach minikube. To check every 60
   seconds instead:

   ```bash
   kubectl -n argocd patch configmap argocd-cm --type merge \
     -p '{"data":{"timeout.reconciliation":"60s"}}'
   kubectl -n argocd rollout restart deploy/argocd-repo-server statefulset/argocd-application-controller
   ```

5. **Only if the config repo is private:** give Argo CD read access with a
   second GitHub App (installed on `parcel-pigeon-gitops`, *Contents:
   Read-only*), since deploy keys are disabled in the org:

   ```bash
   argocd repo add https://github.com/Chnu-devops/parcel-pigeon-gitops.git \
     --github-app-id <app id> --github-app-installation-id <installation id> \
     --github-app-private-key-path <key.pem>
   ```

   The installation id is the number at the end of the URL on the app's
   installation page.

## Step 5 — Bootstrap dev and prod

One `kubectl apply` is the last manual deploy; from here on everything in the
cluster comes from the config repo's `main`.

```bash
cd ~/Developer/parcel-pigeon-gitops
git pull                                   # includes CI's deploy(dev) commit
kubectl apply -f clusters/dev/root.yaml -f clusters/prod/root.yaml
kubectl -n argocd get applications -L env,tier -w
```

What that creates, top down:

1. **Two root Applications**, `cluster-dev` and `cluster-prod`. Each syncs its
   `clusters/<env>/apps/` folder. They have no finalizer, so deleting a root
   never deletes an environment.
2. **Two ApplicationSets**, `parcelpigeon-dev` and `parcelpigeon-prod`. Each
   scans `apps/*/overlays/<env>` and `services/*/overlays/<env>` in the config repo.
3. **16 Applications**, one per component per environment: `gateway-dev`,
   `postgres-prod` and so on. Each renders `<folder>/<component>/base` with
   `base/values.yaml` plus `overlays/<env>/values.yaml`.
4. **Two namespaces**, `parcelpigeon-dev` and `parcelpigeon-prod`, created by
   the first Application that syncs into each.

The first sync takes 3–5 minutes, mostly image pulls. `shipments-service` and
`tracking-service` may restart a few times until postgres and rabbitmq are
ready; that's expected, and they settle by themselves.

At this point prod runs the `latest` images, dev runs the exact SHAs from CI.
Merging the open *Promote dev → prod* PR pins prod to the same SHAs as dev.

## Step 6 — Check it works

Everything is up when all 18 Applications are *Synced* and *Healthy* and both
hostnames answer.

1. **Argo CD:**

   ```bash
   kubectl -n argocd get applications -L env,tier
   # 2 roots + 16 apps, SYNC STATUS Synced, HEALTH STATUS Healthy
   ```

   In the UI, filter by the `env` or `tier` label to see one environment, or
   just the datastores.

2. **Pods:** `kubectl -n parcelpigeon-dev get pods` shows 8 pods;
   `kubectl -n parcelpigeon-prod get pods` shows 10, because prod runs gateway
   and web with 2 replicas each.
3. **Hostnames.** Add one line to `/etc/hosts`, using the address from Step 3
   (`127.0.0.1` with `minikube tunnel` running, otherwise `minikube ip`):

   ```bash
   echo "127.0.0.1 dev.parcelpigeon.local parcelpigeon.local" | sudo tee -a /etc/hosts
   curl -s http://dev.parcelpigeon.local/healthz
   curl -s http://parcelpigeon.local/healthz
   ```

   Then open http://dev.parcelpigeon.local and http://parcelpigeon.local in a browser.

4. **Demo data.** Each environment has its own empty database. Seed both:

   ```bash
   for env in dev prod; do
     kubectl -n parcelpigeon-$env exec deploy/shipments-service -- python -m app.seed
   done
   ```

No ingress at hand? `kubectl -n parcelpigeon-dev port-forward svc/web 8080:8080`
and open http://localhost:8080 also works.

## Step 7 — Ship a change to prod

A code change reaches dev on its own in a few minutes; it reaches prod only
when someone merges the promotion PR.

1. **Change one service** in the app repo, via a PR into `main` as usual:

   ```bash
   echo "// touch" >> web/src/main.tsx
   git commit -am "web: touch" && git push
   ```

2. **CI deploys it to dev.** After the build, `bump-image-tags` logs
   `web: -> <sha7>` and `unchanged` for the other three, and commits
   `deploy(dev): web <sha7>` to the config repo. Argo CD syncs **`web-dev`**
   only; check http://dev.parcelpigeon.local.
3. **The promotion PR updates.** `promote.yml` in the config repo refreshes
   *Promote dev → prod*, listing `` `web` → `<sha7>` ``. Review it and merge.
4. **Argo CD deploys it to prod.** **`web-prod`** syncs and both replicas roll.
   To skip the wait: `argocd app get web-prod --refresh`.

Each environment's deploy history is its own folder's history:

```bash
git log --oneline -- apps/web/overlays/prod/
argocd app history web-prod
```

**Rolling back prod** is a revert of the promotion commit, through a PR like
any prod change:

```bash
git switch -c rollback-web main
git revert <promotion commit>
git push -u origin rollback-web   # open a PR, merge it → web-prod syncs back
```

Argo CD's own *Rollback* button is disabled while auto-sync is on, by design:
Git is the only way to change what runs.

## Troubleshooting

Most first-run failures are a GitHub setting or memory; find the symptom below.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| App pods `ImagePullBackOff` | GHCR package still private, or not pushed yet | Make the four packages public (Step 2.4); check the image is `ghcr.io/chnu-devops/…` |
| Pods stay `Pending` | Not enough memory in the minikube profile | `kubectl describe pod <pod>` shows *Insufficient memory*; recreate the profile with more (Step 3) |
| An app shows *Unknown* or `ComparisonError` mentioning dependencies | Argo CD's Helm couldn't build the `parcelpigeon-common` dependency from `Chart.lock` | `kubectl -n argocd logs deploy/argocd-repo-server`; if it's the lock file, delete the `Chart.lock` files in the config repo and push |
| No Applications appear after Step 5 | ApplicationSet can't read the repo (private, or wrong URL) | `kubectl -n argocd describe applicationset parcelpigeon-dev`; see Step 4.5 for private repos |
| `web-prod` fails to sync: *host "parcelpigeon.local" … is already defined* | An older ParcelPigeon install still owns that host | Delete the old Ingress or its namespace (e.g. `kubectl delete namespace parcelpigeon`) |
| `shipments-service` restarts a few times right after Step 5 | postgres or rabbitmq not ready yet | Expected; it settles. If it keeps failing: `kubectl -n parcelpigeon-dev logs deploy/shipments-service` |
| *gitops / bump image tags* fails at *create-github-app-token* with *Input required* | `GITOPS_APP_ID` variable or `GITOPS_APP_PRIVATE_KEY` secret missing, or not shared with `parcel-pigeon` | Step 2.1.4; check *Repository access* on both |
| Same step fails with *Not Found* / no installation | App not installed on `parcel-pigeon-gitops` | Step 2.1.3 |
| Push fails with *403 … denied to github-actions[bot]* | The workflow still uses `GITHUB_TOKEN` (old `ci.yml`) | Use the `ci.yml` with the `create-github-app-token` step |
| Push fails with *403 … denied to <app>[bot]* | App lacks *Contents: write* | App settings → Permissions → Contents: Read and write, then accept the new permissions on the installation |
| No *Promote dev → prod* PR appears | Actions not allowed to create PRs | Step 2.2, at org level too; then **Actions → Promote → Run workflow** |
| A merged change isn't deployed yet | Argo CD polls Git every ~3 minutes | `argocd app get <app> --refresh`, or shorten polling (Step 4.4) |
| `*.parcelpigeon.local` doesn't resolve or times out on macOS | No tunnel with the Docker driver | Run `minikube tunnel` and use `127.0.0.1` in `/etc/hosts` |

## Teardown

The quickest full cleanup is deleting the minikube profile; the steps below
remove ParcelPigeon but keep the cluster and Argo CD.

1. Delete the roots first; otherwise they recreate the ApplicationSets within seconds:

   ```bash
   kubectl -n argocd delete application cluster-dev cluster-prod
   ```

2. Delete the ApplicationSets. Their 16 Applications go with them, and the
   Applications' finalizers delete the workloads:

   ```bash
   kubectl -n argocd delete applicationset parcelpigeon-dev parcelpigeon-prod
   ```

3. The PVCs survive on purpose (`Delete=false`). Delete the namespaces to drop
   the data too:

   ```bash
   kubectl delete namespace parcelpigeon-dev parcelpigeon-prod
   ```

4. Remove Argo CD, or the whole cluster:

   ```bash
   kubectl delete namespace argocd
   minikube delete -p parcelpigeon     # everything above in one go
   ```

Finally, remove the two `*.parcelpigeon.local` names from `/etc/hosts`. The
GitHub repos, the GitHub App and the images are untouched; Step 3 onwards brings
everything back.
