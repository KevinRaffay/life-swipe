import React, { useEffect, useRef, useState } from 'react';
import * as api from '../api.js';
import SeedForm from './SeedForm.jsx';
import DraftQueue from './DraftQueue.jsx';

/**
 * The DEMO pool tab: run a bulk generation pass, then review what it wrote.
 *
 * A dedicated tab rather than a mode toggle on "Generate seeds", and the
 * reason is the targeting logic, not the content. That tab's whole interface
 * is coverage - a mode picker, a per-bucket target, and a "generate even for
 * buckets that already meet their coverage target" checkbox - and every one
 * of those controls is meaningless here. Demo generation has one mode (demo
 * is mature-only by definition), one weight tier, no coverage table to be
 * short against, and exactly one useful knob: how many cards to aim for.
 * Bolting a toggle onto that tab would have meant three controls that grey
 * themselves out, which is a worse explanation of the difference than two
 * tabs are.
 *
 * What IS shared, deliberately, is everything downstream: the same
 * `DraftQueue` component, the same `SeedForm` editor, the same
 * `POST /admin/api/demoDrafts/:id/approve|reject` route shape (a third
 * draft/target pair through `server/admin/index.js`'s `draftRoutes`
 * factory), and the same "Approve all without warnings" / "Reject all with
 * warnings" bulk actions. A demo draft is a seed-shaped record and is
 * reviewed exactly like one; only the file it lands in differs.
 *
 * The load-bearing rule is the same as every other draft queue in this app: a
 * generation run only ever APPENDS to demo-seed-scenarios.draft.json. Nothing
 * reaches data/demo-seed-scenarios.json without a person pressing Approve.
 */
function formatEvent(e) {
  if (e.type === 'stage') {
    if (e.stage === 'all') return `= near-duplicate pass: flagged ${e.marked} card(s) as the same situation as an earlier one`;
    return `> ${e.stage} (${e.label}): generating ${e.target} candidate(s)...`;
  }
  if (e.type === 'batch') {
    if (e.error) return `    ${e.stage} batch ${e.batch}: call failed - ${e.error}`;
    return `    ${e.stage} batch ${e.batch}: +${e.produced} accepted  (${e.total}/${e.target})`;
  }
  return JSON.stringify(e);
}

export default function DemoPool({ demoSeeds, demoDrafts, defaultTotal, llmEnabled, onChanged }) {
  const [total, setTotal] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [bulkStatus, setBulkStatus] = useState(null);
  const [bulkPending, setBulkPending] = useState(null); // 'approve' | 'reject' | null
  const controllerRef = useRef(null);
  const logRef = useRef(null);
  const refreshTimerRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress]);

  // Same cancel story as SeedGeneration.jsx: only the server-side loop between
  // batches checks for a cancel, so the in-flight model call keeps running for
  // up to its own timeout after Cancel. The fetch is gone by then, so this tab
  // never sees whatever that batch saved on the way out - pull a fresh copy
  // once the window has passed rather than pretending we already have it.
  const scheduleCancelRefresh = () => {
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const boot = await api.getBootstrap();
        onChanged({ demoDrafts: boot.demoDrafts, demoDraftsVersion: boot.demoDraftsVersion });
        setNotice('Refreshed the draft queue with whatever finished before you cancelled.');
      } catch {
        setNotice('Could not refresh automatically - reload the page to see whatever was saved.');
      }
    }, 125000);
  };

  useEffect(() => () => clearTimeout(refreshTimerRef.current), []);

  const generate = async () => {
    clearTimeout(refreshTimerRef.current);
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true); setError(null); setNotice(null); setResult(null); setProgress([]);
    try {
      const res = await api.generateDemoSeeds(
        total ? Number(total) : null,
        (event) => setProgress((p) => [...p, event].slice(-400)),
        controller.signal,
      );
      setResult(res);
      onChanged({ demoDrafts: res.demoDrafts, demoDraftsVersion: res.demoDraftsVersion });
    } catch (err) {
      if (err.aborted) {
        setNotice('Cancelling - the in-flight model call can take up to two minutes to finish. Anything it validates before stopping is still saved to the draft queue; refreshing automatically once that window passes.');
        scheduleCancelRefresh();
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
      controllerRef.current = null;
    }
  };

  const cancel = () => controllerRef.current?.abort();

  const approve = async (draft, record) => {
    setBusy(true); setError(null);
    try {
      const res = await api.approveDraft('demoDrafts', draft.id, record, null, true);
      onChanged({
        demoSeeds: res.demoSeeds, demoSeedsVersion: res.demoSeedsVersion,
        demoDrafts: res.demoDrafts, demoDraftsVersion: res.demoDraftsVersion,
      });
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
      const res = await api.rejectDraft('demoDrafts', draft.id, reason);
      onChanged({ demoDrafts: res.demoDrafts, demoDraftsVersion: res.demoDraftsVersion });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const clean = demoDrafts.filter((d) => !(d.validationWarnings && d.validationWarnings.length));
  const warned = demoDrafts.filter((d) => d.validationWarnings && d.validationWarnings.length);

  // Sequential loops over the real single-draft endpoints, same as the other
  // two queues: approval is a validate-and-write with no model call in it, so
  // it is fast enough not to need a streamed route, and one bad draft
  // mid-batch reports as a failure rather than corrupting the rest.
  const confirmApproveAllClean = async () => {
    setBulkPending(null);
    if (!clean.length) return;
    setBusy(true); setError(null); setNotice(null);
    const failures = [];
    for (let i = 0; i < clean.length; i++) {
      const draft = clean[i];
      setBulkStatus(`Approving ${i + 1} of ${clean.length}: ${draft.id}...`);
      try {
        const res = await api.approveDraft('demoDrafts', draft.id, draft, null, true);
        onChanged({
          demoSeeds: res.demoSeeds, demoSeedsVersion: res.demoSeedsVersion,
          demoDrafts: res.demoDrafts, demoDraftsVersion: res.demoDraftsVersion,
        });
      } catch (err) {
        failures.push(`${draft.id} (${err.problems ? `${err.message}: ${err.problems.join('; ')}` : err.message})`);
      }
    }
    setBulkStatus(null);
    setBusy(false);
    const okCount = clean.length - failures.length;
    if (failures.length) setError(`Approved ${okCount} of ${clean.length}. Failed: ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? ` ...and ${failures.length - 5} more` : ''}`);
    else setNotice(`Approved ${okCount} draft(s) without warnings into the demo pool.`);
  };

  const confirmRejectAllWarned = async () => {
    setBulkPending(null);
    if (!warned.length) return;
    setBusy(true); setError(null); setNotice(null);
    const failures = [];
    for (let i = 0; i < warned.length; i++) {
      const draft = warned[i];
      setBulkStatus(`Rejecting ${i + 1} of ${warned.length}: ${draft.id}...`);
      try {
        const res = await api.rejectDraft('demoDrafts', draft.id, 'bulk reject: draft carries register or craft warnings');
        onChanged({ demoDrafts: res.demoDrafts, demoDraftsVersion: res.demoDraftsVersion });
      } catch (err) {
        failures.push(`${draft.id} (${err.message})`);
      }
    }
    setBulkStatus(null);
    setBusy(false);
    const okCount = warned.length - failures.length;
    if (failures.length) setError(`Rejected ${okCount} of ${warned.length}. Failed: ${failures.slice(0, 5).join('; ')}`);
    else setNotice(`Rejected ${okCount} draft(s) with warnings.`);
  };

  return (
    <div className="pane">
      <section className="card">
        <h2>Demo pool</h2>
        <p className="muted">
          The demo's own content set &mdash; <code>data/demo-seed-scenarios.json</code>,
          separate from the seed deck and never mixed with it. Every card is
          minor-tier, written for ages 18&ndash;36, in the demo's own register
          (<code>server/demo-prompt.js</code>): mature-only, gen-z voice,
          innuendo-driven comedy, never explicit. Generation runs the real
          <code> shared/schema.js</code> and <code>shared/content.js</code>{' '}
          validators, same as everything else. Equivalent to
          <code> npm run generate-demo-seeds</code> on the command line.
        </p>
        <p className="muted small">
          The demo pool currently holds <strong>{demoSeeds.length}</strong> approved
          card(s). A full run is hundreds of sequential model calls and can take
          an hour or more &mdash; watch the log below.
        </p>
        <div className="row">
          <label>candidates to aim for <span className="muted small">blank = default ({defaultTotal})</span>
            <input type="number" min="1" value={total} placeholder={String(defaultTotal)} disabled={busy} onChange={(e) => setTotal(e.target.value)} />
          </label>
          {busy ? (
            <button className="btn btn--danger" onClick={cancel}>Cancel</button>
          ) : (
            <button className="btn btn--primary" onClick={generate} disabled={!llmEnabled}>Generate</button>
          )}
        </div>
        {!llmEnabled && <p className="muted small">no LLM provider configured &mdash; generation unavailable</p>}

        {(busy || progress.length > 0) && (
          <div className="raw mono" ref={logRef} style={{ maxHeight: 220 }}>
            {progress.length === 0
              ? (busy ? 'starting...' : '')
              : progress.map((e, i) => <div key={i}>{formatEvent(e)}</div>)}
            {busy && <div>{'…'} running</div>}
          </div>
        )}

        {error && <p className="error">{error}</p>}
        {notice && <div className="toast toast--warn">{notice}</div>}
        {result && (
          <div className={`toast toast--${result.added ? 'ok' : 'warn'}`}>
            Added {result.added} candidate(s): {result.stages.map((s) => `${s.stage} ${s.accepted}/${s.target}`).join(', ')}.
            {' '}Nothing has been added to the live demo pool until you approve it.
          </div>
        )}
      </section>

      {demoDrafts.length > 0 && (
        <section className="card">
          <div className="toolbar">
            <span className="muted small">
              {clean.length} of {demoDrafts.length} draft(s) carry no warnings.
            </span>
            <span className="spacer" />
            <button className="btn btn--primary" onClick={() => setBulkPending('approve')} disabled={busy || !clean.length}>
              Approve all without warnings{clean.length ? ` (${clean.length})` : ''}
            </button>
            <button className="btn btn--danger" onClick={() => setBulkPending('reject')} disabled={busy || !warned.length}>
              Reject all with warnings{warned.length ? ` (${warned.length})` : ''}
            </button>
          </div>

          {bulkPending === 'approve' && (
            <div className="draft">
              <p className="muted small">
                This approves {clean.length} currently-listed draft(s) with no warnings, merging each
                into <code>data/demo-seed-scenarios.json</code>. Anything flagged is left untouched.
              </p>
              <div className="actions">
                <button className="btn btn--primary" onClick={confirmApproveAllClean} disabled={busy}>Confirm approve all</button>
                <button className="btn" onClick={() => setBulkPending(null)}>Cancel</button>
              </div>
            </div>
          )}

          {bulkPending === 'reject' && (
            <div className="draft">
              <p className="muted small">
                This rejects {warned.length} currently-listed draft(s) carrying a register, craft or
                near-duplicate warning. Clean drafts are left untouched.
              </p>
              <div className="actions">
                <button className="btn btn--danger" onClick={confirmRejectAllWarned} disabled={busy}>Confirm reject all</button>
                <button className="btn" onClick={() => setBulkPending(null)}>Cancel</button>
              </div>
            </div>
          )}

          {bulkStatus && <p className="muted small">{bulkStatus}</p>}
        </section>
      )}

      <DraftQueue
        title="Demo pool drafts"
        drafts={demoDrafts}
        busy={busy}
        FormComponent={SeedForm}
        onApprove={approve}
        onReject={reject}
        emptyText="No demo drafts awaiting review. Run a generation pass above."
        renderSummary={(d) => (
          <>
            <div className="draft__head">
              <code>{d.id}</code>
              <span className="pill">{(d.stages || []).join(', ')}</span>
              <span className="pill">{(d.life_stage || []).join('-')}</span>
              <span className="pill">{(d.modes || []).join('/')}</span>
              <span className="pill">{d.weight}</span>
            </div>
            <p>{d.prompt}</p>
            <p className="muted small">{d.leftLabel} / {d.rightLabel}</p>
          </>
        )}
        renderExtra={(d) => (d.validationWarnings && d.validationWarnings.length ? (
          <ul className="problems">
            {d.validationWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        ) : null)}
      />
    </div>
  );
}
