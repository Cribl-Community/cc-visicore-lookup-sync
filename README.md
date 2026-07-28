# Lookup Sync — a Cribl App

Sync lookup files from Cribl Search knowledge into Stream worker groups and
Edge fleets, right from the Cribl UI — byte-for-byte comparison, commits
scoped to only the files touched, on-demand deploys, and in-app scheduled
syncs. **Completely credential-less**: every call runs on the signed-in
user's session via the platform's injected auth.

This is the Cribl App port of
[VisiCore/vct-cribl-lookup-sync](https://github.com/VisiCore/vct-cribl-lookup-sync),
which does the same job as a standalone Python script driven by cron or a
Script collector. The app keeps the script's careful semantics and drops all
of its operational baggage: no API credentials, no env files on worker
nodes, no Python — the sync engine is TypeScript inside the app.

![Lookup Sync app: source/target selection, status matrix, scheduled sync editor, and scheduled syncs overview](images/lookup-sync-app.png)

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

**Scheduled sync** — entirely credential-less: the sync runs inside the app
on the signed-in user's session, at a cron evaluated while the app is open.
No API credentials, no secrets, no collectors, nothing installed on worker
nodes. Missed windows are caught up the moment the app reopens, runs are
idempotent (byte-compared, no-op when unchanged), the schedule lives in the
app's KV store and is shared across tabs (with a `lastRun` claim so two open
tabs don't double-run), and every run is logged in the Activity panel.

The honest trade-off: **nothing runs while nobody has the app open.** That
is a platform property, not an app choice — Cribl apps have no server side,
and a session credential cannot outlive the session. If you need fully
unattended syncs with the app closed, use the original
[script + scheduled collector](https://github.com/VisiCore/vct-cribl-lookup-sync)
approach, which necessarily involves stored API credentials.

Selections persist in the app's KV store, all destructive operations require
explicit confirmation (enabling the schedule confirms once, up front, exactly
what will run automatically), and every run is logged in an activity panel.

## Requirements & installation

- Cribl 4.18.0+ (leader with the App platform enabled).
- Install the packaged app archive (`npm run package` → `build/*.tgz`) via
  your leader's Apps management page.
- At install time, admins see the app's full API surface in
  [`config/policies.yml`](config/policies.yml): lookups read/write, scoped
  version commits, and group listing/deploys. No external domains are used
  (`config/proxies.yml` is empty).
- **Zero credentials, anywhere.** The platform injects the signed-in user's
  auth into every API call the app makes — including scheduled runs, which
  execute inside the app. There is nothing to create, store, rotate, or leak:
  no API credentials, no secrets store entries, no files on worker nodes.
  The user who enables a schedule needs rights to read Search knowledge and
  edit/commit/deploy the target groups — the same rights the interactive
  buttons already require.

This design mirrors how other Cribl App Platform apps handle background
behavior (apps have no server side — e.g. cc-visicore-vitals provisions
native Cribl Notifications for alerting rather than running anything
itself). No native Cribl primitive exists for cross-group lookup sync, so
this app runs it in-session; syncs that must run with the app closed are the
original script's territory.

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
Cribl REST surface plus the headless sync engine; `src/cron.ts` is a minimal
5-field cron matcher for the in-app schedule; `src/App.tsx` is the UI. See
`AGENTS.md` for the Cribl App platform developer guide (fetch proxy, KV
store, policies).

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

Apache License 2.0 — see [LICENSE](LICENSE).
