import React, { useEffect, useState } from 'react';

const blank = () => ({
  name: '', category: '', gender_assoc: 'neutral', active: true,
  era_start: new Date().getFullYear() - 40, era_end: '',
});

const REGION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
const toRows = (rf) => Object.entries(rf || {}).map(([code, weight]) => ({ code, weight: String(weight) }));

/**
 * Create/edit one name-pool entry. The region_frequency editor is a plain
 * add/remove list rather than a field per possible region: absence of a
 * region means no signal, not zero, so a form that made every region
 * explicit would misrepresent the data model it edits.
 */
export default function NamePoolForm({ value, genderAssocs, categories, busy, onSave, onDelete, onCancel }) {
  const [draft, setDraft] = useState(value || blank());
  const [regionRows, setRegionRows] = useState(toRows(value?.region_frequency));
  const [problems, setProblems] = useState([]);

  useEffect(() => {
    setDraft(value || blank());
    setRegionRows(toRows(value?.region_frequency));
    setProblems([]);
  }, [value]);

  const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }));
  const isNew = !value;

  const setRegionRow = (i, patch) => setRegionRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRegionRow = (i) => setRegionRows((rows) => rows.filter((_, idx) => idx !== i));
  const addRegionRow = () => setRegionRows((rows) => [...rows, { code: '', weight: '1' }]);

  const submit = (e) => {
    e.preventDefault();
    const found = [];
    const name = (draft.name || '').trim();
    const category = (draft.category || '').trim();
    if (!name) found.push('name is required');
    if (!category) found.push('category is required');
    if (!genderAssocs.includes(draft.gender_assoc)) found.push(`gender_assoc must be one of ${genderAssocs.join(', ')}`);

    const eraStart = Number(draft.era_start);
    if (!Number.isFinite(eraStart)) found.push('era_start must be a number');
    const eraEndRaw = draft.era_end;
    const eraEnd = (eraEndRaw === '' || eraEndRaw === undefined || eraEndRaw === null) ? null : Number(eraEndRaw);
    if (eraEnd !== null && (!Number.isFinite(eraEnd) || eraEnd <= eraStart)) found.push('era_end must be a number after era_start');

    const regionFrequency = {};
    for (const row of regionRows) {
      if (!row.code.trim() && !row.weight.trim()) continue; // a fully-blank row is just unfinished, not an error
      const code = row.code.trim().toUpperCase();
      const weight = Number(row.weight);
      if (!REGION_RE.test(code)) found.push(`bad region code "${row.code}"`);
      else if (!(weight > 0)) found.push(`${code}: weight must be a positive number`);
      else regionFrequency[code] = weight;
    }

    setProblems(found);
    if (found.length) return;

    const record = {
      name, category, gender_assoc: draft.gender_assoc, active: draft.active !== false, era_start: eraStart,
    };
    if (eraEnd !== null) record.era_end = eraEnd;
    if (Object.keys(regionFrequency).length) record.region_frequency = regionFrequency;
    onSave(record);
  };

  return (
    <form className="form" onSubmit={submit}>
      <h3>{isNew ? 'New name' : `Editing ${value.name}`}</h3>

      <div className="row">
        <label>name<input value={draft.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>category <span className="muted small">cultural / linguistic origin</span>
          <input value={draft.category} onChange={(e) => set('category', e.target.value)} list="name-pool-categories" />
          <datalist id="name-pool-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>
        <label>gender_assoc
          <select value={draft.gender_assoc} onChange={(e) => set('gender_assoc', e.target.value)}>
            {genderAssocs.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
      </div>

      <div className="row">
        <label>era_start<input type="number" value={draft.era_start ?? ''} onChange={(e) => set('era_start', e.target.value)} /></label>
        <label>era_end <span className="muted small">blank = still in use today</span>
          <input type="number" value={draft.era_end ?? ''} onChange={(e) => set('era_end', e.target.value)} />
        </label>
        <label className="check-group">
          <span className="check">
            <input type="checkbox" checked={draft.active !== false} onChange={(e) => set('active', e.target.checked)} />
            active
          </span>
        </label>
      </div>

      <fieldset className="modes">
        <legend>region_frequency</legend>
        <p className="muted small">
          Bulk regional data comes from <code>npm run build-region-weights</code> against real SSA
          birth records — use this editor for one-off additions or corrections, not as the primary
          way to populate regional weights. A region with no row here means no signal, not zero.
        </p>
        {regionRows.map((row, i) => (
          <div className="row" key={i}>
            <label>region code
              <input value={row.code} placeholder="US-MN" onChange={(e) => setRegionRow(i, { code: e.target.value })} />
            </label>
            <label>weight <span className="muted small">location quotient, e.g. 2.4</span>
              <input type="number" step="0.01" value={row.weight} onChange={(e) => setRegionRow(i, { weight: e.target.value })} />
            </label>
            <button type="button" className="btn btn--danger" onClick={() => removeRegionRow(i)}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn" onClick={addRegionRow}>Add region</button>
      </fieldset>

      {problems.length > 0 && <ul className="problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}

      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Saving…' : isNew ? 'Create' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        {!isNew && (
          <button type="button" className="btn btn--danger" onClick={() => onDelete(value)} disabled={busy}>Delete</button>
        )}
      </div>
    </form>
  );
}
