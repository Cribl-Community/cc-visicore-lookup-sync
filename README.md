# Lookup Sync — a Cribl App

Sync lookup files from Cribl Search knowledge into Stream worker groups and
Edge fleets, right from the Cribl UI — byte-for-byte comparison, commits
scoped to only the files touched, and on-demand deploys.
**Completely credential-less**: every call runs on the signed-in user's
session via the platform's injected auth.

This is the Cribl App port of
[VisiCore/vct-cribl-lookup-sync](https://github.com/VisiCore/vct-cribl-lookup-sync)
— same job, very different operational footprint. See
[App vs. script](#app-vs-script) for when to use which.

![Lookup Sync app: source/target selection with pack tags and filter, compare actions, and the per-group status matrix](images/lookup-sync-app.png)

## Why

You have data in Cribl Lake — asset inventory, threat intel, user/host
mappings — and want to reference it at ingest time in a Stream pipeline
(Lookup function, `C.Lookup()`). Stream can't query Lake, but Search can:

```
dataset="my_lake_dataset" earliest=-24h
| summarize count() by host, owner
| export to lookup host_owner.csv
```

That exported lookup lands **only in Search knowledge** (the `default_search`
group) — worker groups can't see it. This app closes the gap: it copies the
lookup into your worker groups, commits, and deploys, making it available to
pipelines. The same pattern works for anything Search can
`| export to lookup`, not just Lake data.

## What it does

**Compare** — pick lookups from a source group (default `default_search`) and
one or more target groups. The app fetches raw content from both sides and
shows a per-lookup × per-group status matrix: `in sync`, `out of date`,
`missing`, or `not syncable`. Lookup files a previous run uploaded but never
committed are detected via `version/status` and flagged.

**Sync & commit** — after an explicit confirmation listing exactly what will
be created or overwritten, changed lookups are uploaded (Cribl's two-step
content upload) and each group gets **one commit scoped to exactly the touched
lookup paths** (`data/lookups/<name>.csv` + `<name>.yml`). A colleague's
in-progress changes or post-upgrade `default/` churn are never swept into the
automated commit — and since deploy ships commits only, they stay out of the
deploy too.

**Deploy** — per-group button with its own confirmation. Nothing deploys
implicitly.

![Deploy confirmation naming the group and explaining that only committed changes ship](images/deploy-confirm.png)

Selections persist in the app's KV store, all destructive operations require
explicit confirmation, and every run is logged in an activity panel.

## App vs. script

This app is a faithful port of the original script — same compare-first,
scoped-commit, deploy-last semantics, same API calls underneath. What
changed is the operational footprint:

**Where the app wins: setup is zero.** Open it and sync. The platform
injects your signed-in session's auth into every call, so there are no API
credentials to create, no env file to drop on a host, no cron or collector
to wire up, and nothing to rotate or leak later. Admins review a declared
API surface (`config/policies.yml`) at install time instead of trusting a
bearer token sitting on a box.

**Where the script wins: unattended scheduling.** A Cribl app runs in your
browser — it has no server side for a timer to live on, and session auth
can't outlive the session. So this app cannot sync while nobody has it
open. The script, driven by cron or a scheduled Script collector with its
own API credentials, happily syncs at 3 a.m. with no one watching. That
capability is exactly what its extra setup pays for.

| | This app | Original script |
|---|---|---|
| Setup | None — open and sync | API credentials + env file + cron / Script collector |
| Auth | Signed-in session, nothing stored | Stored API credentials |
| Runs | On demand, while the app is open | Unattended, on a schedule |
| Best for | Ad hoc syncs, status checks, controlled deploys | Hands-off recurring syncs |

The two coexist fine — many setups want both: the script keeps nightly
syncs flowing, and this app is where you check status, sync on demand, and
deploy deliberately.

## Installation

**Requires Cribl 4.18.0+** (a leader with the App platform enabled). Install
one of three ways:

### Option 1: Import from Git (recommended)

Every release tag carries the built app, so the leader can install straight
from this repository — no download, no build:

1. On your leader, open the Apps management page and choose **Import from
   Git**.
2. Repository URL: `https://github.com/Cribl-Community/cc-visicore-lookup-sync.git`
3. Ref: `latest` (rolling tag that always points at the newest release), or
   pin a specific version tag like `v1.0.0`.

Note: only release tags contain the built app layout (`static/`, `default/`)
— importing the `main` branch won't work.

### Option 2: Upload a release archive

Download the `.tgz` from the
[latest GitHub release](https://github.com/Cribl-Community/cc-visicore-lookup-sync/releases/latest)
and upload it on your leader's Apps management page.

### Option 3: Build from source

```bash
npm ci
npm run package   # → build/*.tgz
```

Then upload the archive from `build/` as in Option 2.

### What admins see, and what the app can touch

- At install time, admins see the app's full API surface in
  [`config/policies.yml`](config/policies.yml): lookups read/write, scoped
  version commits, and group listing/deploys. No external domains are used
  (`config/proxies.yml` is empty).
- **Zero credentials, anywhere.** The platform injects the signed-in user's
  auth into every API call the app makes. There is nothing to create, store,
  rotate, or leak: no API credentials, no secrets store entries, no files on
  worker nodes. The signed-in user needs rights to read Search knowledge and
  edit/commit/deploy the target groups.

## Pack lookups

Search lists lookups that live inside a pack as `<pack>.<file>.csv` (pack
notation). Target groups don't have that pack, so the pack-prefixed id is
unaddressable there (`500 Invalid context <pack>`). The app handles this the
same way the Cribl UI's "Move → All Lookups" does: pack lookups sync into
the target group's **global knowledge under their bare filename** —
`starlink.status_lookup.csv` arrives as `status_lookup.csv`, and that's the
name pipelines reference. These rows are tagged `pack` in the source list,
the status matrix shows the rename (`pack.name.csv → name.csv`), and the
compare step refuses selections where two pack lookups would collide on the
same bare name.

![Syncing a pack lookup: the pack tag in the source list, and the Activity log showing it synced under its bare filename with the group pending deploy](images/pack-lookup-sync.png)

## Development

```bash
npm install
npm run dev       # Vite dev server for Cribl live preview
npm run build     # type-check + production build
npm run lint      # oxlint
npm run package   # build + installable archive in build/ (bumps version)
```

Built with React 19, TypeScript, Vite, and Cribl's
[Capra design system](https://capra.cribl.io). `src/api.ts` is the entire
Cribl REST surface; `src/App.tsx` is the UI. See `AGENTS.md` for the Cribl
App platform developer guide (fetch proxy, KV store, policies).

Implementation notes carried over from the original script:

- The `/content` endpoint answers HTTP 500 (not 404) for a missing lookup, so
  existence is probed on the object endpoint first.
- `raw=true` is required when reading content; without it the API returns
  parsed rows with an internal `__id` column.
- On PATCH of a lookup object, server-managed fields (`status`,
  `notifications`) are stripped before sending back.
- If a previous run uploaded or committed but died before deploying, the next
  compare/sync picks the staged files back up and commits them.
- Syncing never deletes anything: dropping a lookup from your selection
  leaves the target group's copy in place — clean those up from the group's
  Knowledge page.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
