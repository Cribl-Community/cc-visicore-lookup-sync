/**
 * Cribl REST API layer for the Lookup Sync app.
 *
 * Port of vct-cribl-lookup-sync/sync_search_lookup.py. Auth is handled by
 * the platform fetch proxy, so unlike the script there are no credentials
 * here — every call is a plain fetch() against CRIBL_API_URL.
 */

const api = () => window.CRIBL_API_URL;

export interface Group {
  id: string;
  isFleet?: boolean;
  isSearch?: boolean;
  workerCount?: number;
  description?: string;
}

export interface Lookup {
  id: string;
  size?: number;
  rows?: number;
}

export type SyncState = 'in-sync' | 'stale' | 'missing' | 'error';

/**
 * Worker-group lookup routes parse `x.y` ids as pack notation (pack `x`,
 * file `y`) and answer 500 "Invalid context x" — so Search-exported lookups
 * with dotted names (`saved-search.name.csv`) can't be addressed there.
 */
export const hasDottedStem = (lookupId: string) =>
  lookupId.replace(/\.[^.]+$/, '').includes('.');

async function request(
  method: string,
  path: string,
  opts: { body?: BodyInit; contentType?: string; ok404?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  const resp = await fetch(api() + path, { method, headers, body: opts.body });
  if (!resp.ok && !(opts.ok404 && resp.status === 404)) {
    const text = (await resp.text()).slice(0, 300);
    throw new Error(`${method} ${path} failed: HTTP ${resp.status} ${text}`);
  }
  return resp;
}

const getJson = async <T>(path: string): Promise<T> =>
  (await request('GET', path)).json() as Promise<T>;

interface Items<T> {
  items?: T[];
}

/** All config groups: worker groups, Edge fleets, and Search groups. */
export async function listGroups(): Promise<Group[]> {
  const data = await getJson<Items<Group>>('/master/groups');
  return data.items ?? [];
}

export async function listLookups(group: string): Promise<Lookup[]> {
  const data = await getJson<Items<Lookup>>(`/m/${group}/system/lookups`);
  return data.items ?? [];
}

/**
 * True if the lookup object exists in the group. Deliberately probes the
 * object endpoint: /content answers HTTP 500 ("socket hang up"), not 404,
 * for a missing lookup, so it cannot be used as an existence check.
 */
export async function lookupExists(group: string, lookupId: string): Promise<boolean> {
  const resp = await request('GET', `/m/${group}/system/lookups/${lookupId}`, { ok404: true });
  if (resp.status === 404) return false;
  const data = (await resp.json()) as Items<Lookup>;
  return (data.items ?? []).length > 0;
}

/**
 * The lookup's raw file content. raw=true is required — without it the API
 * returns parsed JSON rows with an internal __id column, not the file.
 */
export async function getRawContent(group: string, lookupId: string): Promise<string | null> {
  const resp = await request(
    'GET',
    `/m/${group}/system/lookups/${lookupId}/content?raw=true`,
    { ok404: true },
  );
  return resp.status === 404 ? null : resp.text();
}

/**
 * Upload content into a group's lookup (create or update).
 *
 * Cribl's content upload is a two-step dance:
 *   1. PUT the raw bytes -> server stages them as a .tmp file.
 *   2. Point the lookup object's fileInfo.filename at that temp file
 *      (POST to create, PATCH to update). On PATCH, server-managed fields
 *      (status, notifications) must be stripped before sending back.
 */
export async function upsertLookup(group: string, lookupId: string, content: string): Promise<void> {
  const uploadResp = await request(
    'PUT',
    `/m/${group}/system/lookups?filename=${encodeURIComponent(lookupId)}`,
    { body: content, contentType: 'text/csv' },
  );
  const { filename: tmpName } = (await uploadResp.json()) as { filename: string };

  const objResp = await request('GET', `/m/${group}/system/lookups/${lookupId}`, { ok404: true });
  const items = objResp.status === 404 ? [] : ((await objResp.json()) as Items<Record<string, unknown>>).items ?? [];
  if (items.length === 0) {
    await request('POST', `/m/${group}/system/lookups`, {
      body: JSON.stringify({ id: lookupId, fileInfo: { filename: tmpName } }),
      contentType: 'application/json',
    });
  } else {
    const obj = { ...items[0] };
    delete obj.status;
    delete obj.notifications;
    obj.fileInfo = { filename: tmpName };
    await request('PATCH', `/m/${group}/system/lookups/${lookupId}`, {
      body: JSON.stringify(obj),
      contentType: 'application/json',
    });
  }
}

/** The two git paths a lookup owns in the group's config repo. */
export function lookupPaths(group: string, lookupId: string): string[] {
  const stem = lookupId.replace(/\.[^.]+$/, '');
  const base = `groups/${group}/data/lookups`;
  return [`${base}/${lookupId}`, `${base}/${stem}.yml`];
}

/**
 * Of the given lookups' config paths, those with uncommitted changes per
 * version/status. Scopes the commit, and recovers lookups a previous run
 * uploaded but never committed.
 */
export async function pendingLookupFiles(group: string, lookupIds: string[]): Promise<string[]> {
  const data = await getJson<Items<{ files?: { path: string }[] }>>(`/m/${group}/version/status`);
  const pending = new Set((data.items?.[0]?.files ?? []).map((f) => f.path));
  return lookupIds.flatMap((id) => lookupPaths(group, id)).filter((p) => pending.has(p));
}

/**
 * Commit exactly the given file paths. The scoped "files" list is the
 * load-bearing safety feature: unrelated pending changes in the group
 * (a colleague's in-progress work, post-upgrade default/ churn) are never
 * swept into the automated commit — or the deploy, which ships commits only.
 */
export async function commitFiles(group: string, files: string[], message: string): Promise<string> {
  const resp = await request('POST', `/m/${group}/version/commit`, {
    body: JSON.stringify({ message, files }),
    contentType: 'application/json',
  });
  const data = (await resp.json()) as Items<{ commit: string }>;
  return data.items?.[0]?.commit ?? '';
}

/** Deploy the group's latest committed config version. */
export async function deployGroup(group: string): Promise<string> {
  const data = await getJson<Items<string>>(`/master/groups/${group}/configVersion`);
  const version = data.items?.[0];
  if (!version) throw new Error(`no configVersion for group ${group}`);
  await request('PATCH', `/master/groups/${group}/deploy`, {
    body: JSON.stringify({ version }),
    contentType: 'application/json',
  });
  return version;
}

// --- scheduled sync via Script collector ----------------------------------
//
// Deviates from collector-sync-search-lookups.json in the original repo to
// remove every worker-node prerequisite (no SSH, no env file, no GitHub
// download — works on Cribl.Cloud-managed workers):
//   - sync_search_lookup.py is embedded in this app bundle and inlined into
//     the collector's discover script via a quoted heredoc;
//   - API credentials live in the group's encrypted secrets store and reach
//     the script through the collector's envVars, whose values are JS
//     expressions evaluated on the worker: C.Secret(id, 'credentials').
// Secrets are distributed with group config, so a schedule (and its
// credentials) take effect after commit + deploy — same lifecycle as before.

import syncScriptSource from './embedded/sync_search_lookup.py?raw';

export const SYNC_COLLECTOR_ID = 'sync-search-lookups';
export const SYNC_SECRET_ID = 'cc-lookup-sync-creds';

export interface CollectorJob {
  id: string;
  description?: string;
  schedule?: { enabled?: boolean; cronSchedule?: string; [key: string]: unknown };
  collector?: { type?: string; conf?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

export type SyncAuthMode = 'cloud' | 'local';

export interface ScheduleSpec {
  targetGroup: string;
  sourceGroup: string;
  lookups: string[];
  cronSchedule: string;
  deployDelay: number;
  deploy: boolean;
  enabled: boolean;
  /** Leader/workspace URL the worker-side script talks to. */
  baseUrl: string;
  /** cloud = API client id/secret via login.cribl.cloud; local = leader username/password. */
  authMode: SyncAuthMode;
}

/** The jobs.yml config path a collector definition lives in — used to scope the commit. */
export const jobsConfigPath = (group: string) => `groups/${group}/local/cribl/jobs.yml`;
/** Where the group's secrets store lives in config — committed encrypted. */
export const secretsConfigPath = (group: string) => `groups/${group}/local/cribl/secrets.yml`;

export function buildSyncCollector(spec: ScheduleSpec): CollectorJob {
  const flags = [
    ...spec.lookups.map((id) => `--lookup ${id}`),
    `--source-group ${spec.sourceGroup}`,
    `--target-group ${spec.targetGroup}`,
    // --deploy-delay (not --deploy): a synchronous deploy would restart the
    // very worker running the collector task before it can report success.
    ...(spec.deploy ? [`--deploy-delay ${spec.deployDelay}`] : []),
  ].join(' ');
  // The embedded script is written to a temp file at run time (a quoted
  // heredoc, so the worker shell expands nothing inside it) — the file must
  // exist on disk because --deploy-delay re-executes it from a detached child.
  const discoverScript = [
    'set -e',
    'command -v python3 >/dev/null || { echo "ERROR: python3 not found on worker node"; exit 1; }',
    "cat > /tmp/cc-lookup-sync.py <<'CCPYEOF'",
    syncScriptSource.trimEnd(),
    'CCPYEOF',
    `python3 /tmp/cc-lookup-sync.py ${flags} 2>&1`,
    '',
  ].join('\n');
  const secretField = (field: 'username' | 'password') =>
    `C.Secret('${SYNC_SECRET_ID}', 'credentials').${field}`;
  const envVars =
    spec.authMode === 'cloud'
      ? [
          { name: 'CRIBL_BASE_URL', value: `'${spec.baseUrl}'` },
          { name: 'CRIBL_CLIENT_ID', value: secretField('username') },
          { name: 'CRIBL_CLIENT_SECRET', value: secretField('password') },
        ]
      : [
          { name: 'CRIBL_BASE_URL', value: `'${spec.baseUrl}'` },
          { name: 'CRIBL_USERNAME', value: secretField('username') },
          { name: 'CRIBL_PASSWORD', value: secretField('password') },
        ];
  return {
    id: SYNC_COLLECTOR_ID,
    description:
      `Scheduled sync of Cribl Search lookups (${spec.lookups.join(', ')}) from ` +
      `${spec.sourceGroup} into ${spec.targetGroup}. Managed by the Lookup Sync app. ` +
      `Script embedded in this config; credentials from the '${SYNC_SECRET_ID}' group secret.`,
    type: 'collection',
    ttl: '4h',
    removeFields: [],
    resumeOnBoot: false,
    ignoreGroupJobsLimit: false,
    schedule: {
      enabled: spec.enabled,
      cronSchedule: spec.cronSchedule,
      maxConcurrentRuns: 1,
      skippable: false,
      run: { mode: 'run', rescheduleDroppedTasks: false, logLevel: 'info' },
    },
    streamtags: [],
    workerAffinity: false,
    collector: {
      type: 'script',
      destructive: false,
      conf: { shell: '/bin/bash', discoverScript, collectScript: 'true', envVars },
    },
    input: {
      type: 'collection',
      sendToRoutes: false,
      pipeline: 'devnull',
      output: 'devnull',
      staleChannelFlushMs: 10000,
      metadata: [],
      preprocess: { disabled: true },
    },
  };
}

/** Pull the sync settings back out of a collector's discover script. */
export function parseSyncCollector(job: CollectorJob): {
  lookups: string[];
  sourceGroup: string;
  deployDelay: number | null;
} {
  const script = String(job.collector?.conf?.discoverScript ?? '');
  const delay = script.match(/--deploy-delay\s+(\d+)/)?.[1];
  return {
    lookups: [...script.matchAll(/--lookup\s+(\S+)/g)].map((m) => m[1]),
    sourceGroup: script.match(/--source-group\s+(\S+)/)?.[1] ?? 'default_search',
    deployDelay: delay ? Number(delay) : null,
  };
}

// --- credentials secret (encrypted, per-group, distributed on deploy) ------

export interface SyncSecretInfo {
  id: string;
  /** Client id (cloud) or username (local). The secret value is never returned. */
  username?: string;
}

/** Metadata of the group's sync credentials secret, or null if absent. */
export async function getSyncSecret(group: string): Promise<SyncSecretInfo | null> {
  const resp = await request('GET', `/m/${group}/system/secrets/${SYNC_SECRET_ID}`, { ok404: true });
  if (resp.status === 404) return null;
  const data = (await resp.json()) as Items<SyncSecretInfo>;
  return data.items?.[0] ?? null;
}

export async function upsertSyncSecret(
  group: string,
  creds: { username: string; password: string },
  exists: boolean,
): Promise<void> {
  const body = JSON.stringify({
    id: SYNC_SECRET_ID,
    secretType: 'credentials',
    username: creds.username,
    password: creds.password,
    description: 'API credentials for the sync-search-lookups collector (Lookup Sync app)',
  });
  const path = exists ? `/m/${group}/system/secrets/${SYNC_SECRET_ID}` : `/m/${group}/system/secrets`;
  await request(exists ? 'PATCH' : 'POST', path, { body, contentType: 'application/json' });
}

export async function deleteSyncSecret(group: string): Promise<void> {
  const resp = await request('DELETE', `/m/${group}/system/secrets/${SYNC_SECRET_ID}`, { ok404: true });
  void resp;
}

/** Of the schedule-related config paths, those with uncommitted changes. */
export async function pendingScheduleFiles(group: string): Promise<string[]> {
  const data = await getJson<Items<{ files?: { path: string }[] }>>(`/m/${group}/version/status`);
  const pending = new Set((data.items?.[0]?.files ?? []).map((f) => f.path));
  return [jobsConfigPath(group), secretsConfigPath(group)].filter((p) => pending.has(p));
}

/** The group's sync collector definition, or null if none exists yet. */
export async function getSyncCollector(group: string): Promise<CollectorJob | null> {
  const resp = await request('GET', `/m/${group}/lib/jobs/${SYNC_COLLECTOR_ID}`, { ok404: true });
  if (resp.status === 404) return null;
  const data = (await resp.json()) as Items<CollectorJob>;
  return data.items?.[0] ?? null;
}

export async function upsertSyncCollector(group: string, job: CollectorJob, exists: boolean): Promise<void> {
  const path = exists ? `/m/${group}/lib/jobs/${SYNC_COLLECTOR_ID}` : `/m/${group}/lib/jobs`;
  await request(exists ? 'PATCH' : 'POST', path, {
    body: JSON.stringify(job),
    contentType: 'application/json',
  });
}

export async function deleteSyncCollector(group: string): Promise<void> {
  await request('DELETE', `/m/${group}/lib/jobs/${SYNC_COLLECTOR_ID}`);
}

// --- in-app (browser) scheduled sync ---------------------------------------
//
// Credential-less alternative to the worker collector: the sync runs inside
// the app on the signed-in user's platform-injected auth. Trade-off: it only
// runs while someone has the app open. Runs are idempotent (byte-compare,
// no-op when unchanged) and missed windows are caught up when the app opens.

export interface HeadlessSyncResult {
  lines: { kind: 'info' | 'success' | 'error'; text: string }[];
  committedGroups: string[];
  deployedGroups: string[];
}

/** One full sync pass — same semantics as the interactive Compare + Sync + Deploy. */
export async function runHeadlessSync(opts: {
  sourceGroup: string;
  lookups: string[];
  targetGroups: string[];
  deploy: boolean;
}): Promise<HeadlessSyncResult> {
  const lines: HeadlessSyncResult['lines'] = [];
  const committedGroups: string[] = [];
  const deployedGroups: string[] = [];

  const sourceContent: Record<string, string> = {};
  for (const id of opts.lookups) {
    try {
      if (!(await lookupExists(opts.sourceGroup, id))) {
        lines.push({ kind: 'error', text: `${id} not found in ${opts.sourceGroup} — skipped` });
        continue;
      }
      const content = await getRawContent(opts.sourceGroup, id);
      if (content === null) lines.push({ kind: 'error', text: `${id} has no content in ${opts.sourceGroup} — skipped` });
      else sourceContent[id] = content;
    } catch (e) {
      lines.push({ kind: 'error', text: `${id}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  for (const gid of opts.targetGroups) {
    try {
      let changed = 0;
      for (const [id, content] of Object.entries(sourceContent)) {
        try {
          const target = (await lookupExists(gid, id)) ? await getRawContent(gid, id) : null;
          if (target === content) continue;
          await upsertLookup(gid, id, content);
          changed++;
          lines.push({ kind: 'info', text: `[${gid}] synced ${id} (${content.length} bytes)` });
        } catch (e) {
          lines.push({ kind: 'error', text: `[${gid}] ${id}: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      const files = await pendingLookupFiles(gid, Object.keys(sourceContent));
      if (files.length === 0) {
        if (changed === 0) lines.push({ kind: 'info', text: `[${gid}] already up to date` });
        continue;
      }
      const names = [...new Set(files.map((p) => p.split('/').pop()))].sort();
      const commit = await commitFiles(gid, files, `scheduled sync from ${opts.sourceGroup}: ${names.join(', ')} (Lookup Sync app, browser schedule)`);
      committedGroups.push(gid);
      lines.push({ kind: 'success', text: `[${gid}] committed ${commit.slice(0, 8)} (${files.length} files)` });
      if (opts.deploy) {
        const version = await deployGroup(gid);
        deployedGroups.push(gid);
        lines.push({ kind: 'success', text: `[${gid}] deployed ${version.slice(0, 12)}` });
      }
    } catch (e) {
      lines.push({ kind: 'error', text: `[${gid}] sync failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { lines, committedGroups, deployedGroups };
}

export interface BrowserSchedule {
  enabled: boolean;
  cron: string;
  deploy: boolean;
  sourceGroup: string;
  lookups: string[];
  targetGroups: string[];
  /** Epoch ms of the last claimed run occurrence (shared across tabs via KV). */
  lastRun: number | null;
}

const BROWSER_SCHEDULE_KEY = '/kvstore/browser-schedule';

export async function loadBrowserSchedule(): Promise<BrowserSchedule | null> {
  const resp = await request('GET', BROWSER_SCHEDULE_KEY, { ok404: true });
  if (resp.status === 404) return null;
  try {
    return (await resp.json()) as BrowserSchedule;
  } catch {
    return null;
  }
}

export async function saveBrowserSchedule(sched: BrowserSchedule): Promise<void> {
  await request('PUT', BROWSER_SCHEDULE_KEY, {
    body: JSON.stringify(sched),
    contentType: 'application/json',
  });
}

// --- app settings persistence (app-scoped KV store) -----------------------

export interface SavedSelection {
  sourceGroup: string;
  lookups: string[];
  targetGroups: string[];
}

const SELECTION_KEY = '/kvstore/selection';

export async function loadSelection(): Promise<SavedSelection | null> {
  const resp = await request('GET', SELECTION_KEY, { ok404: true });
  if (resp.status === 404) return null;
  try {
    return (await resp.json()) as SavedSelection;
  } catch {
    return null;
  }
}

export async function saveSelection(sel: SavedSelection): Promise<void> {
  await request('PUT', SELECTION_KEY, {
    body: JSON.stringify(sel),
    contentType: 'application/json',
  });
}
