import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Spinner, Tag, Text, TextField } from '@capra/core';
import { ClockOutlined, ReloadOutlined, SwapRightOutlined } from '@capra/icons';
import {
  commitFiles,
  deployGroup,
  getRawContent,
  hasDottedStem,
  listGroups,
  listLookups,
  loadBrowserSchedule,
  loadSelection,
  lookupExists,
  pendingLookupFiles,
  runHeadlessSync,
  saveBrowserSchedule,
  saveSelection,
  upsertLookup,
  type BrowserSchedule,
  type Group,
  type Lookup,
  type SyncState,
} from './api';
import { lastDue, nextDue } from './cron';

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

  // Scheduled sync — credential-less, runs in-app on the signed-in session.
  const [cron, setCron] = useState('0 7 * * *');
  const [deployAfter, setDeployAfter] = useState(true);
  const [schedule, setSchedule] = useState<BrowserSchedule | null>(null);
  const [scheduleRunning, setScheduleRunning] = useState(false);
  const [confirmScheduleOpen, setConfirmScheduleOpen] = useState(false);
  const scheduleRunningRef = useRef(false);

  const appendLog = useCallback((kind: LogLine['kind'], text: string) => {
    setLog((prev) => [...prev, { kind, text }]);
  }, []);

  const targetGroups = useMemo(
    () => (groups ?? []).filter((g) => !g.isSearch && g.id !== sourceGroup),
    [groups, sourceGroup],
  );

  // Initial load: groups, saved selection, schedule.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [allGroups, saved, sched] = await Promise.all([
          listGroups(),
          loadSelection().catch(() => null),
          loadBrowserSchedule().catch(() => null),
        ]);
        if (cancelled) return;
        setGroups(allGroups);
        if (sched) setSchedule(sched);
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

  // Schedule loop: while armed and the app is open, run when a cron
  // occurrence is due. lastRun is claimed in the KV store BEFORE running so
  // another open tab won't double-run; missed windows (app closed) surface
  // as a due occurrence the moment the app reopens. Syncs are idempotent, so
  // an occasional race costs nothing but a no-op.
  useEffect(() => {
    if (!schedule?.enabled) return;
    const tick = async () => {
      if (scheduleRunningRef.current) return;
      const due = lastDue(schedule.cron, Date.now());
      if (due === null || (schedule.lastRun !== null && due <= schedule.lastRun)) return;
      scheduleRunningRef.current = true;
      setScheduleRunning(true);
      try {
        const claimed = { ...schedule, lastRun: due };
        await saveBrowserSchedule(claimed);
        setSchedule(claimed);
        appendLog('info', `scheduled sync due ${new Date(due).toLocaleString()} — running with your session`);
        const res = await runHeadlessSync({
          sourceGroup: schedule.sourceGroup,
          lookups: schedule.lookups,
          targetGroups: schedule.targetGroups,
          deploy: schedule.deploy,
        });
        for (const l of res.lines) appendLog(l.kind, l.text);
        const undeployed = res.committedGroups.filter((g) => !res.deployedGroups.includes(g));
        if (undeployed.length > 0) setNeedsDeploy((prev) => new Set([...prev, ...undeployed]));
        if (res.committedGroups.length === 0) appendLog('info', 'scheduled sync: everything already in sync');
      } catch (e) {
        appendLog('error', `scheduled sync failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        scheduleRunningRef.current = false;
        setScheduleRunning(false);
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), 30_000);
    return () => clearInterval(handle);
  }, [schedule, appendLog]);

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
      const errors: string[] = [];
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
            errors.push(`[${sourceGroup}] ${id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );

      const present = Object.keys(sourceContent);
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
                errors.push(
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
            errors.push(`[${gid}] version/status failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          groupResults[gid] = { states, pendingFiles };
        }),
      );

      setCompare({ sourceGroup, sourceContent, missingInSource, groups: groupResults });
      for (const id of missingInSource) appendLog('error', `${id} not found in ${sourceGroup} — skipped`);
      for (const msg of errors) appendLog('error', msg);
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

  const armSchedule = async () => {
    setConfirmScheduleOpen(false);
    const sched: BrowserSchedule = {
      enabled: true,
      cron: cron.trim(),
      deploy: deployAfter,
      sourceGroup,
      lookups: [...selectedLookups],
      targetGroups: [...selectedGroups],
      lastRun: Date.now(), // start with the NEXT occurrence; use Sync for an immediate run
    };
    try {
      await saveBrowserSchedule(sched);
      setSchedule(sched);
      appendLog('success', `scheduled sync enabled: ${sched.cron} — ${sched.lookups.join(', ')} → ${sched.targetGroups.join(', ')}`);
    } catch (e) {
      appendLog('error', `failed to save schedule: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const disarmSchedule = async () => {
    if (!schedule) return;
    const sched = { ...schedule, enabled: false };
    try {
      await saveBrowserSchedule(sched);
      setSchedule(sched);
      appendLog('info', 'scheduled sync disabled');
    } catch (e) {
      appendLog('error', `failed to disable schedule: ${e instanceof Error ? e.message : String(e)}`);
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
          <Button variant="primary" disabled={syncing} pending={syncing} onClick={() => setConfirmSyncOpen(true)}>
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

      <section className="panel">
        <div className="panel-header">
          <span className="pick-label">
            <ClockOutlined />
            <Text variant="body-md-semibold">Scheduled sync</Text>
            <Tag size="sm" color="criblTeal">no credentials — uses your session</Tag>
            {scheduleRunning && <Spinner size="sm" />}
          </span>
          {schedule?.enabled ? (
            <Button size="sm" variant="secondary" onClick={() => void disarmSchedule()}>
              Disable
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={selectedLookups.size === 0 || selectedGroups.size === 0 || !cronValid}
              onClick={() => setConfirmScheduleOpen(true)}
            >
              Enable
            </Button>
          )}
        </div>
        {schedule?.enabled ? (
          <Text color="secondary">
            Runs <Text variant="code">{schedule.cron}</Text> while this app is open:{' '}
            {schedule.lookups.join(', ')} from {schedule.sourceGroup} into{' '}
            {schedule.targetGroups.join(', ')}
            {schedule.deploy ? ', then deploys' : ' (commit only)'}. Last run:{' '}
            {schedule.lastRun ? new Date(schedule.lastRun).toLocaleString() : 'never'}; next:{' '}
            {(() => {
              const n = nextDue(schedule.cron, Date.now());
              return n ? new Date(n).toLocaleString() : 'unknown';
            })()}. Missed windows run as soon as the app is reopened.
          </Text>
        ) : (
          <>
            <Text color="secondary">
              The sync runs inside this app with your signed-in session — no credentials, no
              collectors, nothing on workers. It runs while someone has the app open; missed
              windows are caught up on open, and unchanged lookups are no-ops. Enable uses the
              current lookup and group selection above.
            </Text>
            <div className="schedule-form">
              <TextField
                label="Cron schedule"
                value={cron}
                onChange={setCron}
                appearance={cronValid ? 'default' : 'danger'}
                placeholder="0 7 * * *"
                helperText="When the sync runs (your local time, while the app is open)"
              />
              <Checkbox checked={deployAfter} onChange={() => setDeployAfter((v) => !v)}>
                Deploy after sync
              </Checkbox>
            </div>
          </>
        )}
      </section>

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
        isOpen={confirmScheduleOpen}
        title="Enable scheduled sync?"
        confirmButtonText="Enable"
        cancelButtonText="Cancel"
        onConfirm={() => void armSchedule()}
        onClose={() => setConfirmScheduleOpen(false)}
      >
        <div className="confirm-body">
          <Text as="p">
            While this app is open, it will automatically sync, commit
            {deployAfter ? ', and deploy' : ''} on the schedule below using your signed-in
            session — no further confirmation per run. Runs are logged in the Activity panel,
            commits stay scoped to the touched lookup files, and unchanged lookups are no-ops.
          </Text>
          <ul className="confirm-spec">
            <li><Text color="secondary">Lookups:</Text> <Text variant="code">{[...selectedLookups].join(', ')}</Text></li>
            <li><Text color="secondary">Source group:</Text> <Text variant="code">{sourceGroup}</Text></li>
            <li><Text color="secondary">Targets:</Text> <Text variant="code">{[...selectedGroups].join(', ')}</Text></li>
            <li><Text color="secondary">Schedule:</Text> <Text variant="code">{cron.trim()}</Text> (while app is open; catch-up on reopen)</li>
            <li><Text color="secondary">After sync:</Text> {deployAfter ? 'deploy immediately' : 'commit only — deploy manually'}</li>
          </ul>
          <Text as="p" color="secondary">
            Nothing runs while the app is closed. The schedule is stored in the app's KV store
            and shared across tabs; the first run happens at the next cron occurrence.
          </Text>
        </div>
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
