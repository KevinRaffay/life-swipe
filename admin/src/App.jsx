import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api.js';
import Table from './components/Table.jsx';
import Warnings from './components/Warnings.jsx';
import Modal from './components/Modal.jsx';
import PatternForm from './components/PatternForm.jsx';
import SeedForm from './components/SeedForm.jsx';
import Extraction from './components/Extraction.jsx';
import SeedGeneration from './components/SeedGeneration.jsx';
import Harvest from './components/Harvest.jsx';
import Preview from './components/Preview.jsx';
import Stats from './components/Stats.jsx';
import Logs from './components/Logs.jsx';
import NamePool from './components/NamePool.jsx';
import ProviderToggle from './components/ProviderToggle.jsx';

const TABS = [
  ['library', 'Library'],
  ['seeds', 'Seed deck'],
  ['names', 'Name pool'],
  ['extraction', 'Extract & drafts'],
  ['seed-gen', 'Generate seeds'],
  ['harvest', 'Harvest'],
  ['preview', 'Preview'],
  ['stats', 'Stats'],
  ['logs', 'Logs'],
];

const matches = (row, q) => !q || JSON.stringify(row).toLowerCase().includes(q.toLowerCase());

export default function App() {
  const [tab, setTab] = useState('library');
  const [boot, setBoot] = useState(null);
  const [validation, setValidation] = useState(null);
  const [stats, setStats] = useState(null);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ category: '', rarity: '', mode: '' });
  const [editing, setEditing] = useState(undefined);   // undefined = closed, null = new
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      setBoot(await api.getBootstrap());
    } catch (err) {
      setToast({ kind: 'error', text: `Could not reach the admin API: ${err.message}` });
    }
  }, []);

  const revalidate = useCallback(async () => {
    try {
      setValidation(await api.getValidation());
      setStats(await api.getStats());
    } catch { /* advisory only - a failure here must not block editing */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (boot) revalidate(); }, [boot, revalidate]);

  const patch = (next) => setBoot((b) => ({ ...b, ...next }));

  // Every write goes through here so the conflict path is handled in one place:
  // if the file moved under us the server refuses, and we ask rather than
  // deciding on the user's behalf whether their version wins.
  const save = async (fn, describe) => {
    setBusy(true);
    try {
      const res = await fn(false);
      setToast({ kind: 'ok', text: `${describe}${res.backup ? ` (previous version kept as ${res.backup})` : ''}` });
      return res;
    } catch (err) {
      if (err.status === 409) {
        const go = window.confirm(`${err.message}\n\nOverwrite what is on disk with your version?`);
        if (go) {
          const res = await fn(true);
          setToast({ kind: 'warn', text: `${describe} - overwrote a newer file on disk` });
          return res;
        }
        setToast({ kind: 'warn', text: 'Not saved. Reload to see what changed.' });
        return null;
      }
      setToast({ kind: 'error', text: err.problems ? `${err.message}: ${err.problems.join('; ')}` : err.message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const afterWrite = (kind, res) => {
    if (!res) return;
    if (kind === 'library') patch({ library: res.data, libraryVersion: res.version });
    else patch({ seeds: res.data, seedsVersion: res.version });
    setEditing(undefined);
    revalidate();
  };

  // The two draft queues are shared with extraction and bulk generation, so
  // the Harvest tab's badge counts only the rows this feature put there.
  const harvestedWaiting = useMemo(
    () => (boot
      ? [...boot.drafts, ...boot.seedDrafts].filter((d) => d.source === 'harvested').length
      : 0),
    [boot],
  );

  const rows = useMemo(() => {
    if (!boot) return [];
    const source = tab === 'seeds' ? boot.seeds : boot.library;
    return source.filter((r) => matches(r, query)
      && (!filters.category || r.category === filters.category)
      && (!filters.rarity || r.rarity === filters.rarity)
      && (!filters.mode || (r.modes || []).includes(filters.mode)));
  }, [boot, tab, query, filters]);

  if (!boot) {
    return (
      <main className="admin">
        <p className="muted">{toast ? toast.text : 'Loading...'}</p>
      </main>
    );
  }

  const listCols = tab === 'seeds'
    ? [
      { key: 'id', label: 'id' },
      { key: 'stages', label: 'stages', render: (r) => (r.stages || []).join(', ') },
      { key: 'life_stage', label: 'ages', render: (r) => (r.life_stage || []).join('-') },
      { key: 'modes', label: 'modes', render: (r) => (r.modes || []).join('/') },
      { key: 'weight', label: 'weight' },
      { key: 'prompt', label: 'prompt', render: (r) => (r.prompt || '').slice(0, 70) + '...' },
    ]
    : [
      { key: 'id', label: 'id' },
      { key: 'category', label: 'category' },
      { key: 'life_stage', label: 'life_stage', render: (r) => (r.life_stage || []).join('-') },
      { key: 'modes', label: 'modes', render: (r) => (r.modes || []).join('/') },
      { key: 'rarity', label: 'rarity' },
      { key: 'requires', label: 'requires', render: (r) => (r.requires || []).join(', ') || '-' },
      { key: 'excludes', label: 'excludes', render: (r) => (r.excludes || []).join(', ') || '-' },
    ];

  const saveLibrary = async (record) => afterWrite('library', await save(
    (force) => (editing
      ? api.updateRecord('library', editing.id, record, boot.libraryVersion, force)
      : api.createRecord('library', record, boot.libraryVersion, force)),
    editing ? `Saved ${record.id}` : `Created ${record.id}`,
  ));

  const saveSeed = async (record) => afterWrite('seeds', await save(
    (force) => (editing
      ? api.updateRecord('seeds', editing.id, record, boot.seedsVersion, force)
      : api.createRecord('seeds', record, boot.seedsVersion, force)),
    editing ? `Saved ${record.id}` : `Created ${record.id}`,
  ));

  const remove = async (kind, record) => {
    if (!window.confirm(`Delete ${kind === 'library' ? 'pattern' : 'scenario'} "${record.id}"?`)) return;
    const version = kind === 'library' ? boot.libraryVersion : boot.seedsVersion;
    afterWrite(kind, await save(
      (force) => api.deleteRecord(kind, record.id, version, force),
      `Deleted ${record.id}`,
    ));
  };

  // The Name Pool tab manages its own filters/selection/editing state
  // locally (it is not a row-in-a-list-that-opens-a-shared-Modal like
  // library/seeds), and only calls up here for the network round trip - the
  // same conflict handling (`save`) and toast every other write in this app
  // gets, plus patching boot state on success.
  const saveNamePoolEntry = async (prevName, record) => {
    const res = await save(
      (force) => (prevName
        ? api.updateNamePoolEntry(prevName, record, boot.namePoolVersion, force)
        : api.createNamePoolEntry(record, boot.namePoolVersion, force)),
      prevName ? `Saved ${record.name}` : `Created ${record.name}`,
    );
    if (!res) return false;
    patch({ namePool: res.data, namePoolVersion: res.version });
    return true;
  };

  const deleteNamePoolEntry = async (record) => {
    if (!window.confirm(`Delete name "${record.name}"?`)) return false;
    const res = await save(
      (force) => api.deleteNamePoolEntry(record.name, boot.namePoolVersion, force),
      `Deleted ${record.name}`,
    );
    if (!res) return false;
    patch({ namePool: res.data, namePoolVersion: res.version });
    return true;
  };

  const bulkSetNameActive = async (names, active) => {
    const res = await save(
      (force) => api.bulkSetNameActive(names, active, boot.namePoolVersion, force),
      `${active ? 'Activated' : 'Deactivated'} ${names.length} name${names.length === 1 ? '' : 's'}`,
    );
    if (!res) return false;
    patch({ namePool: res.data, namePoolVersion: res.version });
    return true;
  };

  const addGroupControl = async (kind, value, reason) => {
    const res = await save(
      (force) => api.addGroupControl(kind, value, reason, boot.nameControlsVersion, force),
      `Deactivated ${value}`,
    );
    if (!res) return false;
    patch({ nameControls: res.data, nameControlsVersion: res.version });
    return true;
  };

  const removeGroupControl = async (kind, value) => {
    const res = await save(
      (force) => api.removeGroupControl(kind, value, boot.nameControlsVersion, force),
      `Reactivated ${value}`,
    );
    if (!res) return false;
    patch({ nameControls: res.data, nameControlsVersion: res.version });
    return true;
  };

  // The storyteller toggle. Not routed through `save`: there is no content
  // file and no version behind it, so the conflict path does not apply - a
  // failed switch (Ollama down, model not pulled, no key) is just its error
  // message, and the server keeps whichever provider was already active.
  const switchProvider = async (name) => {
    setBusy(true);
    try {
      const status = await api.setProvider(name);
      patch({ provider: status, llmEnabled: true, model: status.model });
      setToast({ kind: 'ok', text: `Storyteller is now ${status.model} (${status.provider}) - server-wide, reverts to LLM_PROVIDER on restart` });
    } catch (err) {
      setToast({ kind: 'error', text: `Could not switch storyteller: ${err.message}` });
    } finally {
      setBusy(false);
    }
  };

  const bulkSetGroupControlActive = async (kind, values, active, reason) => {
    const res = await save(
      (force) => api.bulkSetGroupControlActive(kind, values, active, reason, boot.nameControlsVersion, force),
      `${active ? 'Reactivated' : 'Deactivated'} ${values.length}`,
    );
    if (!res) return false;
    patch({ nameControls: res.data, nameControlsVersion: res.version });
    return true;
  };

  return (
    <main className="admin">
      <header className="admin__head">
        <h1>Life Swipe <span className="muted">content admin</span></h1>
        <span
          className="badge"
          title="No authentication. The server binds to 127.0.0.1, which is the only thing keeping this private."
        >
          localhost only &middot; no auth
        </span>
        <ProviderToggle status={boot.provider} busy={busy} onSwitch={switchProvider} />
        <nav className="tabs">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? 'is-on' : ''}
              onClick={() => { setTab(key); setEditing(undefined); }}
            >
              {label}
              {key === 'extraction' && boot.drafts.length > 0 && <span className="count">{boot.drafts.length}</span>}
              {key === 'seed-gen' && boot.seedDrafts.length > 0 && <span className="count">{boot.seedDrafts.length}</span>}
              {key === 'harvest' && harvestedWaiting > 0 && <span className="count">{harvestedWaiting}</span>}
            </button>
          ))}
        </nav>
      </header>

      {toast && <div className={`toast toast--${toast.kind} admin__toast-standalone`} onClick={() => setToast(null)}>{toast.text}</div>}

      {(tab === 'library' || tab === 'seeds') && <Warnings result={validation} onRefresh={revalidate} />}

      {(tab === 'library' || tab === 'seeds') && (
        <div className="pane">
          <section className="card">
            <div className="toolbar">
              <input
                className="search"
                placeholder="search everything..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {tab === 'library' && (
                <>
                  <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}>
                    <option value="">all categories</option>
                    {boot.vocab.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select value={filters.rarity} onChange={(e) => setFilters((f) => ({ ...f, rarity: e.target.value }))}>
                    <option value="">all rarities</option>
                    {boot.vocab.rarities.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </>
              )}
              <select value={filters.mode} onChange={(e) => setFilters((f) => ({ ...f, mode: e.target.value }))}>
                <option value="">all modes</option>
                {boot.vocab.modes.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="spacer" />
              <span className="muted small">{rows.length} of {(tab === 'seeds' ? boot.seeds : boot.library).length}</span>
              <button className="btn btn--primary" onClick={() => setEditing(null)}>New</button>
            </div>

            <Table
              columns={listCols}
              rows={rows}
              onSelect={(r) => setEditing(r)}
              selectedId={editing && editing.id}
            />
          </section>

          {editing !== undefined && (
            <Modal
              title={editing ? `Editing ${editing.id}` : tab === 'library' ? 'New pattern' : 'New scenario'}
              onClose={() => setEditing(undefined)}
            >
              {tab === 'library' ? (
                <PatternForm
                  value={editing}
                  vocab={boot.vocab}
                  siblings={boot.library}
                  busy={busy}
                  onCancel={() => setEditing(undefined)}
                  onSave={saveLibrary}
                  onDelete={(record) => remove('library', record)}
                />
              ) : (
                <SeedForm
                  value={editing}
                  busy={busy}
                  onCancel={() => setEditing(undefined)}
                  onSave={saveSeed}
                  onDelete={(record) => remove('seeds', record)}
                />
              )}
            </Modal>
          )}
        </div>
      )}

      {tab === 'names' && (
        <NamePool
          namePool={boot.namePool}
          nameControls={boot.nameControls}
          genderAssocs={boot.vocab.nameGenderAssocs}
          busy={busy}
          onSaveEntry={saveNamePoolEntry}
          onDeleteEntry={deleteNamePoolEntry}
          onBulkActive={bulkSetNameActive}
          onAddGroupControl={addGroupControl}
          onRemoveGroupControl={removeGroupControl}
          onBulkGroupControlActive={bulkSetGroupControlActive}
        />
      )}

      {tab === 'extraction' && (
        <Extraction
          drafts={boot.drafts}
          library={boot.library}
          vocab={boot.vocab}
          llmEnabled={boot.llmEnabled}
          onChanged={(next) => { patch(next); revalidate(); }}
        />
      )}

      {tab === 'seed-gen' && (
        <SeedGeneration
          seedDrafts={boot.seedDrafts}
          llmEnabled={boot.llmEnabled}
          onChanged={(next) => { patch(next); revalidate(); }}
        />
      )}

      {tab === 'harvest' && (
        <Harvest
          seedDrafts={boot.seedDrafts}
          drafts={boot.drafts}
          library={boot.library}
          vocab={boot.vocab}
          llmEnabled={boot.llmEnabled}
          defaults={boot.harvestDefaults}
          onChanged={(next) => { patch(next); revalidate(); }}
        />
      )}

      {tab === 'preview' && (
        <Preview
          library={boot.library}
          seeds={boot.seeds}
          regions={boot.regions}
          llmEnabled={boot.llmEnabled}
        />
      )}

      {tab === 'stats' && <Stats stats={stats} />}
      {tab === 'logs' && <Logs />}
    </main>
  );
}
