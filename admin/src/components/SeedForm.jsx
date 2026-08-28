import React, { useEffect, useState } from 'react';

const BLANK = {
  id: '', stages: ['highschool'], modes: ['safe', 'mature'], weight: 'minor',
  life_stage: [16, 18], prompt: '', leftLabel: '', rightLabel: '',
  leftEffects: {}, rightEffects: {},
};

const STAGES = ['highschool', 'college', 'early', 'family', 'late', 'retirement'];
const WEIGHTS = ['minor', 'standard', 'major'];
const asList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Seed cards carry effect objects, which are too free-form for individual
 * inputs without inventing a second schema. The narrative and gating fields get
 * real controls; the two effect objects are edited as JSON and parsed here, so
 * the server's validateScenario stays the only authority on their shape.
 */
export default function SeedForm({ value, onSave, onDelete, onCancel, busy }) {
  const [draft, setDraft] = useState(value || BLANK);
  const [effects, setEffects] = useState({ left: '{}', right: '{}' });
  const [problems, setProblems] = useState([]);

  useEffect(() => {
    const v = value || BLANK;
    setDraft(v);
    setEffects({
      left: JSON.stringify(v.leftEffects ?? {}, null, 2),
      right: JSON.stringify(v.rightEffects ?? {}, null, 2),
    });
    setProblems([]);
  }, [value]);

  const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }));
  const isNew = !value;

  const submit = (e) => {
    e.preventDefault();
    const found = [];
    let left = {}; let right = {};
    try { left = JSON.parse(effects.left || '{}'); } catch (err) { found.push('leftEffects is not valid JSON: ' + err.message); }
    try { right = JSON.parse(effects.right || '{}'); } catch (err) { found.push('rightEffects is not valid JSON: ' + err.message); }
    if (!/^[a-z0-9_]+$/i.test(draft.id || '')) found.push('id is required');
    if (!draft.prompt?.trim()) found.push('prompt is required');
    if (!draft.leftLabel?.trim() || !draft.rightLabel?.trim()) found.push('both choice labels are required');
    setProblems(found);
    if (found.length) return;
    onSave({ ...draft, leftEffects: left, rightEffects: right });
  };

  return (
    <form className="form" onSubmit={submit}>
      <h3>{isNew ? 'New scenario' : `Editing ${value.id}`}</h3>

      <div className="row">
        <label>id<input value={draft.id} onChange={(e) => set('id', e.target.value)} /></label>
        <label>weight
          <select value={draft.weight} onChange={(e) => set('weight', e.target.value)}>
            {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
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
        <legend>stages</legend>
        {STAGES.map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={draft.stages?.includes(s) || false}
              onChange={(e) => set('stages', e.target.checked
                ? [...(draft.stages || []), s] : (draft.stages || []).filter((x) => x !== s))} />
            {s}
          </label>
        ))}
      </fieldset>

      <fieldset className="modes">
        <legend>modes</legend>
        {['safe', 'mature'].map((m) => (
          <label key={m} className="check">
            <input type="checkbox" checked={draft.modes?.includes(m) || false}
              onChange={(e) => set('modes', e.target.checked
                ? [...(draft.modes || []), m] : (draft.modes || []).filter((x) => x !== m))} />
            {m}
          </label>
        ))}
      </fieldset>

      <label>setting <span className="muted small">standard and major only</span>
        <input value={draft.setting || ''} onChange={(e) => set('setting', e.target.value)} />
      </label>
      <label>beat <span className="muted small">major only</span>
        <input value={draft.beat || ''} onChange={(e) => set('beat', e.target.value)} />
      </label>
      <label>dialogue <span className="muted small">major only, one exchange</span>
        <input value={draft.dialogue || ''} onChange={(e) => set('dialogue', e.target.value)} />
      </label>
      <label>prompt <span className="muted small">the decision itself, always present</span>
        <textarea rows={3} value={draft.prompt || ''} onChange={(e) => set('prompt', e.target.value)} />
      </label>

      <div className="row">
        <label>leftLabel<input value={draft.leftLabel || ''} onChange={(e) => set('leftLabel', e.target.value)} /></label>
        <label>rightLabel<input value={draft.rightLabel || ''} onChange={(e) => set('rightLabel', e.target.value)} /></label>
      </div>

      <div className="row">
        <label>leftEffects (JSON)
          <textarea rows={7} className="mono" value={effects.left}
            onChange={(e) => setEffects((s) => ({ ...s, left: e.target.value }))} />
        </label>
        <label>rightEffects (JSON)
          <textarea rows={7} className="mono" value={effects.right}
            onChange={(e) => setEffects((s) => ({ ...s, right: e.target.value }))} />
        </label>
      </div>

      <div className="row">
        <label>requiresFlags <span className="muted small">comma-separated</span>
          <input value={(draft.requiresFlags || []).join(', ')}
            onChange={(e) => set('requiresFlags', asList(e.target.value))} />
        </label>
        <label>forbidsFlags <span className="muted small">comma-separated</span>
          <input value={(draft.forbidsFlags || []).join(', ')}
            onChange={(e) => set('forbidsFlags', asList(e.target.value))} />
        </label>
      </div>

      {problems.length > 0 && <ul className="problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}

      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Saving…' : isNew ? 'Create' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        {!isNew && <button type="button" className="btn btn--danger" onClick={() => onDelete(value)} disabled={busy}>Delete</button>}
      </div>
    </form>
  );
}
