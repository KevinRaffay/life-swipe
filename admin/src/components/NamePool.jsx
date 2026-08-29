import React, { useMemo, useState } from 'react';
import Table from './Table.jsx';
import Modal from './Modal.jsx';
import NamePoolForm from './NamePoolForm.jsx';
import GroupControls from './GroupControls.jsx';
import NamePoolHealth from './NamePoolHealth.jsx';

const STATUS_OPTIONS = [
  ['', 'all statuses'],
  ['active', 'active'],
  ['inactive', 'inactive'],
  ['excluded', 'active but pool-wide excluded'],
];

/** Is this name excluded pool-wide by a category or gender_assoc control,
 *  independent of its own `active` flag? */
const isExcludedByGroup = (entry, deactivatedCategories, deactivatedGenderAssocs) =>
  deactivatedCategories.has(entry.category) || deactivatedGenderAssocs.has(entry.gender_assoc);

export default function NamePool({
  namePool, nameControls, genderAssocs, busy,
  onSaveEntry, onDeleteEntry, onBulkActive, onAddGroupControl, onRemoveGroupControl,
}) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ category: '', genderAssoc: '', status: '', eraFrom: '', eraTo: '' });
  const [selected, setSelected] = useState(() => new Set());
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new
  const [healthTick, setHealthTick] = useState(0);
  const bump = () => setHealthTick((t) => t + 1);

  const deactivatedCategories = useMemo(
    () => new Set((nameControls.deactivatedCategories || []).map((c) => c.category)),
    [nameControls],
  );
  const deactivatedGenderAssocs = useMemo(
    () => new Set((nameControls.deactivatedGenderAssocs || []).map((g) => g.genderAssoc)),
    [nameControls],
  );
  const deactivatedRegions = useMemo(
    () => new Set((nameControls.deactivatedRegions || []).map((r) => r.region)),
    [nameControls],
  );

  const categories = useMemo(
    () => [...new Set(namePool.map((e) => e.category))].sort(),
    [namePool],
  );
  const regionsInUse = useMemo(() => {
    const codes = new Set();
    for (const e of namePool) for (const code of Object.keys(e.region_frequency || {})) codes.add(code);
    return [...codes].sort();
  }, [namePool]);

  const effectiveActive = (entry) => entry.active !== false && !isExcludedByGroup(entry, deactivatedCategories, deactivatedGenderAssocs);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return namePool.filter((e) => {
      if (q && !e.name.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) return false;
      if (filters.category && e.category !== filters.category) return false;
      if (filters.genderAssoc && e.gender_assoc !== filters.genderAssoc) return false;
      if (filters.eraFrom && (e.era_end ?? Infinity) < Number(filters.eraFrom)) return false;
      if (filters.eraTo && e.era_start > Number(filters.eraTo)) return false;
      const raw = e.active !== false;
      const eff = effectiveActive(e);
      if (filters.status === 'active' && !raw) return false;
      if (filters.status === 'inactive' && raw) return false;
      if (filters.status === 'excluded' && !(raw && !eff)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namePool, query, filters, deactivatedCategories, deactivatedGenderAssocs]);

  const toggleSelect = (name, checked) => setSelected((s) => {
    const next = new Set(s);
    if (checked) next.add(name); else next.delete(name);
    return next;
  });
  const selectAllMatching = () => setSelected(new Set(filteredRows.map((r) => r.name)));
  const clearSelection = () => setSelected(new Set());

  const bulkAction = async (active) => {
    const names = [...selected];
    if (!names.length) return;
    const ok = await onBulkActive(names, active);
    if (ok) { clearSelection(); bump(); }
  };

  const saveEntry = async (record) => {
    const prevName = editing ? editing.name : null;
    const ok = await onSaveEntry(prevName, record);
    if (ok) { setEditing(undefined); bump(); }
  };
  const deleteEntry = async (record) => {
    const ok = await onDeleteEntry(record);
    if (ok) { setEditing(undefined); bump(); }
  };
  const deactivateGroup = async (kind, value, reason) => {
    const ok = await onAddGroupControl(kind, value, reason);
    if (ok) bump();
    return ok;
  };
  const reactivateGroup = async (kind, value) => {
    const ok = await onRemoveGroupControl(kind, value);
    if (ok) bump();
  };

  const categoryRegionNote = (category) => {
    const codes = new Set();
    for (const e of namePool) if (e.category === category) for (const code of Object.keys(e.region_frequency || {})) codes.add(code);
    if (!codes.size) return 'Carries no regional weighting data.';
    const list = [...codes].sort();
    const shown = list.slice(0, 6);
    const more = list.length - shown.length;
    return `Also carries regional weighting for: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}.`;
  };

  const columns = [
    {
      key: '_select',
      label: '',
      value: () => 0,
      render: (r) => (
        <input
          type="checkbox"
          checked={selected.has(r.name)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => toggleSelect(r.name, e.target.checked)}
        />
      ),
    },
    { key: 'name', label: 'name' },
    { key: 'category', label: 'category' },
    { key: 'gender_assoc', label: 'gender' },
    {
      key: 'era', label: 'era',
      value: (r) => r.era_start,
      render: (r) => `${r.era_start}–${r.era_end ?? 'now'}`,
    },
    {
      key: 'regions', label: 'regions',
      value: (r) => Object.keys(r.region_frequency || {}).length,
      render: (r) => {
        const n = Object.keys(r.region_frequency || {}).length;
        return n ? `${n} region${n === 1 ? '' : 's'} weighted` : 'no regional data';
      },
    },
    {
      key: 'status', label: 'status',
      value: (r) => (r.active !== false ? 1 : 0),
      render: (r) => {
        const raw = r.active !== false;
        const eff = effectiveActive(r);
        return (
          <span>
            <span className={`pill ${raw ? 'pill--passed' : 'pill--failed'}`}>{raw ? 'active' : 'inactive'}</span>
            {raw && !eff && (
              <span className="pill pill--fell_back_to_seed" title="Individually active, but excluded pool-wide by a category or gender_assoc control.">
                {' '}excluded
              </span>
            )}
          </span>
        );
      },
    },
  ];

  const tableRows = filteredRows.map((e) => ({ ...e, id: e.name }));

  return (
    <div className="pane">
      <NamePoolHealth refreshKey={healthTick} />

      <section className="card">
        <div className="toolbar">
          <input
            className="search"
            placeholder="search name or category..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}>
            <option value="">all categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filters.genderAssoc} onChange={(e) => setFilters((f) => ({ ...f, genderAssoc: e.target.value }))}>
            <option value="">all genders</option>
            {genderAssocs.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            {STATUS_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <input
            style={{ maxWidth: 90 }}
            type="number" placeholder="era from"
            value={filters.eraFrom}
            onChange={(e) => setFilters((f) => ({ ...f, eraFrom: e.target.value }))}
          />
          <input
            style={{ maxWidth: 90 }}
            type="number" placeholder="era to"
            value={filters.eraTo}
            onChange={(e) => setFilters((f) => ({ ...f, eraTo: e.target.value }))}
          />
          <span className="spacer" />
          <span className="muted small">{filteredRows.length} of {namePool.length}</span>
          <button className="btn btn--primary" onClick={() => setEditing(null)}>New</button>
        </div>

        <div className="toolbar">
          <button className="btn" onClick={selectAllMatching} disabled={!filteredRows.length}>
            Select all matching filter ({filteredRows.length})
          </button>
          <span className="muted small">{selected.size} selected</span>
          <span className="spacer" />
          <button className="btn" onClick={() => bulkAction(true)} disabled={busy || !selected.size}>Activate selected</button>
          <button className="btn btn--danger" onClick={() => bulkAction(false)} disabled={busy || !selected.size}>Deactivate selected</button>
          {selected.size > 0 && <button className="link" onClick={clearSelection}>clear</button>}
        </div>

        <Table
          columns={columns}
          rows={tableRows}
          onSelect={(r) => setEditing(namePool.find((e) => e.name === r.name) || null)}
          selectedId={editing ? editing.name : undefined}
        />

        {editing !== undefined && (
          <Modal title={editing ? `Editing ${editing.name}` : 'New name'} onClose={() => setEditing(undefined)}>
            <NamePoolForm
              value={editing}
              genderAssocs={genderAssocs}
              categories={categories}
              busy={busy}
              onCancel={() => setEditing(undefined)}
              onSave={saveEntry}
              onDelete={deleteEntry}
            />
          </Modal>
        )}
      </section>

      <GroupControls
        title="Category controls"
        description="Deactivating a category excludes every name in it from selection pool-wide, regardless of each name's own active flag."
        rows={categories.map((c) => ({
          value: c,
          count: namePool.filter((e) => e.category === c).length,
          deactivated: (nameControls.deactivatedCategories || []).find((d) => d.category === c) || null,
        }))}
        note={categoryRegionNote}
        busy={busy}
        onDeactivate={(value, reason) => deactivateGroup('categories', value, reason)}
        onReactivate={(value) => reactivateGroup('categories', value)}
      />

      <GroupControls
        title="Region controls"
        description="Deactivating a region does not remove any names - it turns off that region's contribution to the weighting dimension, treating a resolved player region as no signal (exactly like the existing absent-region case)."
        rows={regionsInUse.map((code) => ({
          value: code,
          count: namePool.filter((e) => e.region_frequency && Number.isFinite(e.region_frequency[code])).length,
          deactivated: (nameControls.deactivatedRegions || []).find((d) => d.region === code) || null,
        }))}
        busy={busy}
        onDeactivate={(value, reason) => deactivateGroup('regions', value, reason)}
        onReactivate={(value) => reactivateGroup('regions', value)}
      />

      <GroupControls
        title="Gender association controls"
        description="Deactivating a gender_assoc excludes every name carrying it from selection pool-wide."
        rows={genderAssocs.map((g) => ({
          value: g,
          count: namePool.filter((e) => e.gender_assoc === g).length,
          deactivated: (nameControls.deactivatedGenderAssocs || []).find((d) => d.genderAssoc === g) || null,
        }))}
        busy={busy}
        onDeactivate={(value, reason) => deactivateGroup('gender-assocs', value, reason)}
        onReactivate={(value) => reactivateGroup('gender-assocs', value)}
      />
    </div>
  );
}
