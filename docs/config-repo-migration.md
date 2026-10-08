# Moving deployment config to a separate GitOps repo — step by step

> Next step, on the `add-environments` branch: dev / prod overlays and
> promotion by PR — see `docs/environments-migration.md`.

This is the guide for moving the charts and Argo CD manifests out of this
repo into a dedicated **config repo**,
[`Chnu-devops/parcel-pigeon-gitops`](https://github.com/Chnu-devops/parcel-pigeon-gitops).
It builds on `add-split-charts` (see `docs/split-charts-migration.md`).
`git diff add-split-charts` on the `add-config-repo` branch is the reference
/ answer key for this repo; the config repo's first commit is the answer key
for the other side.

## Why a config repo

Until now one repo held both the code and "what runs in the cluster", and
CI committed image tags back into the same `main` it builds from. After the
split:

| | App repo `parcel-pigeon` | Config repo `parcel-pigeon-gitops` |
|---|---|---|
| holds | code, Dockerfiles, tests, CI | charts, values, Argo CD manifests |
| answers | *what does the software do?* | *what runs in the cluster right now?* |
| written by | developers (PRs) | CI (image tags) + people (config PRs) |
| read by | CI | Argo CD |
| history = | code changes | deployment log |

What you gain:

- **No bot commits in the app repo** — no `[skip ci]`, no rebase races with
  the bot, and CI can't trigger itself.
- **Deployment audit log** — `git log` of the config repo is exactly what was
  deployed when; rolling back a service is a `git revert` there.
- **Separate access** — merging code doesn't automatically mean you can change
  what runs; Argo CD only needs read access to one small repo.
- **Room to grow** — per-environment values (`envs/dev`, `envs/prod`) and
  other teams' apps fit here later.

The cost: two repos, a CI credential for cross-repo pushes, and a change
needing both code and chart edits (e.g. a new env var) becomes two PRs —
merge the chart change first if the new code requires it, otherwise the code
first.

## The new shape

```
parcel-pigeon (app repo)                  parcel-pigeon-gitops (config repo)
├── services/, web/                       ├── README.md
├── docs/                                 ├── argocd/
└── .github/workflows/ci.yml              │   ├── root-app.yaml
      test → build → push image ─┐        │   └── apps/parcelpigeon.yaml
      bump-image-tags ───────────┼──────▶ └── helm/
                                 │            ├── charts/<component>/   × 8
                                 │            └── library/parcelpigeon-common/
                    ghcr.io/chnu-devops/<svc>:<sha>        ▲
                                                           │ watches main
                                                       Argo CD
```

## Prerequisites

- `add-split-charts` is merged into `main` and Argo CD is running the 8
  `parcelpigeon-<component>` Applications (`docs/split-charts-migration.md`).
- The app repo is checked out next to where the config repo will go
  (the commands below assume `../parcel-pigeon`; adjust the path).
- `origin` points at the org: `git remote set-url origin git@github.com:Chnu-devops/parcel-pigeon.git`.

## Step 1 — Create the config repo

On GitHub: **Chnu-devops → New repository → `parcel-pigeon-gitops`**,
empty (no README / license). Public is simplest; for a private repo see
Step 6.

Locally, copy over everything deploy-related from the app repo:

```bash
cd ..
mkdir parcel-pigeon-gitops && cd parcel-pigeon-gitops
git init -b main
git -C ../parcel-pigeon archive origin/main helm argocd | tar -x
```

Take `helm/` from the app repo's **`main`** (not from a feature branch): CI
has been writing real image SHAs into `values.yaml` there, and you want the
config repo to start with what's running now.

Point both Argo CD manifests at the new repo — in `argocd/root-app.yaml` and
twice in `argocd/apps/parcelpigeon.yaml` (generator + template):

```bash
sed -i '' 's|Chnu-devops/parcel-pigeon.git|Chnu-devops/parcel-pigeon-gitops.git|' \
  argocd/root-app.yaml argocd/apps/parcelpigeon.yaml
grep -rn repoURL argocd
```

Add a `.gitignore`:

```gitignore
.DS_Store

# helm dependency build output (Argo CD rebuilds it from Chart.lock)
helm/charts/*/charts/
```

and a short `README.md` saying what the repo is and who writes to it.
Then check and push:

```bash
for c in helm/charts/*/; do helm dependency update "$c" && helm lint "$c"; done
git add . && git commit -m "Import charts and Argo CD manifests from parcel-pigeon"
git remote add origin git@github.com:Chnu-devops/parcel-pigeon-gitops.git
git push -u origin main
```

Nothing in the cluster has changed yet — Argo CD still reads the app repo.

## Step 2 — Re-point Argo CD at the config repo

The root Application was applied by hand, so it's re-pointed by hand. From
the config repo:

```bash
kubectl apply -f argocd/root-app.yaml
argocd app get root --refresh
```

What happens:

1. `root` now renders `argocd/apps/` from the **config repo** — the same
   `ApplicationSet` named `parcelpigeon`, with a new `repoURL`.
2. The ApplicationSet is updated in place and updates its 8 Applications in
   place (same names: `parcelpigeon-gateway`, …), now pointing at the config
   repo.
3. Each Application renders the same chart with the same values → no diff →
   **no pods restart**.

Nothing is deleted at any point because every object keeps its name. Check:

```bash
kubectl -n argocd get applications \
  -o custom-columns=NAME:.metadata.name,REPO:.spec.source.repoURL,SYNC:.status.sync.status,HEALTH:.status.health.status
```

Every row should show `parcel-pigeon-gitops.git`, `Synced` and `Healthy`.

**Order matters.** Do this *before* Step 4. If `helm/` and `argocd/` were
removed from the app repo while `root` still read it, `root` would prune
the ApplicationSet, the finalizers would cascade, and every workload would be
deleted.

## Step 3 — Give CI write access to the config repo

`GITHUB_TOKEN` can only write to the repo the workflow runs in, so CI needs
its own credential for the config repo. The options, narrowest first:

| Credential | Scope | Tied to | Expires | In Chnu-devops |
| --- | --- | --- | --- | --- |
| deploy key (SSH) | one repo | nobody | never | **disabled by org policy** |
| GitHub App | the repos it's installed on, only the permissions it asks for | the org | each token after 1 hour | **use this** |
| fine-grained PAT | chosen repos | a person | at most 1 year | works, but leaves with that person |

So CI uses an **org-owned GitHub App**, installed only on
`parcel-pigeon-gitops` with *Contents: Read and write*. The App ID goes in an
org variable `GITOPS_APP_ID` and its private key in an org secret
`GITOPS_APP_PRIVATE_KEY`, both shared only with `parcel-pigeon`. The
click-by-click setup is Step 2.1 of `docs/running-gitops.md`.

If the config repo's `main` gets a ruleset or branch protection, add the app
to its bypass list: CI pushes dev deploys straight to `main`.

## Step 4 — Remove deploy config from the app repo, re-target CI

On the `add-config-repo` branch:

```bash
git rm -r helm argocd
```

and drop the `helm/charts/*/charts/` line from `.gitignore`.

In `.github/workflows/ci.yml` the `bump-image-tags` job now checks out
**both** repos, the app repo for the diff and the config repo to edit:

```yaml
  bump-image-tags:
      name: gitops / bump image tags
      needs: [build-and-publish]
      if: github.event_name == 'push' && github.ref == 'refs/heads/main'
      runs-on: ubuntu-latest
      env:
        SHA: ${{ github.sha }}
        GITOPS_REPO: Chnu-devops/parcel-pigeon-gitops
      steps:
        - uses: actions/checkout@v4
          with:
            fetch-depth: 0
        - uses: actions/create-github-app-token@v2
          id: gitops-token
          with:
            app-id: ${{ vars.GITOPS_APP_ID }}
            private-key: ${{ secrets.GITOPS_APP_PRIVATE_KEY }}
            owner: ${{ github.repository_owner }}
            repositories: parcel-pigeon-gitops
        - uses: actions/checkout@v4
          with:
            repository: ${{ env.GITOPS_REPO }}
            token: ${{ steps.gitops-token.outputs.token }}
            path: gitops
        - name: Set image tags of changed services to this commit
          run: |
            # same loop as before, but on gitops/helm/charts/<svc>/values.yaml;
            # collects the bumped services into $BUMPED
        - name: Commit and push to the config repo
          if: env.BUMPED != ''
          working-directory: gitops
          run: |
            git commit -am "deploy(${BUMPED}): ${SHA::7}" \
              -m "From https://github.com/Chnu-devops/parcel-pigeon/commit/${SHA}"
            git pull --rebase origin main
            git push origin HEAD:main
```

What changed compared to `add-split-charts`:

- the job no longer needs `contents: write` on the app repo — it never
  pushes there;
- the "changed since the deployed commit" check is the same: the tag is read
  from the config repo, but `git diff <tag> <sha> -- services/gateway` runs in
  the app repo checkout, where that history lives;
- the commit message names the services and links back to the source commit,
  so the config repo's log reads like a deploy log:
  `deploy(gateway,web): a1b2c3d`;
- no `[skip ci]` needed — the push goes to a repo without this workflow.

Merge `add-config-repo` into `main`.

## Step 5 — Watch one change go through

```bash
# app repo: a code change in one service
echo "// touch" >> web/src/main.tsx
git commit -am "web: touch" && git push        # via PR in real life
```

1. App repo Actions: tests → build → `ghcr.io/chnu-devops/web:<sha>` pushed →
   `bump-image-tags` logs `web: -> <sha>`, others `unchanged`.
2. Config repo: new commit `deploy(web): <sha7>` touching only
   `helm/charts/web/values.yaml`.
3. Argo CD (within ~3 min, or `argocd app get parcelpigeon-web --refresh`):
   only `parcelpigeon-web` goes OutOfSync → syncs → web pods roll.

Roll it back from the config repo:

```bash
cd ../parcel-pigeon-gitops && git pull
git revert --no-edit HEAD && git push
```

## Step 6 — Private config repo (optional)

If `parcel-pigeon-gitops` is private, Argo CD needs read access. Deploy
keys are disabled in the org, so use a second GitHub App with *Contents:
Read-only*, installed on the config repo:

```bash
argocd repo add https://github.com/Chnu-devops/parcel-pigeon-gitops.git \
  --github-app-id <app id> --github-app-installation-id <installation id> \
  --github-app-private-key-path <key.pem>
```

The `repoURL`s stay in their `https://` form.

Also make sure the GHCR packages under `chnu-devops` are public (or add an
`imagePullSecret`): images now live at `ghcr.io/chnu-devops/*` because CI
pushes to `ghcr.io/<repository_owner>`.

## Later (not in this branch)

Per-environment folders in the config repo (`envs/dev`, `envs/prod`) with a
matrix ApplicationSet and promotion by PR; publishing charts as OCI artifacts
from the app repo and keeping only values in the config repo; Argo CD
notifications posting sync results back to the app repo's commits — see
`docs/lecture-map.md`.
