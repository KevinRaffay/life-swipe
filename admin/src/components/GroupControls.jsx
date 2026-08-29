import React, { useState } from 'react';

/**
 * One panel for a pool-wide exclusion control. Category, region and
 * gender_assoc deactivation share this exact shape - a value, a live count of
 * the names it affects, and a required reason before it takes effect - so
 * this is written once and instantiated three times in NamePool.jsx rather
 * than duplicated.
 *
 * `rows` is `[{ value, count, deactivated: { reason, deactivatedAt } | null }]`.
 */
export default function GroupControls({ title, description, note, rows, busy, onDeactivate, onReactivate }) {
  const [pending, setPending] = useState(null); // the value mid-confirmation
  const [reason, setReason] = useState('');

  const confirm = async (value) => {
    const ok = await onDeactivate(value, reason);
    if (ok) { setPending(null); setReason(''); }
  };

  const cancel = () => { setPending(null); setReason(''); };

  return (
    <section className="card">
      <h2>{title}</h2>
      {description && <p className="muted small">{description}</p>}
      {rows.length === 0 && <p className="muted">Nothing to show.</p>}

      <div className="draft-list">
        {rows.map((r) => (
          <div key={r.value} className="draft">
            <div className="draft__head">
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
                  <button className="btn btn--danger" onClick={() => setPending(r.value)} disabled={busy}>Deactivate</button>
                )
              )}
            </div>

            {r.deactivated && (
              <p className="muted small">
                “{r.deactivated.reason}” — {new Date(r.deactivated.deactivatedAt).toLocaleString()}
              </p>
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
