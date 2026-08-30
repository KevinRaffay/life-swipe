import React, { useEffect, useRef, useState } from 'react';
import * as api from '../api.js';
import PatternForm from './PatternForm.jsx';
import SeedForm from './SeedForm.jsx';
import DraftQueue from './DraftQueue.jsx';

/** One progress-log line for a streamed harvest event. */
function formatEvent(e) {
  switch (e.stage) {
    case 'scan':
      return `▶ read ${e.read} log entr${e.read === 1 ? 'y' : 'ies'} (${e.matching} matched the window)`;
    case 'eligible':
      return `    ${e.entries} eligible call(s), ${e.seen} card(s) seen, ${e.cards} survived every check`;
    case 'seeds':
      return `    ${e.kept} seed candidate(s) kept, ${e.duplicates} dropped as near-repeats`;
    case 'patterns-start':
      return `▶ generalising ${e.majors} major-tier card(s) through the extraction prompt — one long model call`;
    case 'patterns':
      return e.skipped ? `    library path skipped: ${e.skipped}` : `    ${e.proposed} library pattern(s) proposed`;
    default:
      return JSON.stringify(e);
  }
}

// Phrased to read after a bare count, whatever that count is.
const REJECTION_LABEL = {
  'entry ineligible': 'call(s) not eligible',
  'prompt could not be read': 'call(s) whose prompt could not be read back',
  'response was not a JSON array': 'call(s) whose response could not be read',
  'craft warnings': 'card(s) with craft drift',
  'not generalisable': 'card(s) too specific to one life',
};

/**
 * Harvest live generations out of the LLM request log and into the two draft
 * queues.
 *
 * The load-bearing rules of this screen are the same two every other content
 * screen has, plus one that is only true here:
 *
 *   - A harvest only ever APPENDS to `scenarios-seed.draft.json` and
 *     `situation-library.draft.json`. Nothing reaches the live deck or library
 *     without a person pressing Approve, in the same queues below.
 *   - It is ON DEMAND. There is no schedule behind this button, deliberately:
 *     harvesting decides what the game's permanent content becomes.
 *   - Only generations paid for by the SERVER's API key are eligible. A call
 *     with no recorded key source — which is every call logged before the
 *     field existed — is skipped rather than assumed, so an old log reads as
 *     "nothing eligible" instead of quietly harvesting itself.
 */
export default function Harvest({ seedDrafts, drafts, library, vocab, llmEnabled, defaults, onChanged }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(String(defaults?.limit ?? 200));
  const [maxCraftWarnings, setMaxCraftWarnings] = useState(String(defaults?.maxCraftWarnings ?? 0));
  const [wantSeeds, setWantSeeds] = useState(true);
  const [wantPatterns, setWantPatterns] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [bulkStatus, setBulkStatus] = useState(null);
  const [bulkPending, setBulkPending] = useState(null); // 'approve' | 'reject' | null
  const controllerRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress]);

  const run = async () => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true); setError(null); setNotice(null); setResult(null); setProgress([]);
    try {
      const res = await api.harvest({
        from: from || null,
        to: to || null,
        limit: limit ? Number(limit) : undefined,
        maxCraftWarnings: maxCraftWarnings === '' ? undefined : Number(maxCraftWarnings),
        seeds: wantSeeds,
        patterns: wantPatterns,
      }, (event) => setProgress((p) => [...p, event].slice(-200)), controller.signal);
      setResult(res);
      onChanged({
        seedDrafts: res.seedDrafts, seedDraftsVersion: res.seedDraftsVersion,
        drafts: res.drafts, draftsVersion: res.draftsVersion,
      });
    } catch (err) {
      if (err.aborted) setNotice('Cancelled. Anything already written to a draft queue is still there.');
      else setError(err.message);
    } finally {
      setBusy(false);
      controllerRef.current = null;
    }
  };

  const approve = async (kind, draft, record) => {
    setBusy(true); setError(null);
    try {
      const res = await api.approveDraft(kind, draft.id, record, null, true);
      onChanged(kind === 'seedDrafts'
        ? { seeds: res.seeds, seedsVersion: res.seedsVersion, seedDrafts: res.seedDrafts, seedDraftsVersion: res.seedDraftsVersion }
        : { library: res.library, libraryVersion: res.libraryVersion, drafts: res.drafts, draftsVersion: res.draftsVersion });
      return true;
    } catch (err) {
      setError(err.problems ? `${err.message}: ${err.problems.join('; ')}` : err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reject = async (kind, draft, reason) => {
    setBusy(true);
    try {
      const res = await api.rejectDraft(kind, draft.id, reason);
      onChanged(kind === 'seedDrafts'
        ? { seedDrafts: res.seedDrafts, seedDraftsVersion: res.seedDraftsVersion }
        : { drafts: res.drafts, draftsVersion: res.draftsVersion });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Only the rows this feature produced. The two queues are shared with
  // extraction and bulk generation, and mixing three provenances into one
  // review list would make "where did this come from" unanswerable at a glance.
  const harvestedSeeds = (seedDrafts || []).filter((d) => d.source === 'harvested');
  const harvestedPatterns = (drafts || []).filter((d) => d.source === 'harvested');

  // Craft warnings only exist on seed drafts (validateBatch's per-card
  // narrativeWarnings) - library/pattern drafts have no equivalent stored
  // field, so the bulk clean/warned split below applies to the seed queue
  // only, same scope the "craft warnings" language already has everywhere
  // else in this file.
  const cleanHarvestedSeeds = harvestedSeeds.filter((d) => !(d.validationWarnings && d.validationWarnings.length));
  const warnedHarvestedSeeds = harvestedSeeds.filter((d) => d.validationWarnings && d.validationWarnings.length);

  // Same shape as SeedGeneration.jsx's bulk actions: loop the existing
  // single-draft approve/reject endpoint rather than a new bulk route.
  const confirmApproveAllClean = async () => {
    setBulkPending(null);
    const targets = cleanHarvestedSeeds;
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
      setNotice(`Approved ${okCount} harvested seed draft(s) without warnings.`);
    }
  };

  const confirmRejectAllWarned = async () => {
    setBulkPending(null);
    const targets = warnedHarvestedSeeds;
    if (!targets.length) return;
    setBusy(true); setError(null); setNotice(null);
    const failures = [];
    for (let i = 0; i < targets.length; i++) {
      const draft = targets[i];
      setBulkStatus(`Rejecting ${i + 1} of ${targets.length}: ${draft.id}...`);
      try {
        const res = await api.rejectDraft('seedDrafts', draft.id, 'bulk reject: draft has craft warnings');
        onChanged({ seedDrafts: res.seedDrafts, seedDraftsVersion: res.seedDraftsVersion });
      } catch (err) {
        failures.push(`${draft.id} (${err.message})`);
      }
    }
    setBulkStatus(null);
    setBusy(false);
    const okCount = targets.length - failures.length;
    if (failures.length) {
      setError(`Rejected ${okCount} of ${targets.length}. Failed: ${failures.join('; ')}`);
    } else {
      setNotice(`Rejected ${okCount} harvested seed draft(s) with craft warnings.`);
    }
  };

  // Already grouped and sorted by the server (server/harvest.js).
  const rejections = result?.rejections || [];
  const seedDuplicates = result?.seedDuplicates || [];

  return (
    <div className="pane">
      <section className="card">
        <h2>Harvest from logs</h2>
        <p className="muted">
          Reads <code>server/logs/llm-requests.jsonl</code> and pulls the good
          live generations back out of it, so a card that was written for one
          player and then thrown away can become permanent content. Only calls
          that <b>passed validation</b> and were paid for by the <b>server's own
          API key</b> are eligible — a call with no recorded key source is
          skipped, not assumed, which means calls logged before this feature
          existed are never harvested. Appends to the draft queues below and
          nothing else; the live deck and library are still only reachable
          through Approve.
        </p>

        <div className="row">
          <label>from <span className="muted small">blank = as far back as the log goes</span>
            <input type="date" value={from} disabled={busy} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>to
            <input type="date" value={to} disabled={busy} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>entries to read <span className="muted small">newest first</span>
            <input type="number" min="1" value={limit} disabled={busy} onChange={(e) => setLimit(e.target.value)} />
          </label>
          <label>craft warnings allowed <span className="muted small">0 = only clean cards</span>
            <input type="number" min="0" value={maxCraftWarnings} disabled={busy} onChange={(e) => setMaxCraftWarnings(e.target.value)} />
          </label>
          {busy ? (
            <button className="btn btn--danger" onClick={() => controllerRef.current?.abort()}>Cancel</button>
          ) : (
            <button
              className="btn btn--primary"
              onClick={run}
              disabled={(!wantSeeds && !wantPatterns) || (wantPatterns && !llmEnabled)}
            >
              Harvest
            </button>
          )}
        </div>

        <div className="check-group">
          <label className="check">
            <input type="checkbox" checked={wantSeeds} disabled={busy} onChange={(e) => setWantSeeds(e.target.checked)} />
            seed deck — keep the card as written, with the cast's names swapped back to role tags
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={wantPatterns}
              disabled={busy || !llmEnabled}
              onChange={(e) => setWantPatterns(e.target.checked)}
            />
            situation library — generalise the major-tier cards into anonymous patterns (one model call)
          </label>
          <p className="muted small">
            The seed path is pure text transformation over what the log already
            holds, so it needs no API key and takes a second. The library path
            hands those scenarios to the same extraction prompt the paste box
            uses and can run for a minute or two.
            {!llmEnabled && ' No ANTHROPIC_API_KEY — the library path is unavailable.'}
          </p>
        </div>

        {(busy || progress.length > 0) && (
          <div className="raw mono" ref={logRef} style={{ maxHeight: 180 }}>
            {progress.length === 0 ? (busy ? 'starting...' : '') : progress.map((e, i) => <div key={i}>{formatEvent(e)}</div>)}
            {busy && <div>{'…'} running</div>}
          </div>
        )}

        {error && <p className="error">{error}</p>}
        {notice && <div className="toast toast--warn">{notice}</div>}

        {result && (
          <>
            <div className={`toast toast--${result.seedsAdded + result.patternsAdded > 0 ? 'ok' : 'warn'}`}>
              {result.seedsAdded + result.patternsAdded > 0 ? (
                <>Added {result.seedsAdded} seed draft(s) and {result.patternsAdded} library
                  draft(s) from {result.stats.entriesEligible} eligible call(s).</>
              ) : (
                <>Nothing harvested from {result.scanned} log entr{result.scanned === 1 ? 'y' : 'ies'}
                  {result.stats.entriesEligible === 0
                    ? ' — no call in that window was eligible. Only server-key calls that passed validation can be harvested, and calls logged before this feature existed carry no key source at all.'
                    : ' — every candidate was filtered out. The breakdown below says why.'}</>
              )}
            </div>

            <div className="tiles">
              <div className="tile"><b>{result.stats.entriesEligible}</b><span>eligible calls</span></div>
              <div className="tile"><b>{result.stats.cardsSeen}</b><span>cards seen</span></div>
              <div className="tile"><b>{result.seedsAdded}</b><span>seed drafts added</span></div>
              <div className="tile"><b>{result.patternsAdded}</b><span>library drafts added</span></div>
            </div>

            {rejections.length > 0 && (
              <>
                <p className="muted small">What was left out, and why:</p>
                <ul className="problems">
                  {rejections.map((r) => (
                    <li key={r.reason}>
                      <b>{r.count}</b> {REJECTION_LABEL[r.reason] || r.reason}
                      {r.examples.length > 0 && <span className="muted"> — e.g. {r.examples.join(' / ')}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {seedDuplicates.length > 0 && (
              <ul className="problems">
                {seedDuplicates.map((d) => (
                  <li key={d.id}>
                    <code>{d.id}</code> dropped: {Math.round(d.score * 100)}% word overlap with <code>{d.duplicateOf}</code>
                  </li>
                ))}
              </ul>
            )}

            {result.patternsSkipped && result.patternsSkipped !== 'not requested' && (
              <p className="muted small">Library path: {result.patternsSkipped}.</p>
            )}
            {result.patternProblems?.length > 0 && (
              <ul className="problems">
                {result.patternProblems.map((p, i) => <li key={i}>schema: {p}</li>)}
              </ul>
            )}
            {result.patternCollisions?.length > 0 && (
              <p className="muted small">
                Ids also present in the live library: {result.patternCollisions.join(', ')}.
              </p>
            )}
          </>
        )}
      </section>

      {harvestedSeeds.length > 0 && (
        <section className="card">
          <div className="toolbar">
            <span className="muted small">
              {cleanHarvestedSeeds.length} of {harvestedSeeds.length} harvested seed draft(s) carry no craft warnings.
            </span>
            <span className="spacer" />
            <button className="btn btn--primary" onClick={() => setBulkPending('approve')} disabled={busy || !cleanHarvestedSeeds.length}>
              Approve all without warnings{cleanHarvestedSeeds.length ? ` (${cleanHarvestedSeeds.length})` : ''}
            </button>
            <button className="btn btn--danger" onClick={() => setBulkPending('reject')} disabled={busy || !warnedHarvestedSeeds.length}>
              Reject all with warnings{warnedHarvestedSeeds.length ? ` (${warnedHarvestedSeeds.length})` : ''}
            </button>
          </div>

          {bulkPending === 'approve' && (
            <div className="draft">
              <p className="muted small">
                This approves {cleanHarvestedSeeds.length} currently-listed harvested seed draft(s) with no craft
                warnings, merging each into <code>data/scenarios-seed.json</code>. Anything with a warning is left
                untouched.
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
                This rejects {warnedHarvestedSeeds.length} currently-listed harvested seed draft(s) that carry one
                or more craft warnings. Clean drafts are left untouched.
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
        title="Harvested seed drafts"
        emptyText="No harvested seed candidates waiting. Anything from bulk generation is on the “Generate seeds” tab."
        drafts={harvestedSeeds}
        busy={busy}
        FormComponent={SeedForm}
        onApprove={(draft, record) => approve('seedDrafts', draft, record)}
        onReject={(draft, reason) => reject('seedDrafts', draft, reason)}
        renderSummary={(d) => (
          <>
            <div className="draft__head">
              <code>{d.id}</code>
              <span className="pill">{(d.stages || []).join(', ')}</span>
              <span className="pill">{(d.life_stage || []).join('–')}</span>
              <span className="pill">{(d.modes || []).join('/')}</span>
              <span className="pill">{d.weight}</span>
              {(d.requiresFlags || []).map((f) => <span key={f} className="pill">requires {f}</span>)}
            </div>
            {d.setting && <p className="muted small">{d.setting}</p>}
            <p>{d.prompt}</p>
            <p className="muted small">{d.leftLabel} / {d.rightLabel}</p>
          </>
        )}
        renderExtra={(d) => (
          <>
            {d.harvestedFrom && (
              <p className="muted small">
                harvested from a call at age {d.harvestedFrom.age} on{' '}
                {new Date(d.harvestedFrom.at).toLocaleString()}
                {d.harvestedFrom.librarySlot ? ` (grounded in ${d.harvestedFrom.librarySlot})` : ''}
              </p>
            )}
            {d.validationWarnings?.length > 0 && (
              <ul className="problems">
                {d.validationWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
          </>
        )}
      />

      <DraftQueue
        title="Harvested library drafts"
        emptyText="No harvested patterns waiting. Anything from pasted source text is on the “Extract & drafts” tab."
        drafts={harvestedPatterns}
        busy={busy}
        FormComponent={PatternForm}
        formProps={{ vocab, siblings: library }}
        onApprove={(draft, record) => approve('drafts', draft, record)}
        onReject={(draft, reason) => reject('drafts', draft, reason)}
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
          const warnings = (result?.patternWarnings || []).find((w) => w.id === d.id)?.warnings || [];
          const duplicate = (result?.patternDuplicates || []).find((x) => x.id === d.id);
          if (!warnings.length && !duplicate) return null;
          return (
            <ul className="problems">
              {duplicate && (
                <li>possible duplicate of <code>{duplicate.duplicateOf}</code> ({Math.round(duplicate.score * 100)}% word overlap)</li>
              )}
              {warnings.map((w, i) => <li key={i}>anonymity: {w}</li>)}
            </ul>
          );
        }}
      />
    </div>
  );
}
