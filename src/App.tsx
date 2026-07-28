import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Modal, NumberField, PasswordField, Spinner, Tag, Text, TextField } from '@capra/core';
import { ClockOutlined, ReloadOutlined, SwapRightOutlined } from '@capra/icons';
import {
  buildSyncCollector,
  commitFiles,
  deleteSyncCollector,
  deleteSyncSecret,
  deployGroup,
  getRawContent,
  getSyncCollector,
  getSyncSecret,
  hasDottedStem,
  parseSyncCollector,
  pendingScheduleFiles,
  listGroups,
  listLookups,
  loadSelection,
  lookupExists,
  pendingLookupFiles,
  saveSelection,
  SYNC_COLLECTOR_ID,
  SYNC_SECRET_ID,
  upsertLookup,
  upsertSyncCollector,
  upsertSyncSecret,
  type CollectorJob,
  type Group,
  type Lookup,
  type SyncAuthMode,
  type SyncSecretInfo,
  type SyncState,
} from './api';

const DEFAULT_SOURCE = 'default_search';

interface GroupCompare {
  states: Record<string, SyncState>;
  /** Lookup config paths already uploaded but never committed by a previous run. */
  pendingFiles: string[];
}

interface CompareResult {
  sourceGroup: string;
  sourceContent: Record<string, string>;
  missingInSource: string[];
  groups: Record<string, GroupCompare>;
}

interface LogLine {
  kind: 'info' | 'success' | 'error';
  text: string;
}

const STATE_TAG: Record<SyncState, { color: 'success' | 'warning' | 'danger'; label: string }> = {
  'in-sync': { color: 'success', label: 'in sync' },
  stale: { color: 'warning', label: 'out of date' },
  missing: { color: 'danger', label: 'missing' },
  error: { color: 'danger', label: 'not syncable' },
};

function App() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [sourceGroup, setSourceGroup] = useState(DEFAULT_SOURCE);
  const [lookups, setLookups] = useState<Lookup[] | null>(null);
  const [selectedLookups, setSelectedLookups] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmSyncOpen, setConfirmSyncOpen] = useState(false);
  const [confirmDeployGroup, setConfirmDeployGroup] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [needsDeploy, setNeedsDeploy] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<LogLine[]>([]);

  // Scheduled sync (Script collector) state
  const [schedules, setSchedules] = useState<Record<string, CollectorJob | null>>({});
  const [groupSecrets, setGroupSecrets] = useState<Record<string, SyncSecretInfo | null>>({});
  const [cron, setCron] = useState('0 7 * * *');
  const [deployDelay, setDeployDelay] = useState(30);
  const [deployAfter, setDeployAfter] = useState(true);
  const [schedEnabled, setSchedEnabled] = useState(true);
  const [authMode, setAuthMode] = useState<SyncAuthMode>('cloud');
  const [baseUrl, setBaseUrl] = useState(() => (window.CRIBL_API_URL ?? '').replace(/\/api\/v1\/?$/, ''));
  const [credId, setCredId] = useState('');
  const [credSecret, setCredSecret] = useState('');
  const [confirmSchedule, setConfirmSchedule] = useState<{ gid: string; action: 'save' | 'remove' } | null>(null);
  const [schedBusy, setSchedBusy] = useState<string | null>(null);

  const appendLog = useCallback((kind: LogLine['kind'], text: string) => {
    setLog((prev) => [...prev, { kind, text }]);
  }, []);

  const targetGroups = useMemo(
    () => (groups ?? []).filter((g) => !g.isSearch && g.id !== sourceGroup),
    [groups, sourceGroup],
  );

  // Initial load: groups, saved selection, then the source group's lookups.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [allGroups, saved] = await Promise.all([listGroups(), loadSelection().catch(() => null)]);
        if (cancelled) return;
        setGroups(allGroups);
        if (saved) {
          if (allGroups.some((g) => g.id === saved.sourceGroup)) setSourceGroup(saved.sourceGroup);
          setSelectedLookups(new Set(saved.lookups));
          setSelectedGroups(new Set(saved.targetGroups.filter((id) => allGroups.some((g) => g.id === id))));
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // (Re)load lookups whenever the source group changes.
  useEffect(() => {
    let cancelled = false;
    setLookups(null);
    setCompare(null);
    (async () => {
      try {
        const items = await listLookups(sourceGroup);
        if (!cancelled) {
          setLookups(items);
          setLoadError(null);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceGroup]);

  // Scan every target group for an existing sync collector — feeds both the
  // per-group schedule buttons and the "Scheduled syncs" overview panel.
  useEffect(() => {
    if (!groups) return;
    let cancelled = false;
    const missing = groups.filter((g) => !g.isSearch && !(g.id in schedules)).map((g) => g.id);
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (gid) => [gid, await getSyncCollector(gid).catch(() => null)] as const),
    ).then((entries) => {
      if (!cancelled) setSchedules((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [groups, schedules]);

  // Check the selected groups for stored sync credentials.
  useEffect(() => {
    let cancelled = false;
    const missing = [...selectedGroups].filter((gid) => !(gid in groupSecrets));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (gid) => [gid, await getSyncSecret(gid).catch(() => null)] as const),
    ).then((entries) => {
      if (!cancelled) setGroupSecrets((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedGroups, groupSecrets]);

  const scheduleScanDone = useMemo(
    () => !!groups && groups.filter((g) => !g.isSearch).every((g) => g.id in schedules),
    [groups, schedules],
  );

  const scheduledRows = useMemo(
    () =>
      (groups ?? [])
        .filter((g) => !g.isSearch)
        .flatMap((g) => {
          const job = schedules[g.id];
          return job ? [{ gid: g.id, job, parsed: parseSyncCollector(job) }] : [];
        }),
    [groups, schedules],
  );

  const toggle = (set: Set<string>, id: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
    setCompare(null); // selection changed — previous comparison no longer describes it
  };

  const persistSelection = useCallback(() => {
    void saveSelection({
      sourceGroup,
      lookups: [...selectedLookups],
      targetGroups: [...selectedGroups],
    }).catch(() => {
      /* preference save is best-effort */
    });
  }, [sourceGroup, selectedLookups, selectedGroups]);

  const runCompare = async () => {
    setComparing(true);
    setCompare(null);
    persistSelection();
    try {
      const sourceContent: Record<string, string> = {};
      const missingInSource: string[] = [];
      const sourceErrors: string[] = [];
      await Promise.all(
        [...selectedLookups].map(async (id) => {
          try {
            if (!(await lookupExists(sourceGroup, id))) {
              missingInSource.push(id);
              return;
            }
            const content = await getRawContent(sourceGroup, id);
            if (content === null) missingInSource.push(id);
            else sourceContent[id] = content;
          } catch (e) {
            missingInSource.push(id);
            sourceErrors.push(`[${sourceGroup}] ${id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );

      const present = Object.keys(sourceContent);
      const cellErrors: string[] = [];
      const groupResults: Record<string, GroupCompare> = {};
      await Promise.all(
        [...selectedGroups].map(async (gid) => {
          const states: Record<string, SyncState> = {};
          await Promise.all(
            present.map(async (id) => {
              // One bad lookup must not sink the whole comparison — record
              // the failure per cell and keep going.
              try {
                const target = (await lookupExists(gid, id)) ? await getRawContent(gid, id) : null;
                states[id] = target === null ? 'missing' : target === sourceContent[id] ? 'in-sync' : 'stale';
              } catch (e) {
                states[id] = 'error';
                const msg = e instanceof Error ? e.message : String(e);
                cellErrors.push(
                  msg.includes('Invalid context')
                    ? `[${gid}] ${id}: worker groups can't address this lookup — Cribl treats the dotted name as pack notation ` +
                      `("${id.split('.')[0]}" would be a pack). Rename the export in Search (no dots before .csv) to sync it.`
                    : `[${gid}] ${id}: ${msg}`,
                );
              }
            }),
          );
          let pendingFiles: string[] = [];
          try {
            pendingFiles = await pendingLookupFiles(gid, present);
          } catch (e) {
            cellErrors.push(`[${gid}] version/status failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          groupResults[gid] = { states, pendingFiles };
        }),
      );

      setCompare({ sourceGroup, sourceContent, missingInSource, groups: groupResults });
      for (const id of missingInSource) {
        appendLog('error', `${id} not found in ${sourceGroup} — skipped`);
      }
      for (const msg of [...sourceErrors, ...cellErrors]) {
        appendLog('error', msg);
      }
    } catch (e) {
      appendLog('error', `compare failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setComparing(false);
    }
  };

  // What a sync run would do, derived from the comparison.
  const plan = useMemo(() => {
    if (!compare) return null;
    const perGroup = Object.entries(compare.groups)
      .map(([gid, g]) => {
        const changed = Object.entries(g.states)
          .filter(([, s]) => s === 'stale' || s === 'missing')
          .map(([id, s]) => ({ id, state: s }));
        return { gid, changed, pendingFiles: g.pendingFiles, needsCommit: changed.length > 0 || g.pendingFiles.length > 0 };
      })
      .filter((g) => g.needsCommit);
    return { perGroup, totalChanges: perGroup.reduce((n, g) => n + g.changed.length, 0) };
  }, [compare]);

  const runSync = async () => {
    if (!compare || !plan) return;
    setConfirmSyncOpen(false);
    setSyncing(true);
    try {
      const deployed = new Set(needsDeploy);
      for (const groupPlan of plan.perGroup) {
        const { gid } = groupPlan;
        try {
          for (const { id } of groupPlan.changed) {
            appendLog('info', `[${gid}] syncing ${id} (${compare.sourceContent[id].length} bytes)`);
            await upsertLookup(gid, id, compare.sourceContent[id]);
          }
          // Commit whatever this run changed PLUS any lookup files a
          // previous run left staged-but-uncommitted.
          const files = await pendingLookupFiles(gid, Object.keys(compare.sourceContent));
          if (files.length === 0) {
            appendLog('info', `[${gid}] nothing to commit`);
            continue;
          }
          const names = [...new Set(files.map((p) => p.split('/').pop()))].sort();
          const commit = await commitFiles(gid, files, `sync lookups from ${compare.sourceGroup}: ${names.join(', ')}`);
          appendLog('success', `[${gid}] committed ${commit.slice(0, 8)} (${files.length} files)`);
          deployed.add(gid);
        } catch (e) {
          appendLog('error', `[${gid}] sync failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setNeedsDeploy(deployed);
      setCompare(null); // stale now — statuses changed
    } finally {
      setSyncing(false);
    }
  };

  const runDeploy = async (gid: string) => {
    setConfirmDeployGroup(null);
    setDeploying(gid);
    try {
      const version = await deployGroup(gid);
      appendLog('success', `[${gid}] deployed version ${version.slice(0, 16)}`);
      setNeedsDeploy((prev) => {
        const next = new Set(prev);
        next.delete(gid);
        return next;
      });
    } catch (e) {
      appendLog('error', `[${gid}] deploy failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeploying(null);
    }
  };

  const cronValid = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(cron.trim());

  const runSaveSchedule = async (gid: string) => {
    setConfirmSchedule(null);
    setSchedBusy(gid);
    try {
      const exists = !!schedules[gid];
      const secretExists = !!groupSecrets[gid];
      const credsEntered = credId.trim() !== '' && credSecret !== '';
      if (!secretExists && !credsEntered) {
        appendLog('error', `[${gid}] no credentials: enter a client id and secret (stored encrypted in the group's secrets store)`);
        return;
      }
      if (credsEntered) {
        await upsertSyncSecret(gid, { username: credId.trim(), password: credSecret }, secretExists);
        setGroupSecrets((prev) => ({ ...prev, [gid]: { id: SYNC_SECRET_ID, username: credId.trim() } }));
      }
      const job = buildSyncCollector({
        targetGroup: gid,
        sourceGroup,
        lookups: [...selectedLookups],
        cronSchedule: cron.trim(),
        deployDelay,
        deploy: deployAfter,
        enabled: schedEnabled,
        baseUrl: baseUrl.trim().replace(/\/$/, ''),
        authMode,
      });
      await upsertSyncCollector(gid, job, exists);
      const files = await pendingScheduleFiles(gid);
      const commit = await commitFiles(
        gid,
        files,
        `${exists ? 'update' : 'create'} ${SYNC_COLLECTOR_ID} collector (Lookup Sync app)`,
      );
      appendLog('success', `[${gid}] ${exists ? 'updated' : 'created'} ${SYNC_COLLECTOR_ID}, committed ${commit.slice(0, 8)} (${files.length} files) — deploy to activate`);
      setSchedules((prev) => ({ ...prev, [gid]: job }));
      setNeedsDeploy((prev) => new Set(prev).add(gid));
      setCredSecret('');
    } catch (e) {
      appendLog('error', `[${gid}] schedule save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSchedBusy(null);
    }
  };

  const runRemoveSchedule = async (gid: string) => {
    setConfirmSchedule(null);
    setSchedBusy(gid);
    try {
      await deleteSyncCollector(gid);
      await deleteSyncSecret(gid);
      const files = await pendingScheduleFiles(gid);
      const commit = await commitFiles(gid, files, `remove ${SYNC_COLLECTOR_ID} collector and credentials (Lookup Sync app)`);
      appendLog('success', `[${gid}] removed ${SYNC_COLLECTOR_ID} and its credentials secret, committed ${commit.slice(0, 8)} — deploy to apply`);
      setSchedules((prev) => ({ ...prev, [gid]: null }));
      setGroupSecrets((prev) => ({ ...prev, [gid]: null }));
      setNeedsDeploy((prev) => new Set(prev).add(gid));
    } catch (e) {
      appendLog('error', `[${gid}] schedule remove failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSchedBusy(null);
    }
  };

  const canCompare = selectedLookups.size > 0 && selectedGroups.size > 0 && !comparing && !syncing;

  if (loadError && !groups) {
    return (
      <div className="page">
        <Alert appearance="danger" title="Failed to load">
          {loadError}
        </Alert>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <Text as="h1" variant="heading-lg">Lookup Sync</Text>
        <Text as="p" color="secondary">
          Copy lookup files from Cribl Search knowledge into worker groups and Edge fleets,
          then commit and deploy only the files touched. Typical flow: a scheduled Search
          query exports Lake data with <Text variant="code">export to lookup</Text>, and this
          app makes the result usable by Stream pipelines.
        </Text>
      </header>

      {loadError && (
        <Alert appearance="danger" title="Error" onDismiss={() => setLoadError(null)}>
          {loadError}
        </Alert>
      )}

      <div className="selection-grid">
        <section className="panel">
          <div className="panel-header">
            <Text variant="body-md-semibold">Source lookups</Text>
            <div className="source-picker">
              <Text color="secondary">from</Text>
              <select
                className="group-select"
                value={sourceGroup}
                onChange={(e) => {
                  setSourceGroup(e.target.value);
                  setSelectedLookups(new Set());
                }}
                disabled={comparing || syncing}
              >
                {(groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.id}{g.id === DEFAULT_SOURCE ? ' (Cribl Search)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {lookups === null ? (
            <div className="panel-loading"><Spinner /></div>
          ) : lookups.length === 0 ? (
            <Text color="secondary">No lookups in {sourceGroup}.</Text>
          ) : (
            <ul className="pick-list">
              {lookups.map((l) => (
                <li key={l.id}>
                  <Checkbox
                    checked={selectedLookups.has(l.id)}
                    onChange={() => toggle(selectedLookups, l.id, setSelectedLookups)}
                    disabled={comparing || syncing}
                  >
                    <span className="pick-label">
                      <Text variant="code">{l.id}</Text>
                      <Text color="tertiary" variant="body-xs-normal">
                        {l.size !== undefined ? `${l.size} B` : ''}
                        {l.rows !== undefined ? ` · ${l.rows} rows` : ''}
                      </Text>
                      {hasDottedStem(l.id) && (
                        <Tag size="sm" color="amber">dotted name — won't sync</Tag>
                      )}
                    </span>
                  </Checkbox>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="arrow-cell">
          <SwapRightOutlined size="lg" />
        </div>

        <section className="panel">
          <div className="panel-header">
            <Text variant="body-md-semibold">Target groups</Text>
          </div>
          {groups === null ? (
            <div className="panel-loading"><Spinner /></div>
          ) : (
            <ul className="pick-list">
              {targetGroups.map((g) => (
                <li key={g.id}>
                  <Checkbox
                    checked={selectedGroups.has(g.id)}
                    onChange={() => toggle(selectedGroups, g.id, setSelectedGroups)}
                    disabled={comparing || syncing}
                  >
                    <span className="pick-label">
                      <Text>{g.id}</Text>
                      <Tag size="sm" color={g.isFleet ? 'iris' : 'criblTeal'}>
                        {g.isFleet ? 'Edge fleet' : 'worker group'}
                      </Tag>
                    </span>
                  </Checkbox>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="actions-row">
        <Button variant="primary" leadingIcon={ReloadOutlined} disabled={!canCompare} pending={comparing} onClick={() => void runCompare()}>
          Compare
        </Button>
        {plan && plan.perGroup.length > 0 && (
          <Button variant="primary" appearance="default" disabled={syncing} pending={syncing} onClick={() => setConfirmSyncOpen(true)}>
            {`Sync & commit (${plan.totalChanges} change${plan.totalChanges === 1 ? '' : 's'})`}
          </Button>
        )}
        {compare && plan && plan.perGroup.length === 0 && (
          <Tag color="success">Everything in sync — nothing to do</Tag>
        )}
      </div>

      {compare && Object.keys(compare.groups).length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <Text variant="body-md-semibold">Status</Text>
          </div>
          <div className="status-scroll">
            <table className="status-table">
              <thead>
                <tr>
                  <th><Text color="secondary" variant="body-xs-normal">lookup</Text></th>
                  {Object.keys(compare.groups).map((gid) => (
                    <th key={gid}><Text variant="body-sm-semibold">{gid}</Text></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.keys(compare.sourceContent).map((id) => (
                  <tr key={id}>
                    <td><Text variant="code">{id}</Text></td>
                    {Object.entries(compare.groups).map(([gid, g]) => {
                      const s = g.states[id];
                      return (
                        <td key={gid}>
                          {s ? <Tag size="sm" color={STATE_TAG[s].color}>{STATE_TAG[s].label}</Tag> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {Object.entries(compare.groups).some(([, g]) => g.pendingFiles.length > 0) && (
            <Alert appearance="warning" layout="inline" title="Uncommitted files detected">
              {Object.entries(compare.groups)
                .filter(([, g]) => g.pendingFiles.length > 0)
                .map(([gid, g]) => `${gid}: ${g.pendingFiles.map((p) => p.split('/').pop()).join(', ')}`)
                .join(' — ')}
              {' '}(left by a previous run; the next sync will commit them)
            </Alert>
          )}
        </section>
      )}

      {needsDeploy.size > 0 && (
        <section className="panel">
          <div className="panel-header">
            <Text variant="body-md-semibold">Committed — pending deploy</Text>
          </div>
          <Text as="p" color="secondary">
            Changes are committed but workers only pick them up after a deploy.
          </Text>
          <div className="deploy-row">
            {[...needsDeploy].map((gid) => (
              <Button key={gid} variant="secondary" pending={deploying === gid} disabled={deploying !== null} onClick={() => setConfirmDeployGroup(gid)}>
                {`Deploy ${gid}`}
              </Button>
            ))}
          </div>
        </section>
      )}

      {selectedGroups.size > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="pick-label">
              <ClockOutlined />
              <Text variant="body-md-semibold">Scheduled sync (Script collector)</Text>
            </span>
          </div>
          <Text as="p" color="secondary">
            For hands-off syncs, each target group runs the sync on a schedule via a Script
            collector named <Text variant="code">{SYNC_COLLECTOR_ID}</Text>. The sync script is
            embedded in the collector config and API credentials live in the group's encrypted
            secrets store — no SSH, no files on worker nodes, works with Cribl.Cloud-managed
            workers. The collector bakes in the currently selected lookups
            ({selectedLookups.size ? [...selectedLookups].join(', ') : 'none selected'}) and
            source group ({sourceGroup}). Only requirement on workers: <Text variant="code">python3</Text>.
          </Text>
          <div className="schedule-form">
            <div className="schedule-cred-fields">
              <div className="source-picker">
                <Text color="secondary">Auth</Text>
                <select
                  className="group-select"
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as SyncAuthMode)}
                >
                  <option value="cloud">Cloud API credentials</option>
                  <option value="local">Local username/password</option>
                </select>
              </div>
              <TextField
                label="Leader URL"
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder="https://main-<org>.cribl.cloud"
                helperText="Workspace/leader URL the worker-side script calls"
              />
              <TextField
                label={authMode === 'cloud' ? 'Client ID' : 'Username'}
                value={credId}
                onChange={setCredId}
                helperText={`Stored encrypted as group secret '${SYNC_SECRET_ID}'`}
              />
              <PasswordField
                label={authMode === 'cloud' ? 'Client secret' : 'Password'}
                value={credSecret}
                onChange={setCredSecret}
                helperText="Leave blank to keep a group's already-stored credentials"
              />
            </div>
            <TextField
              label="Cron schedule"
              value={cron}
              onChange={setCron}
              appearance={cronValid ? 'default' : 'danger'}
              placeholder="0 7 * * *"
              helperText="When the sync runs (leader's clock)"
            />
            <NumberField
              label="Deploy delay (seconds)"
              value={deployDelay}
              min={5}
              onChange={(v) => setDeployDelay(Number.isFinite(v) ? v : 30)}
              helperText="Deploy restarts the worker running the sync — it's scheduled this many seconds later, from a detached process that survives the restart"
            />
            <Checkbox checked={deployAfter} onChange={() => setDeployAfter((v) => !v)}>
              Deploy after sync (detached, delayed)
            </Checkbox>
            <Checkbox checked={schedEnabled} onChange={() => setSchedEnabled((v) => !v)}>
              Schedule enabled
            </Checkbox>
          </div>
          <Text color="tertiary" variant="body-xs-normal">
            Credentials need rights to read Search knowledge and edit/commit/deploy the target
            group. They're delivered to the script at run time via C.Secret() in the collector's
            environment variables — never in plain text in config or git.
          </Text>
          <ul className="schedule-list">
            {[...selectedGroups].map((gid) => {
              const existing = schedules[gid];
              const loaded = gid in schedules && gid in groupSecrets;
              const hasCreds = !!groupSecrets[gid] || (credId.trim() !== '' && credSecret !== '');
              return (
                <li key={gid} className="schedule-row">
                  <span className="pick-label">
                    <Text variant="body-sm-semibold">{gid}</Text>
                    {!loaded ? (
                      <Spinner size="sm" />
                    ) : existing ? (
                      <Tag size="sm" color={existing.schedule?.enabled ? 'success' : 'default'}>
                        {`${existing.schedule?.enabled ? 'scheduled' : 'disabled'} · ${existing.schedule?.cronSchedule ?? '?'}`}
                      </Tag>
                    ) : (
                      <Tag size="sm" color="default">no schedule</Tag>
                    )}
                    {loaded && (
                      groupSecrets[gid] ? (
                        <Tag size="sm" color="criblTeal">{`credentials stored${groupSecrets[gid]?.username ? ` · ${groupSecrets[gid]?.username}` : ''}`}</Tag>
                      ) : (
                        <Tag size="sm" color="amber">no credentials yet</Tag>
                      )
                    )}
                  </span>
                  <span className="schedule-row-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!loaded || selectedLookups.size === 0 || !cronValid || !baseUrl.trim() || !hasCreds || schedBusy !== null}
                      pending={schedBusy === gid}
                      onClick={() => setConfirmSchedule({ gid, action: 'save' })}
                    >
                      {existing ? 'Update schedule' : 'Create schedule'}
                    </Button>
                    {existing && (
                      <Button
                        size="sm"
                        variant="tertiary"
                        appearance="danger"
                        disabled={schedBusy !== null}
                        onClick={() => setConfirmSchedule({ gid, action: 'remove' })}
                      >
                        Remove
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {groups !== null && (
        <section className="panel">
          <div className="panel-header">
            <span className="pick-label">
              <Text variant="body-md-semibold">Scheduled syncs</Text>
              {!scheduleScanDone && <Spinner size="sm" />}
            </span>
            <Button
              size="sm"
              variant="tertiary"
              leadingIcon={ReloadOutlined}
              disabled={!scheduleScanDone || schedBusy !== null}
              onClick={() => setSchedules({})}
            >
              Rescan
            </Button>
          </div>
          {scheduledRows.length === 0 ? (
            <Text color="secondary">
              {scheduleScanDone
                ? `No group has a ${SYNC_COLLECTOR_ID} collector yet — select target groups above to create one.`
                : 'Scanning groups…'}
            </Text>
          ) : (
            <div className="status-scroll">
              <table className="status-table">
                <thead>
                  <tr>
                    <th><Text color="secondary" variant="body-xs-normal">group</Text></th>
                    <th><Text color="secondary" variant="body-xs-normal">lookups</Text></th>
                    <th><Text color="secondary" variant="body-xs-normal">source</Text></th>
                    <th><Text color="secondary" variant="body-xs-normal">schedule</Text></th>
                    <th><Text color="secondary" variant="body-xs-normal">after sync</Text></th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {scheduledRows.map(({ gid, job, parsed }) => (
                    <tr key={gid}>
                      <td><Text variant="body-sm-semibold">{gid}</Text></td>
                      <td><Text variant="code">{parsed.lookups.join(', ') || '—'}</Text></td>
                      <td><Text variant="code">{parsed.sourceGroup}</Text></td>
                      <td>
                        <span className="pick-label">
                          <Text variant="code">{job.schedule?.cronSchedule ?? '?'}</Text>
                          <Tag size="sm" color={job.schedule?.enabled ? 'success' : 'default'}>
                            {job.schedule?.enabled ? 'enabled' : 'disabled'}
                          </Tag>
                        </span>
                      </td>
                      <td>
                        <Text color="secondary">
                          {parsed.deployDelay !== null ? `deploy after ${parsed.deployDelay}s` : 'commit only'}
                        </Text>
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="tertiary"
                          appearance="danger"
                          disabled={schedBusy !== null}
                          pending={schedBusy === gid}
                          onClick={() => setConfirmSchedule({ gid, action: 'remove' })}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {log.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <Text variant="body-md-semibold">Activity</Text>
            <Button size="sm" variant="tertiary" onClick={() => setLog([])}>Clear</Button>
          </div>
          <ul className="log-list">
            {log.map((line, i) => (
              <li key={i} className={`log-${line.kind}`}>
                <Text variant="code">{line.text}</Text>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        isOpen={confirmSyncOpen}
        title="Sync and commit lookups?"
        confirmButtonText="Sync & commit"
        cancelButtonText="Cancel"
        onConfirm={() => void runSync()}
        onClose={() => setConfirmSyncOpen(false)}
      >
        <div className="confirm-body">
          <Text as="p">
            This uploads the lookups below into each group (overwriting the group's copy) and
            makes one commit per group, scoped to only these files. Nothing is deployed yet.
          </Text>
          {plan?.perGroup.map((g) => (
            <div key={g.gid} className="confirm-group">
              <Text variant="body-sm-semibold">{g.gid}</Text>
              <ul>
                {g.changed.map(({ id, state }) => (
                  <li key={id}>
                    <Text variant="code">{id}</Text>{' '}
                    <Text color="secondary">({state === 'missing' ? 'create' : 'overwrite'})</Text>
                  </li>
                ))}
                {g.pendingFiles.length > 0 && (
                  <li>
                    <Text color="secondary">
                      + commit {g.pendingFiles.length} previously staged file{g.pendingFiles.length === 1 ? '' : 's'}
                    </Text>
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        isOpen={confirmSchedule !== null}
        title={
          confirmSchedule?.action === 'remove'
            ? `Remove scheduled sync from ${confirmSchedule?.gid}?`
            : `${schedules[confirmSchedule?.gid ?? ''] ? 'Update' : 'Create'} scheduled sync in ${confirmSchedule?.gid}?`
        }
        confirmButtonText={confirmSchedule?.action === 'remove' ? 'Remove & commit' : 'Save & commit'}
        cancelButtonText="Cancel"
        onConfirm={() =>
          confirmSchedule &&
          void (confirmSchedule.action === 'remove'
            ? runRemoveSchedule(confirmSchedule.gid)
            : runSaveSchedule(confirmSchedule.gid))
        }
        onClose={() => setConfirmSchedule(null)}
      >
        {confirmSchedule?.action === 'remove' ? (
          <Text as="p">
            This deletes the <Text variant="code">{SYNC_COLLECTOR_ID}</Text> collector and its{' '}
            <Text variant="code">{SYNC_SECRET_ID}</Text> credentials secret from{' '}
            <Text variant="body-md-semibold">{confirmSchedule.gid}</Text> and commits the change
            (scoped to those config files only). Scheduled syncs stop after the next deploy.
            This cannot be undone from this app.
          </Text>
        ) : (
          <div className="confirm-body">
            <Text as="p">
              This {schedules[confirmSchedule?.gid ?? ''] ? 'overwrites the existing' : 'creates a'}{' '}
              <Text variant="code">{SYNC_COLLECTOR_ID}</Text> Script collector in{' '}
              <Text variant="body-md-semibold">{confirmSchedule?.gid}</Text>
              {credId.trim() && credSecret
                ? <> , stores the entered credentials encrypted as group secret <Text variant="code">{SYNC_SECRET_ID}</Text>,</>
                : ' (keeping the group’s stored credentials)'}{' '}
              and commits — scoped to those config files only. The schedule takes effect after
              the next deploy, which also distributes the credentials to the workers.
            </Text>
            <ul className="confirm-spec">
              <li><Text color="secondary">Lookups:</Text> <Text variant="code">{[...selectedLookups].join(', ')}</Text></li>
              <li><Text color="secondary">Source group:</Text> <Text variant="code">{sourceGroup}</Text></li>
              <li><Text color="secondary">Schedule:</Text> <Text variant="code">{cron.trim()}</Text> ({schedEnabled ? 'enabled' : 'disabled'})</li>
              <li><Text color="secondary">Leader URL:</Text> <Text variant="code">{baseUrl.trim()}</Text></li>
              <li><Text color="secondary">Auth:</Text> {authMode === 'cloud' ? 'Cloud API credentials' : 'Local username/password'}</li>
              <li>
                <Text color="secondary">After sync:</Text>{' '}
                {deployAfter ? `commit + detached deploy ${deployDelay}s later` : 'commit only (deploy manually)'}
              </li>
            </ul>
            <Text as="p" color="secondary">
              No worker-node setup is needed — the sync script ships inside the collector config
              and credentials are resolved on the worker via C.Secret().
            </Text>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={confirmDeployGroup !== null}
        title={`Deploy ${confirmDeployGroup ?? ''}?`}
        confirmButtonText="Deploy"
        cancelButtonText="Cancel"
        onConfirm={() => confirmDeployGroup && void runDeploy(confirmDeployGroup)}
        onClose={() => setConfirmDeployGroup(null)}
      >
        <Text as="p">
          This deploys the latest committed configuration of{' '}
          <Text variant="body-md-semibold">{confirmDeployGroup}</Text> to all of its
          workers, which restart to pick it up. Only committed changes ship — anything
          uncommitted stays behind.
        </Text>
      </Modal>
    </div>
  );
}

export default App;
