import React, { useState } from 'react';
import * as api from '../api.js';

const PRESENT_YEAR = 2026;
const START_AGE = 16;

/**
 * Live preview against the real generation path.
 *
 * Nothing here can reach a player: the sample state is built in memory by the
 * server, names resolve through the ephemeral path, and no file is written.
 * Unlike the game, this keeps the cards that FAIL validation and shows why —
 * which is the entire reason to look at it while authoring.
 */
export default function Preview({ library, seeds, regions, llmEnabled }) {
  const [kind, setKind] = useState('pattern');
  const [id, setId] = useState('');
  const [sample, setSample] = useState({
    age: 24, money: 5000, health: 80, happiness: 65, contentMode: 'safe', flags: '',
  });
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const set = (k, v) => setSample((s) => ({ ...s, [k]: v }));
  const year = PRESENT_YEAR + (Number(sample.age) || START_AGE) - START_AGE;

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await api.preview({
        kind,
        id: id || null,
        region: region || null,
        sample: { ...sample, flags: sample.flags.split(',').map((f) => f.trim()).filter(Boolean) },
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <section className="card">
        <h2>Live preview</h2>
        <div className="row">
          <label>source
            <select value={kind} onChange={(e) => { setKind(e.target.value); setId(''); setResult(null); }}>
              <option value="pattern">library pattern (generates)</option>
              <option value="seed">seed scenario (validates + clamps)</option>
            </select>
          </label>
          <label>{kind === 'pattern' ? 'pattern' : 'scenario'}
            <select value={id} onChange={(e) => setId(e.target.value)}>
              {kind === 'pattern' && <option value="">— free generation, no pattern —</option>}
              {(kind === 'pattern' ? library : seeds).map((r) => (
                <option key={r.id} value={r.id}>{r.id}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="row">
          <label>age<input type="number" value={sample.age} onChange={(e) => set('age', Number(e.target.value))} /></label>
          <label>money<input type="number" value={sample.money} onChange={(e) => set('money', Number(e.target.value))} /></label>
          <label>health<input type="number" value={sample.health} onChange={(e) => set('health', Number(e.target.value))} /></label>
          <label>happiness<input type="number" value={sample.happiness} onChange={(e) => set('happiness', Number(e.target.value))} /></label>
          <label>content mode
            <select value={sample.contentMode} onChange={(e) => set('contentMode', e.target.value)}>
              <option value="safe">safe</option><option value="mature">mature</option>
            </select>
          </label>
        </div>

        <div className="row">
          <label>flags <span className="muted small">comma-separated</span>
            <input value={sample.flags} onChange={(e) => set('flags', e.target.value)} placeholder="married, smoker" />
          </label>
          <label>region <span className="muted small">name weighting only</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">— none —</option>
              {regions.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </label>
          <label>era
            <input value={`${year} (derived)`} readOnly title="The engine has no calendar of its own; the year follows from age." />
          </label>
        </div>

        <div className="actions">
          <button className="btn btn--primary" onClick={run} disabled={busy || (kind === 'seed' && !id) || (kind === 'pattern' && !llmEnabled)}>
            {busy ? 'Generating…' : 'Generate'}
          </button>
          {kind === 'pattern' && !llmEnabled && <span className="muted small">no ANTHROPIC_API_KEY — generation unavailable</span>}
          {sample.age < 18 && sample.contentMode === 'mature' && (
            <span className="muted small">under 18: the engine forces the safe tier regardless of mode</span>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {result && result.kind === 'pattern' && (
        <section className="card">
          <h2>Result <span className="muted">{result.model} · {(result.ms / 1000).toFixed(1)}s · tier {result.tier}</span></h2>
          {result.cards.map((c) => (
            <div key={c.index} className={`result ${c.ok ? 'result--ok' : 'result--bad'}`}>
              <div className="draft__head">
                <span className="pill">{c.ok ? 'valid' : 'REJECTED'}</span>
                {c.scenario && <span className="pill">{c.scenario.weight}</span>}
              </div>
              {c.ok ? (
                <>
                  <p>{c.scenario.scenario}</p>
                  <p className="muted small">← {c.scenario.leftLabel} · {c.scenario.rightLabel} →</p>
                </>
              ) : (
                <ul className="problems">{c.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              )}
            </div>
          ))}
          <details>
            <summary>raw model output</summary>
            <pre className="raw">{result.raw}</pre>
          </details>
          <details>
            <summary>prompts sent</summary>
            <pre className="raw">{result.prompts.user}</pre>
          </details>
        </section>
      )}

      {result && result.kind === 'seed' && (
        <section className="card">
          <h2>Result <span className="muted">tier {result.tier}</span></h2>
          <div className={`result ${result.ok ? 'result--ok' : 'result--bad'}`}>
            <span className="pill">{result.ok ? 'valid' : 'REJECTED'}</span>
            {result.scenario && <p>{result.scenario.scenario}</p>}
            {!result.ok && <ul className="problems">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
          {['leftEffects', 'rightEffects'].map((side) => result.sides[side] && (
            <div key={side} className="result">
              <strong>{side}</strong>
              {result.sides[side].changed.length > 0 && (
                <p className="muted small">
                  the engine would alter: {result.sides[side].changed.join(', ')} — the card proposes, the referee decides
                </p>
              )}
              <div className="row">
                <pre className="raw">proposed{'\n'}{JSON.stringify(result.sides[side].proposed, null, 2)}</pre>
                <pre className="raw">clamped{'\n'}{JSON.stringify(result.sides[side].clamped, null, 2)}</pre>
              </div>
              <p className="muted small">time cost: {result.sides[side].months} months</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
