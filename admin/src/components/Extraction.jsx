import React, { useState } from 'react';
import * as api from '../api.js';
import PatternForm from './PatternForm.jsx';
import DraftQueue from './DraftQueue.jsx';

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
      const res = await api.approveDraft('drafts', draft.id, record, null, true);
      onChanged({ library: res.library, libraryVersion: res.libraryVersion, drafts: res.drafts, draftsVersion: res.draftsVersion });
      return true;
    } catch (err) {
      setError(err.problems ? `${err.message}: ${err.problems.join('; ')}` : err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reject = async (draft, reason) => {
    setBusy(true);
    try {
      const res = await api.rejectDraft('drafts', draft.id, reason);
      onChanged({ drafts: res.drafts, draftsVersion: res.draftsVersion });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const warningsFor = (id) => (result?.warnings || []).find((w) => w.id === id)?.warnings || [];
  const duplicateFor = (id) => (result?.duplicates || []).find((d) => d.id === id);

  return (
    <div className="pane">
      <section className="card">
        <h2>Extract patterns from source text</h2>
        <p className="muted">
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
            {result.duplicates?.length ? ` ${result.duplicates.length} possible content duplicate(s).` : ''}
          </p>
        )}
      </section>

      <DraftQueue
        title="Draft queue"
        drafts={drafts}
        busy={busy}
        FormComponent={PatternForm}
        formProps={{ vocab, siblings: library }}
        onApprove={approve}
        onReject={reject}
        renderSummary={(d) => (
          <>
            <div className="draft__head">
              <code>{d.id}</code>
              <span className="pill">{d.category}</span>
              <span className="pill">{d.rarity}</span>
              <span className="pill">{(d.modes || []).join('/')}</span>
              <span className="pill">{(d.life_stage || []).join('–')}</span>
            </div>
            <p>{d.pattern}</p>
            <p className="muted small">{d.typical_effects}</p>
          </>
        )}
        renderExtra={(d) => {
          const warnings = warningsFor(d.id);
          const duplicate = duplicateFor(d.id);
          if (!warnings.length && !duplicate) return null;
          return (
            <ul className="problems">
              {duplicate && <li>possible duplicate of <code>{duplicate.duplicateOf}</code> ({Math.round(duplicate.score * 100)}% word overlap)</li>}
              {warnings.map((w, i) => <li key={i}>anonymity: {w}</li>)}
            </ul>
          );
        }}
      />
    </div>
  );
}
