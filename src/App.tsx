import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Spinner, Tag, Text, TextField } from '@capra/core';
import { ReloadOutlined, SwapRightOutlined } from '@capra/icons';
import {
  commitFiles,
  deployGroup,
  getRawContent,
  hasDottedStem,
  listGroups,
  listLookups,
  loadSelection,
  lookupExists,
  pendingLookupFiles,
  saveSelection,
  upsertLookup,
  type Group,
  type Lookup,
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

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const lookupMeta = (l: Lookup) =>
  [
    l.size !== undefined ? fmtBytes(l.size) : null,
    l.rows !== undefined ? `${l.rows} row${l.rows === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

function App() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [sourceGroup, setSourceGroup] = useState(DEFAULT_SOURCE);
  const [lookups, setLookups] = useState<Lookup[] | null>(null);
  const [selectedLookups, setSelectedLookups] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [lookupFilter, setLookupFilter] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmSyncOpen, setConfirmSyncOpen] = useState(false);
  const [confirmDeployGroup, setConfirmDeployGroup] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [needsDeploy, setNeedsDeploy] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<LogLine[]>([]);

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
        const [allGroups, saved] = await Promise.all([
          listGroups(),
          loadSelection().catch(() => null),
        ]);
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
            <span className="panel-title">
              <Text variant="body-md-semibold">Source lookups</Text>
              {selectedLookups.size > 0 && (
                <Tag size="sm" color="accent">{`${selectedLookups.size} selected`}</Tag>
              )}
            </span>
            <div className="source-picker">
              <Text color="secondary">from</Text>
              <select
                className="group-select"
                value={sourceGroup}
                onChange={(e) => {
                  setSourceGroup(e.target.value);
                  setSelectedLookups(new Set());
                  setLookupFilter('');
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
          {lookups !== null && lookups.length > 6 && (
            <TextField
              aria-label="Filter lookups"
              placeholder="Filter lookups…"
              value={lookupFilter}
              onChange={setLookupFilter}
            />
          )}
          {lookups === null ? (
            <div className="panel-loading"><Spinner /></div>
          ) : lookups.length === 0 ? (
            <Text color="secondary">No lookups in {sourceGroup}.</Text>
          ) : (
            <ul className="pick-list">
              {lookups
                .filter((l) => l.id.toLowerCase().includes(lookupFilter.trim().toLowerCase()))
                .map((l) => {
                  const selected = selectedLookups.has(l.id);
                  const busy = comparing || syncing;
                  return (
                    <li key={l.id}>
                      <div
                        className={`pick-row${selected ? ' selected' : ''}`}
                        onClick={() => !busy && toggle(selectedLookups, l.id, setSelectedLookups)}
                      >
                        <span className="pick-check">
                          <Checkbox
                            checked={selected}
                            onChange={() => toggle(selectedLookups, l.id, setSelectedLookups)}
                            disabled={busy}
                          />
                        </span>
                        <span className="row-name" title={l.id}>
                          <Text variant="code">{l.id}</Text>
                        </span>
                        {hasDottedStem(l.id) && (
                          <span
                            className="row-tag"
                            title="Worker groups treat the dotted name as pack notation — rename the export in Search to sync it"
                          >
                            <Tag size="sm" color="amber">won't sync</Tag>
                          </span>
                        )}
                        <span className="row-meta">
                          <Text color="tertiary" variant="body-xs-normal">{lookupMeta(l)}</Text>
                        </span>
                      </div>
                    </li>
                  );
                })}
              {lookupFilter.trim() !== '' &&
                lookups.every((l) => !l.id.toLowerCase().includes(lookupFilter.trim().toLowerCase())) && (
                  <li className="list-empty">
                    <Text color="secondary">No lookups match “{lookupFilter.trim()}”.</Text>
                  </li>
                )}
            </ul>
          )}
        </section>

        <div className="arrow-cell">
          <SwapRightOutlined />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              <Text variant="body-md-semibold">Target groups</Text>
              {selectedGroups.size > 0 && (
                <Tag size="sm" color="accent">{`${selectedGroups.size} selected`}</Tag>
              )}
            </span>
          </div>
          {groups === null ? (
            <div className="panel-loading"><Spinner /></div>
          ) : (
            <ul className="pick-list">
              {targetGroups.map((g) => {
                const selected = selectedGroups.has(g.id);
                const busy = comparing || syncing;
                return (
                  <li key={g.id}>
                    <div
                      className={`pick-row${selected ? ' selected' : ''}`}
                      onClick={() => !busy && toggle(selectedGroups, g.id, setSelectedGroups)}
                    >
                      <span className="pick-check">
                        <Checkbox
                          checked={selected}
                          onChange={() => toggle(selectedGroups, g.id, setSelectedGroups)}
                          disabled={busy}
                        />
                      </span>
                      <span className="row-name" title={g.id}>
                        <Text>{g.id}</Text>
                      </span>
                      <span className="row-meta">
                        <Tag size="sm" color={g.isFleet ? 'iris' : 'criblTeal'}>
                          {g.isFleet ? 'Edge fleet' : 'worker group'}
                        </Tag>
                      </span>
                    </div>
                  </li>
                );
              })}
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
        {!compare && selectedLookups.size > 0 && selectedGroups.size > 0 && (
          <Text color="secondary" variant="body-sm-normal">
            {selectedLookups.size} lookup{selectedLookups.size === 1 ? '' : 's'} →{' '}
            {selectedGroups.size} group{selectedGroups.size === 1 ? '' : 's'}
          </Text>
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
                  <th><span className="th-label">Lookup</span></th>
                  {Object.keys(compare.groups).map((gid) => (
                    <th key={gid}><span className="th-label">{gid}</span></th>
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
