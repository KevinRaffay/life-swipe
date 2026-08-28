import React, { useEffect, useRef, useState } from 'react';
import * as api from '../api.js';
import SeedForm from './SeedForm.jsx';
import DraftQueue from './DraftQueue.jsx';

/** One progress-log line for a streamed generation event. */
function formatEvent(e) {
  if (e.type === 'bucket') {
    return `▶ ${e.bucket}/${e.mode}: ${e.current} on hand, generating ${e.target} candidate(s)...${e.note ? ' — ' + e.note : ''}`;
  }
  if (e.type === 'batch') {
    if (e.error) return `    batch ${e.batch}: call failed — ${e.error}`;
    return `    batch ${e.batch}: ${e.produced} candidate(s) validated (tier ${e.tier})${e.slot ? `, grounded in ${e.slot}` : ''}`;
  }
  return JSON.stringify(e);
}

/**
 * Run a bulk seed-generation pass, then review what it wrote to the draft
 * queue - same edit-inline / approve / reject shape as Extraction.jsx's
 * pattern drafts, via the shared DraftQueue component.
 *
 * The load-bearing rule of this screen is the same as extraction's: a
 * generation run only ever APPENDS to scenarios-seed.draft.json. Nothing
 * reaches data/scenarios-seed.json without a person pressing Approve.
 *
 * A run is many sequential LLM calls - minutes, for a large or forced batch -
 * so /api/generate-seeds streams one progress line per bucket/batch (see
 * api.js's generateSeeds) instead of going quiet until the very end, which is
 * what read as a hung button before this existed. Cancel aborts the fetch and
 * asks the server to stop between batches rather than run the whole plan out.
 */
export default function SeedGeneration({ seedDrafts, llmEnabled, onChanged }) {
  const [mode, setMode] = useState('both');
  const [target, setTarget] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [bulkStatus, setBulkStatus] = useState(null);
  const controllerRef = useRef(null);
  const logRef = useRef(null);
  const refreshTimerRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress]);

  // Only the server-side loop between batches actually checks for a cancel
  // (server/admin/index.js's shouldStop), so the in-flight LLM call keeps
  // running for up to its own 60s timeout after Cancel is clicked - the
  // fetch is gone by then, so this tab never sees the drafts it manages to
  // save on the way out. Pull a fresh copy of the draft queue once that
  // window has passed instead of pretending we already have it.
  const scheduleCancelRefresh = () => {
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const boot = await api.getBootstrap();
        onChanged({ seedDrafts: boot.seedDrafts, seedDraftsVersion: boot.seedDraftsVersion });
        setNotice('Refreshed the draft queue with whatever finished before you cancelled.');
      } catch {
        setNotice('Could not refresh automatically - reload the page to see whatever was saved.');
      }
    }, 65000);
  };

  const generate = async () => {
    clearTimeout(refreshTimerRef.current);
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true); setError(null); setNotice(null); setResult(null); setProgress([]);
    try {
      const res = await api.generateSeeds(
        mode, target ? Number(target) : null, force,
        (event) => setProgress((p) => [...p, event].slice(-300)),
        controller.signal,
      );
      setResult(res);
      onChanged({ seedDrafts: res.seedDrafts, seedDraftsVersion: res.seedDraftsVersion });
    } catch (err) {
      if (err.aborted) {
        setNotice('Cancelling - the in-flight model call can take up to a minute to finish. Anything it validates before stopping is still saved to the draft queue; refreshing automatically once that window passes.');
        scheduleCancelRefresh();
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
      controllerRef.current = null;
    }
  };

  useEffect(() => () => clearTimeout(refreshTimerRef.current), []);

  const cancel = () => controllerRef.current?.abort();

  const approve = async (draft, record) => {
    setBusy(true); setError(null);
    try {
      const res = await api.approveDraft('seedDrafts', draft.id, record, null, true);
      onChanged({
        seeds: res.seeds, seedsVersion: res.seedsVersion,
        seedDrafts: res.seedDrafts, seedDraftsVersion: res.seedDraftsVersion,
      });
      return true;
    } catch (err) {
      setError(err.problems ? `${err.message}: ${err.problems.join('; ')}` : err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Approval has no LLM call in it - it's a validate-and-write - so unlike
  // generation this is fast enough to just loop sequentially rather than
  // needing a streamed server route. Each approve is still the real
  // single-draft endpoint (id regeneration, schema validation, version-
  // checked write), so a clean draft that somehow fails still just reports
  // as a failure rather than corrupting the batch.
  const approveAllClean = async () => {
    const targets = seedDrafts.filter((d) => !(d.validationWarnings && d.validationWarnings.length));
    if (!targets.length) return;
    setBusy(true); setError(null); setNotice(null);
    const failures = [];
    for (let i = 0; i < targets.length; i++) {
      const draft = targets[i];
      setBulkStatus(`Approving ${i + 1} of ${targets.length}: ${draft.id}...`);
      try {
        const res = await api.approveDraft('seedDrafts', draft.id, draft, null, true);
        onChanged({
          seeds: res.seeds, seedsVersion: res.seedsVersion,
          seedDrafts: res.seedDrafts, seedDraftsVersion: res.seedDraftsVersion,
        });
      } catch (err) {
        failures.push(`${draft.id} (${err.problems ? `${err.message}: ${err.problems.join('; ')}` : err.message})`);
      }
    }
    setBulkStatus(null);
    setBusy(false);
    const okCount = targets.length - failures.length;
    if (failures.length) {
      setError(`Approved ${okCount} of ${targets.length}. Failed: ${failures.join('; ')}`);
    } else {
      setNotice(`Approved ${okCount} draft(s) without warnings.`);
    }
  };

  const reject = async (draft, reason) => {
    setBusy(true);
    try {
      const res = await api.rejectDraft('seedDrafts', draft.id, reason);
      onChanged({ seedDrafts: res.seedDrafts, seedDraftsVersion: res.seedDraftsVersion });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <section className="card">
        <h2>Generate seed candidates</h2>
        <p className="muted">
          Runs the real storyteller path (server/prompt.js) against every
          coverage-short bucket for the chosen mode and appends validated
          candidates to the draft queue below. Nothing is added to
          data/scenarios-seed.json until you approve it. Equivalent to
          <code> npm run generate-seeds</code> on the command line, for a
          larger batch. Each bucket/mode pair is several sequential model
          calls, so a run across many buckets can take minutes — watch the
          log below for live progress.
        </p>
        <div className="row">
          <label>mode
            <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={busy}>
              <option value="both">both</option>
              <option value="safe">safe</option>
              <option value="mature">mature</option>
            </select>
          </label>
          <label>target per bucket <span className="muted small">blank = default (15 opening bracket / 8 elsewhere)</span>
            <input type="number" min="1" value={target} placeholder="default" disabled={busy} onChange={(e) => setTarget(e.target.value)} />
          </label>
          {busy ? (
            <button className="btn btn--danger" onClick={cancel}>Cancel</button>
          ) : (
            <button className="btn btn--primary" onClick={generate} disabled={!llmEnabled}>Generate</button>
          )}
        </div>
        <div className="check-group">
          <label className="check">
            <input type="checkbox" checked={force} disabled={busy} onChange={(e) => setForce(e.target.checked)} />
            generate even for buckets that already meet their coverage target
          </label>
          <p className="muted small">
            By default, Generate only fires for buckets <code>npm run coverage</code> flags
            as short, which is often nothing. Checking this against every bucket/mode with
            a default target is a lot of calls — consider a small target first.
          </p>
        </div>
        {!llmEnabled && <p className="muted small">no ANTHROPIC_API_KEY — generation unavailable</p>}

        {(busy || progress.length > 0) && (
          <div className="raw mono" ref={logRef} style={{ maxHeight: 180 }}>
            {progress.length === 0
              ? (busy ? 'starting...' : '')
              : progress.map((e, i) => <div key={i}>{formatEvent(e)}</div>)}
            {busy && <div>{'…'} running</div>}
          </div>
        )}

        {error && <p className="error">{error}</p>}
        {notice && <div className="toast toast--warn">{notice}</div>}
        {result && (
          <div className={`toast toast--${result.buckets.length === 0 ? 'warn' : 'ok'}`}>
            {result.buckets.length === 0 ? (
              <>Nothing short for that mode — every bucket already meets its coverage target. Check "generate even for buckets that already meet their coverage target" above to draft more anyway.</>
            ) : (
              <>Added {result.added} candidate(s) across {result.buckets.length} bucket/mode pair(s): {
                result.buckets.map((b) => `${b.bucket}/${b.mode} ${b.accepted}/${b.target}`).join(', ')}.</>
            )}
          </div>
        )}
      </section>

      {seedDrafts.length > 0 && (
        <section className="card">
          <div className="toolbar">
            <span className="muted small">
              {seedDrafts.filter((d) => !(d.validationWarnings && d.validationWarnings.length)).length} of {seedDrafts.length} draft(s) carry no craft warnings.
            </span>
            <span className="spacer" />
            <button
              className="btn btn--primary"
              onClick={approveAllClean}
              disabled={busy || !seedDrafts.some((d) => !(d.validationWarnings && d.validationWarnings.length))}
            >
              Approve all without warnings
            </button>
          </div>
          {bulkStatus && <p className="muted small">{bulkStatus}</p>}
        </section>
      )}

      <DraftQueue
        title="Seed drafts"
        drafts={seedDrafts}
        busy={busy}
        FormComponent={SeedForm}
        onApprove={approve}
        onReject={reject}
        renderSummary={(d) => (
          <>
            <div className="draft__head">
              <code>{d.id}</code>
              <span className="pill">{(d.stages || []).join(', ')}</span>
              <span className="pill">{(d.life_stage || []).join('–')}</span>
              <span className="pill">{(d.modes || []).join('/')}</span>
              <span className="pill">{d.weight}</span>
            </div>
            {d.setting && <p className="muted small">{d.setting}</p>}
            <p>{d.prompt}</p>
            <p className="muted small">{d.leftLabel} / {d.rightLabel}</p>
          </>
        )}
        renderExtra={(d) => (d.validationWarnings && d.validationWarnings.length ? (
          <ul className="problems">
            {d.validationWarnings.map((w, i) => <li key={i}>craft: {w}</li>)}
          </ul>
        ) : null)}
      />
    </div>
  );
}
