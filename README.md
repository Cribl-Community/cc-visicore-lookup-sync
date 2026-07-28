# Lookup Sync — a Cribl App

Sync lookup files from Cribl Search knowledge into Stream worker groups and
Edge fleets, right from the Cribl UI — with byte-for-byte comparison, commits
scoped to only the files touched, on-demand deploys, and managed scheduled
syncs.

This is the Cribl App port of
[VisiCore/vct-cribl-lookup-sync](https://github.com/VisiCore/vct-cribl-lookup-sync),
which does the same job as a standalone Python script driven by cron or a
Script collector. The app keeps the script's careful semantics and adds a UI,
platform-managed auth, and admin-reviewable API access.

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

**Scheduled sync** — for hands-off nightly syncs, the app provisions the same
scheduled Script collector as the original repo (`sync-search-lookups`) into
any target group: it bakes the selected lookups, source group, cron schedule,
and deploy delay into the collector's discover script, creates/updates it via
`/m/{group}/lib/jobs`, and commits scoped to `local/cribl/jobs.yml`. The
schedule activates on the next deploy of the group.

**Scheduled syncs overview** — the app scans every group for the sync
collector and lists what each one syncs (lookups, source, cron, enabled,
deploy behavior), parsed from the actual committed definition — including
collectors created outside the app. Schedules can be removed from here, with
confirmation and a scoped commit.

Selections persist in the app's KV store, all destructive operations require
explicit confirmation, and every run is logged in an activity panel.

## Requirements & installation

- Cribl 4.18.0+ (leader with the App platform enabled).
- Install the packaged app archive (`npm run package` → `build/*.tgz`) via
  your leader's Apps management page.
- At install time, admins see the app's full API surface in
  [`config/policies.yml`](config/policies.yml): lookups read/write, scoped
  version commits, group listing/deploys, and `lib/jobs` for the scheduled
  collector. No external domains are used (`config/proxies.yml` is empty).
- No credentials are configured in the app — the platform injects the signed-in
  user's auth into every API call.

### Scheduled sync prerequisite (per worker node)

The scheduled collector runs `sync_search_lookup.py` on a worker node of the
target group, and that script authenticates on its own. One-time setup on each
worker node, as the user Cribl runs as:

```bash
cat > ~/.cribl-lookup-sync.env <<'EOF'
export CRIBL_BASE_URL=https://main-<org>.cribl.cloud
export CRIBL_CLIENT_ID=xxx
export CRIBL_CLIENT_SECRET=xxx
EOF
chmod 600 ~/.cribl-lookup-sync.env
```

This is deliberate: collector configs are committed to the group's git
history, so secrets must live on the node, never in the config. Runs fail
with a clear error until the file exists. The scheduled run uses
`--deploy-delay` (not `--deploy`) so the deploy-triggered worker restart
can't kill the collector task that launched it — see the
[original repo's README](https://github.com/VisiCore/vct-cribl-lookup-sync)
for the full mechanics.

## Known limitation: dotted lookup names

Search-exported lookups named `<saved-search>.<name>.csv` (a dot in the base
name) **cannot be synced into worker groups**: Cribl's group lookup routes
parse `x.y` ids as pack notation (pack `x`, file `y`) and answer
`500 Invalid context x`. The app flags these in the source list and marks
them `not syncable` in the status matrix. Fix: rename the export in your
Search query — `| export to lookup gcp_vpcflow_direction.csv` instead of
letting it inherit the saved-search prefix.

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
- Removing a lookup from a schedule never deletes the target group's copy —
  clean those up from the group's Knowledge page.

## License

MIT — see [LICENSE](LICENSE).
