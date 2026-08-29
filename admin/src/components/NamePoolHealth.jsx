import React, { useEffect, useState } from 'react';
import * as api from '../api.js';

/**
 * Advisory measurements over the current on-disk pool + controls - the same
 * numbers `npm run names` prints, computed by the same shared function
 * (server/name-pool-health.js) so the two never disagree. Nothing here blocks
 * a save; it exists so a person notices a problem before a player does.
 */
export default function NamePoolHealth({ refreshKey }) {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getNamePoolHealth()
      .then((h) => { if (!cancelled) setHealth(h); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (error) return <p className="error">Could not load pool health: {error}</p>;
  if (!health) return <p className="muted">Loading pool health…</p>;

  const overrepresented = health.categorySpread.filter((c) => c.overrepresented && !c.deactivated);

  return (
    <section className="card">
      <h2>Pool health</h2>
      <div className="tiles">
        <div className="tile"><b>{health.total}</b><span>names total</span></div>
        <div className={`tile ${health.inactive ? 'tile--warn' : ''}`}><b>{health.inactive}</b><span>inactive</span></div>
        <div className="tile"><b>{health.eligible}</b><span>eligible for selection</span></div>
        <div className="tile"><b>{health.categoriesTotal}</b><span>categories</span></div>
        <div className={`tile ${health.deactivatedCategories.length ? 'tile--warn' : ''}`}>
          <b>{health.deactivatedCategories.length}</b><span>categories deactivated</span>
        </div>
        <div className={`tile ${health.deactivatedRegions.length ? 'tile--warn' : ''}`}>
          <b>{health.deactivatedRegions.length}</b><span>regions deactivated</span>
        </div>
        <div className={`tile ${health.deactivatedGenderAssocs.length ? 'tile--warn' : ''}`}>
          <b>{health.deactivatedGenderAssocs.length}</b><span>gender_assocs deactivated</span>
        </div>
      </div>

      {health.duplicateNames.length > 0 && (
        <p className="error small">Duplicate name entries: {health.duplicateNames.join(', ')}</p>
      )}
      {overrepresented.length > 0 && (
        <p className="muted small">
          Overrepresented categories: {overrepresented.map((c) => `${c.category} (${(c.share * 100).toFixed(1)}%)`).join(', ')}
        </p>
      )}
      {health.eraCoverageGaps.length > 0 && (
        <p className="muted small">No name covers era window(s): {health.eraCoverageGaps.join(', ')}</p>
      )}
      {health.zeroCandidateWarnings.length > 0 && (
        <p className="muted small">
          {health.zeroCandidateWarnings.length} era+gender combination(s) would resolve to zero eligible
          candidates before the engine's reuse-a-name fallback, e.g.{' '}
          {health.zeroCandidateWarnings.slice(0, 5).map((w) => `${w.year} (${w.want})`).join(', ')}.
        </p>
      )}
      <p className="muted small">
        Advisory only — nothing here blocks a save. Region is not swept on its own: it only ever
        weights among already-eligible names (see shared/names.js), so it cannot by itself
        produce a zero-candidate combination.
      </p>
    </section>
  );
}
