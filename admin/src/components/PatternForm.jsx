import React, { useEffect, useState } from 'react';

const BLANK = {
  id: '', pattern: '', category: 'career', life_stage: [20, 30], modes: ['safe'],
  requires: [], excludes: [], typical_effects: '', rarity: 'uncommon', note: '',
};

const asList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const asText = (v) => (Array.isArray(v) ? v.join(', ') : '');

/**
 * The pattern editor. Validation mirrors what the server enforces, so problems
 * surface while typing rather than on save - but the server checks again, and
 * the server is the authority.
 */
export default function PatternForm({ value, vocab, siblings, onSave, onDelete, onCancel, busy }) {
  const [draft, setDraft] = useState(value || BLANK);
  const [problems, setProblems] = useState([]);
  useEffect(() => { setDraft(value || BLANK); setProblems([]); }, [value]);

  const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }));
  const isNew = !value;

  const check = () => {
    const found = [];
    if (!/^[a-z0-9_]+$/.test(draft.id || '')) found.push('id must be snake_case (a-z, 0-9, underscore)');
    if (siblings.some((s) => s.id === draft.id && s !== value)) found.push(`id "${draft.id}" is already used`);
    if ((draft.pattern || '').length < 20) found.push('pattern must be a full sentence (20+ characters)');
    const [lo, hi] = draft.life_stage || [];
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo && lo >= 0)) {
      found.push('life_stage must be [min, max] with max greater than min');
    }
    if (!draft.modes?.length) found.push('modes must include at least one of safe / mature');
    if (!vocab.categories.includes(draft.category)) {
      found.push(`category "${draft.category}" is not in the vocabulary — pick one of ${vocab.categories.join(', ')}`);
    }
    if (!(draft.typical_effects || '').trim()) found.push('typical_effects is required — it is the storyteller’s brief');
    setProblems(found);
    return found.length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (!check()) return;
    const clean = { ...draft };
    for (const key of ['requires', 'excludes']) if (!clean[key]?.length) delete clean[key];
    if (!clean.note) delete clean.note;
    onSave(clean);
  };

  return (
    <form className="form" onSubmit={submit}>
      <h3>{isNew ? 'New pattern' : `Editing ${value.id}`}</h3>

      <label>id
        <input value={draft.id} onChange={(e) => set('id', e.target.value)} placeholder="snake_case_id" />
      </label>

      <label>pattern <span className="muted small">one anonymous sentence describing the shape</span>
        <textarea rows={3} value={draft.pattern} onChange={(e) => set('pattern', e.target.value)} />
      </label>

      <div className="row">
        <label>category
          <select value={draft.category} onChange={(e) => set('category', e.target.value)}>
            {/* A draft can arrive with a category the model invented. A
                controlled select whose value matches no option renders BLANK,
                which hides exactly the field the reviewer needs to fix - so
                the stray value gets a visible, unpickable option instead. */}
            {!vocab.categories.includes(draft.category) && (
              <option value={draft.category} disabled>{draft.category} (not in vocabulary)</option>
            )}
            {vocab.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>rarity
          <select value={draft.rarity} onChange={(e) => set('rarity', e.target.value)}>
            {vocab.rarities.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label>life_stage min
          <input type="number" value={draft.life_stage?.[0] ?? ''}
            onChange={(e) => set('life_stage', [Number(e.target.value), draft.life_stage?.[1] ?? 0])} />
        </label>
        <label>life_stage max
          <input type="number" value={draft.life_stage?.[1] ?? ''}
            onChange={(e) => set('life_stage', [draft.life_stage?.[0] ?? 0, Number(e.target.value)])} />
        </label>
      </div>

      <fieldset className="modes">
        <legend>modes</legend>
        {vocab.modes.map((m) => (
          <label key={m} className="check">
            <input
              type="checkbox"
              checked={draft.modes?.includes(m) || false}
              onChange={(e) => set('modes', e.target.checked
                ? [...(draft.modes || []), m]
                : (draft.modes || []).filter((x) => x !== m))}
            />
            {m}
          </label>
        ))}
      </fieldset>

      <div className="row">
        <label>requires <span className="muted small">comma-separated flags</span>
          <input value={asText(draft.requires)} onChange={(e) => set('requires', asList(e.target.value))} />
        </label>
        <label>excludes <span className="muted small">comma-separated flags</span>
          <input value={asText(draft.excludes)} onChange={(e) => set('excludes', asList(e.target.value))} />
        </label>
      </div>

      <label>typical_effects <span className="muted small">the brief: effect shape, pending events, branch points</span>
        <textarea rows={4} value={draft.typical_effects} onChange={(e) => set('typical_effects', e.target.value)} />
      </label>

      <label>note <span className="muted small">optional authoring guidance</span>
        <textarea rows={2} value={draft.note || ''} onChange={(e) => set('note', e.target.value)} />
      </label>

      {problems.length > 0 && (
        <ul className="problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
      )}

      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Saving…' : isNew ? 'Create' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        {!isNew && (
          <button type="button" className="btn btn--danger" onClick={() => onDelete(value)} disabled={busy}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
