import React, { useState } from 'react';
import * as api from '../api.js';
import PatternForm from './PatternForm.jsx';
import Modal from './Modal.jsx';

/**
 * Paste source text, extract candidates, review them one at a time.
 *
 * The load-bearing rule of this screen: extraction NEVER merges. It appends to
 * the draft queue and stops. Everything that reaches the live library gets
 * there because a person read it and pressed Approve.
 */
export default function Extraction({ drafts, vocab, library, llmEnabled, onChanged }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await api.extract(text);
      setResult(res);
      onChanged({ drafts: res.drafts, draftsVersion: res.draftsVersion });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (draft, record) => {
    setBusy(true); setError(null);
    try {
      const res = await api.approveDraft(draft.id, record, null, true);
      onChanged({ library: res.library, libraryVersion: res.libraryVersion, drafts: res.drafts, draftsVersion: res.draftsVersion });
      setEditing(null);
    } catch (err) {
      setError(err.problems ? `${err.message}: ${err.problems.join('; ')}` : err.message);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (draft) => {
    setBusy(true);
    try {
      const res = await api.rejectDraft(draft.id, reason);
      onChanged({ drafts: res.drafts, draftsVersion: res.draftsVersion });
      setRejecting(null); setReason('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const warningsFor = (id) => (result?.warnings || []).find((w) => w.id === id)?.warnings || [];

  return (
    <div className="pane">
      <section className="card">
        <h2>Extract patterns from source text</h2>
        <p className="muted small">
          Paste a memoir summary, an obituary, a long profile. The extractor
          anonymises and generalises it into 8–15 candidate shapes and appends
          them to the draft queue below. It never writes to the live library.
        </p>
        <textarea
          rows={10}
          value={text}
          placeholder="Paste source text here…"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="actions">
          <button className="btn btn--primary" onClick={run} disabled={busy || !text.trim() || !llmEnabled}>
            {busy ? 'Extracting…' : 'Extract patterns'}
          </button>
          <span className="muted small">
            {llmEnabled ? `${text.length.toLocaleString()} characters` : 'no ANTHROPIC_API_KEY — extraction unavailable'}
          </span>
        </div>
        {error && <p className="error">{error}</p>}
        {result && (
          <p className="muted small">
            Added {result.added} candidates in {(result.ms / 1000).toFixed(1)}s.
            {result.problems?.length ? ` ${result.problems.length} schema problem(s): ${result.problems.join('; ')}` : ''}
            {result.collisions?.length ? ` Ids also present in the library: ${result.collisions.join(', ')}.` : ''}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Draft queue <span className="muted">({drafts.length})</span></h2>
        {drafts.length === 0 && <p className="muted">No drafts awaiting review.</p>}

        {drafts.map((d) => {
          const warnings = warningsFor(d.id);
          return (
            <div key={d.id} className="draft">
              <div className="draft__head">
                <code>{d.id}</code>
                <span className="pill">{d.category}</span>
                <span className="pill">{d.rarity}</span>
                <span className="pill">{(d.modes || []).join('/')}</span>
                <span className="pill">{(d.life_stage || []).join('–')}</span>
              </div>
              <p>{d.pattern}</p>
              <p className="muted small">{d.typical_effects}</p>
              {warnings.length > 0 && (
                <ul className="problems">
                  {warnings.map((w, i) => <li key={i}>anonymity: {w}</li>)}
                </ul>
              )}
              {rejecting === d.id ? (
                <div className="actions">
                  <input placeholder="why? (optional, logged)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button className="btn btn--danger" onClick={() => reject(d)} disabled={busy}>Confirm reject</button>
                  <button className="btn" onClick={() => { setRejecting(null); setReason(''); }}>Cancel</button>
                </div>
              ) : (
                <div className="actions">
                  <button className="btn btn--primary" onClick={() => approve(d, d)} disabled={busy}>Approve</button>
                  <button className="btn" onClick={() => setEditing(d.id)}>Edit &amp; approve</button>
                  <button className="btn btn--danger" onClick={() => setRejecting(d.id)}>Reject</button>
                </div>
              )}

              {editing === d.id && (
                <Modal title={`Review ${d.id}`} onClose={() => setEditing(null)}>
                  <PatternForm
                    value={d}
                    vocab={vocab}
                    siblings={library}
                    busy={busy}
                    onSave={(record) => approve(d, record)}
                    onCancel={() => setEditing(null)}
                    onDelete={() => { setEditing(null); setRejecting(d.id); }}
                  />
                  <p className="muted small">Saving here approves the draft and merges it into the library.</p>
                </Modal>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
