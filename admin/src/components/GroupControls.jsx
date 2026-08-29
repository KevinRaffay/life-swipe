import React, { useState } from 'react';

/**
 * One panel for a pool-wide exclusion control. Category, region and
 * gender_assoc deactivation share this exact shape - a value, a live count of
 * the names it affects, and a required reason before it takes effect - so
 * this is written once and instantiated three times in NamePool.jsx rather
 * than duplicated.
 *
 * `rows` is `[{ value, count, deactivated: { reason, deactivatedAt } | null }]`.
 *
 * `namePool` + `matchNames` are how each row's collapsible names list is
 * built: `matchNames(entry, row.value)` is the same predicate NamePool.jsx
 * already uses to compute `count`, so the list and the count can never
 * disagree. No separate API call - this filters the name list the table
 * already fetched, client-side, per row, only when a row's disclosure is
 * opened.
 *
 * `onBulkDeactivate(values, reason)` / `onBulkReactivate(values)` back the
 * selection toolbar below. They go through a dedicated bulk API route
 * (server/admin/index.js's `.../bulk`) rather than one request per selected
 * row - a sequential loop over the single-row `onDeactivate`/`onReactivate`
 * would race itself, since each of those closures reads the version number
 * from the LAST render it was created in, and nothing here re-renders
 * between awaits inside a synchronous loop.
 */
export default function GroupControls({
  title, description, note, rows, busy, onDeactivate, onReactivate, namePool, matchNames,
  onBulkDeactivate, onBulkReactivate,
}) {
  const [pending, setPending] = useState(null); // the value mid-confirmation
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkReason, setBulkReason] = useState('');

  const confirm = async (value) => {
    const ok = await onDeactivate(value, reason);
    if (ok) { setPending(null); setReason(''); }
  };

  const cancel = () => { setPending(null); setReason(''); };

  const toggleSelect = (value, checked) => setSelected((s) => {
    const next = new Set(s);
    if (checked) next.add(value); else next.delete(value);
    return next;
  });
  const selectAll = () => setSelected(new Set(rows.map((r) => r.value)));
  const clearSelection = () => setSelected(new Set());

  const selectedActive = rows.filter((r) => selected.has(r.value) && !r.deactivated);
  const selectedDeactivated = rows.filter((r) => selected.has(r.value) && r.deactivated);
  // A per-row count can't just be summed across rows without risking a double
  // count - a region-carrying name can match several selected regions at
  // once (unlike category/gender_assoc, which are exclusive per name). Same
  // namePool + matchNames the per-row disclosure already uses, so this stays
  // exact rather than approximate.
  const selectedActiveNameCount = namePool && matchNames
    ? new Set(
        namePool.filter((e) => selectedActive.some((r) => matchNames(e, r.value))).map((e) => e.name),
      ).size
    : selectedActive.reduce((sum, r) => sum + r.count, 0);

  const startBulkDeactivate = () => { setPending(null); setBulkPending(true); };
  const cancelBulkDeactivate = () => { setBulkPending(false); setBulkReason(''); };
  const confirmBulkDeactivate = async () => {
    const ok = await onBulkDeactivate(selectedActive.map((r) => r.value), bulkReason);
    if (ok) { setBulkPending(false); setBulkReason(''); clearSelection(); }
  };
  const bulkReactivate = async () => {
    const ok = await onBulkReactivate(selectedDeactivated.map((r) => r.value));
    if (ok) clearSelection();
  };

  return (
    <section className="card">
      <h2>{title}</h2>
      {description && <p className="muted small">{description}</p>}
      {rows.length === 0 && <p className="muted">Nothing to show.</p>}

      {rows.length > 0 && (
        <div className="toolbar">
          <button className="btn" onClick={selectAll} disabled={!rows.length}>
            Select all ({rows.length})
          </button>
          <span className="muted small">{selected.size} selected</span>
          <span className="spacer" />
          <button className="btn" onClick={bulkReactivate} disabled={busy || !selectedDeactivated.length}>
            Activate selected{selectedDeactivated.length ? ` (${selectedDeactivated.length})` : ''}
          </button>
          <button className="btn btn--danger" onClick={startBulkDeactivate} disabled={busy || !selectedActive.length}>
            Deactivate selected{selectedActive.length ? ` (${selectedActive.length})` : ''}
          </button>
          {selected.size > 0 && <button className="link" onClick={clearSelection}>clear</button>}
        </div>
      )}

      {bulkPending && (
        <div className="draft">
          <p className="muted small">
            This excludes {selectedActive.length} selected value{selectedActive.length === 1 ? '' : 's'} —
            {' '}{selectedActiveNameCount} name{selectedActiveNameCount === 1 ? '' : 's'} combined — pool-wide, regardless of
            each name's own active flag.
          </p>
          <div className="actions">
            <input
              placeholder="reason (required)"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
            />
            <button
              className="btn btn--danger"
              onClick={confirmBulkDeactivate}
              disabled={busy || !bulkReason.trim()}
            >
              Confirm bulk deactivate
            </button>
            <button className="btn" onClick={cancelBulkDeactivate}>Cancel</button>
          </div>
        </div>
      )}

      <div className="draft-list">
        {rows.map((r) => (
          <div key={r.value} className="draft">
            <div className="draft__head">
              <input
                type="checkbox"
                checked={selected.has(r.value)}
                onChange={(e) => toggleSelect(r.value, e.target.checked)}
              />
              <strong>{r.value}</strong>
              <span className="pill">{r.count} name{r.count === 1 ? '' : 's'}</span>
              {r.deactivated
                ? <span className="pill pill--failed">deactivated</span>
                : <span className="pill pill--passed">active</span>}
              <span className="spacer" />
              {r.deactivated ? (
                <button className="btn" onClick={() => onReactivate(r.value)} disabled={busy}>Reactivate</button>
              ) : (
                pending !== r.value && (
                  <button className="btn btn--danger" onClick={() => { setBulkPending(false); setPending(r.value); }} disabled={busy}>Deactivate</button>
                )
              )}
            </div>

            {r.deactivated && (
              <p className="muted small">
                “{r.deactivated.reason}” — {new Date(r.deactivated.deactivatedAt).toLocaleString()}
              </p>
            )}

            {namePool && matchNames && (
              <details className="draft__names">
                <summary>{r.count} name{r.count === 1 ? '' : 's'} in this group</summary>
                <p className="muted small">
                  {r.count
                    ? namePool.filter((e) => matchNames(e, r.value)).map((e) => e.name).sort().join(', ')
                    : 'No names currently in this group.'}
                </p>
              </details>
            )}

            {pending === r.value && (
              <>
                <p className="muted small">
                  This excludes {r.count} name{r.count === 1 ? '' : 's'} pool-wide, regardless of each
                  name's own active flag.{note ? ` ${note(r.value)}` : ''}
                </p>
                <div className="actions">
                  <input
                    placeholder="reason (required)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <button
                    className="btn btn--danger"
                    onClick={() => confirm(r.value)}
                    disabled={busy || !reason.trim()}
                  >
                    Confirm deactivate
                  </button>
                  <button className="btn" onClick={cancel}>Cancel</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
