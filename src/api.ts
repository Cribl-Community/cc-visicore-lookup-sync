/**
 * Cribl REST API layer for the Lookup Sync app.
 *
 * Everything runs on the platform's injected auth (the fetch proxy stamps the
 * signed-in user's session onto each call) — the app holds no credentials.
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
 * Search lists lookups that live inside a pack as `<pack>.<file>` (pack
 * notation). Target groups don't have that pack, so the pack-prefixed id is
 * unaddressable there (500 "Invalid context <pack>") — pack lookups sync
 * into groups under their bare filename instead, like the UI's
 * "Move → All Lookups".
 */
export const packPrefix = (lookupId: string): string | null => {
  const stem = lookupId.replace(/\.[^.]+$/, '');
  const dot = stem.indexOf('.');
  return dot === -1 ? null : lookupId.slice(0, dot);
};

/** The id a lookup syncs to in a target group: pack lookups are de-packed. */
export const targetLookupId = (lookupId: string): string => {
  const prefix = packPrefix(lookupId);
  return prefix ? lookupId.slice(prefix.length + 1) : lookupId;
};

/** False when even the de-packed name is still pack notation (nested dots). */
export const isSyncable = (lookupId: string) => packPrefix(targetLookupId(lookupId)) === null;

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
 * returns parsed rows with an internal __id column, not the file.
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

// --- app-scoped KV persistence ---------------------------------------------

async function kvLoad<T>(key: string): Promise<T | null> {
  const resp = await request('GET', `/kvstore/${key}`, { ok404: true });
  if (resp.status === 404) return null;
  try {
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

const kvSave = (key: string, value: unknown) =>
  request('PUT', `/kvstore/${key}`, {
    body: JSON.stringify(value),
    contentType: 'application/json',
  });

export interface SavedSelection {
  sourceGroup: string;
  lookups: string[];
  targetGroups: string[];
}

export const loadSelection = () => kvLoad<SavedSelection>('selection');
export const saveSelection = (sel: SavedSelection) => kvSave('selection', sel).then(() => undefined);
