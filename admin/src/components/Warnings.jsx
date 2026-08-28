import React, { useState } from 'react';

/**
 * The cross-reference results. Dismissible, never a gate: some flags come from
 * free-generated scenarios this check cannot see, so it reports suspicions for
 * a human to judge, not verdicts.
 */
export default function Warnings({ result, onRefresh }) {
  const [dismissed, setDismissed] = useState(false);
  if (!result) return null;
  const { warnings = [], stats = {} } = result;
  if (dismissed) {
    return (
      <div className="warnings warnings--collapsed">
        <button className="link" onClick={() => setDismissed(false)}>
          show {warnings.length} cross-reference warning{warnings.length === 1 ? '' : 's'}
        </button>
      </div>
    );
  }

  return (
    <div className="warnings">
      <div className="warnings__head">
        <strong>Cross-reference</strong>
        <span className="muted">
          {stats.unreachablePatterns || 0} unreachable · {stats.inert || 0} inert ·{' '}
          {stats.brokenReferences || 0} broken refs · {stats.settableFlags || 0} flags settable
        </span>
        <span className="spacer" />
        <button className="link" onClick={onRefresh}>re-run</button>
        <button className="link" onClick={() => setDismissed(true)}>dismiss</button>
      </div>

      {warnings.length === 0 ? (
        <p className="muted small">
          Nothing flagged. Every <code>requires</code> flag can be set somewhere.
        </p>
      ) : (
        <ul className="warnings__list">
          {warnings.map((w, i) => (
            <li key={i} className={`warn warn--${w.severity}`}>
              <span className="warn__tag">{w.severity}</span> {w.message}
            </li>
          ))}
        </ul>
      )}

      <p className="muted small">
        Static analysis only: it asks whether any content file or the engine can
        ever set a flag. The storyteller invents flags freely on ordinary cards,
        so a warning here is a question, not a defect — and this is a different
        measurement from “dead in simulation”, which is about chains that cannot
        complete within one life.
      </p>
    </div>
  );
}
