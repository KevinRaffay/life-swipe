import React from 'react';

const Bar = ({ label, n, max }) => (
  <div className="bar">
    <span className="bar__label">{label}</span>
    <span className="bar__track"><span className="bar__fill" style={{ width: `${(n / (max || 1)) * 100}%` }} /></span>
    <span className="bar__n">{n}</span>
  </div>
);

const Group = ({ title, data }) => {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <div className="stat-group">
      <h3>{title}</h3>
      {entries.map(([k, n]) => <Bar key={k} label={k} n={n} max={max} />)}
    </div>
  );
};


const pct = (n) => `${Math.round((n || 0) * 100)}%`;

// Where the content came from, and how much of it the game wrote for itself.
//
// Read as a trend, not a threshold. Nothing enforces this number and nothing
// should: it is a content-diversity signal. A deck or a library that becomes
// mostly harvested-from-itself narrows toward the model's own most common
// outputs - the same few shapes, told back to itself - and the only way to
// notice that is to watch the share move between harvests. The amber styling
// above a third is a prompt to look, not a limit.
const HarvestShare = ({ provenance }) => {
  if (!provenance) return null;
  const share = provenance.harvestedShare || {};
  const tile = (value, label) => (
    <div className={`tile ${value > 0.33 ? 'tile--warn' : ''}`}>
      <b>{pct(value)}</b><span>{label}</span>
    </div>
  );
  return (
    <section className="card">
      <h2>Where the content came from</h2>
      <div className="tiles">
        {tile(share.combined, 'harvested overall')}
        {tile(share.seeds, 'of the seed deck')}
        {tile(share.patterns, 'of the library')}
      </div>
      <p className="muted small">
        “Harvested” content came out of the game’s own request log rather than
        from a person or from external source text. This is a signal to watch,
        not a limit anything enforces — a deck that becomes mostly harvested
        from itself narrows toward the model’s most common outputs over time.
        Records written before provenance was tracked count as hand-authored,
        because that is what they are.
      </p>
      <div className="row">
        <Group title="seed deck by source" data={provenance.seeds} />
        <Group title="library by source" data={provenance.patterns} />
        <Group title="drafts awaiting review" data={mergeCounts(provenance.drafts, provenance.seedDrafts)} />
      </div>
    </section>
  );
};

// The two draft queues share one panel: what matters at review time is how
// much unapproved content is harvested, not which file it is sitting in.
function mergeCounts(a, b) {
  const out = { ...(a || {}) };
  for (const [key, n] of Object.entries(b || {})) out[key] = (out[key] || 0) + n;
  return out;
}

export default function Stats({ stats }) {
  if (!stats) return <p className="muted">Loading…</p>;
  const x = stats.crossReference || {};
  return (
    <div className="pane">
      <section className="card">
        <h2>At a glance</h2>
        <div className="tiles">
          <div className="tile"><b>{stats.patterns.total}</b><span>patterns</span></div>
          <div className="tile"><b>{stats.seeds.total}</b><span>seed scenarios</span></div>
          <div className="tile"><b>{stats.drafts}</b><span>drafts awaiting review</span></div>
          <div className="tile"><b>{stats.threads === null ? '—' : stats.threads}</b>
            <span>{stats.threads === null ? 'threads (not in use)' : 'threads'}</span></div>
          <div className={`tile ${x.unreachablePatterns ? 'tile--warn' : ''}`}>
            <b>{x.unreachablePatterns ?? 0}</b><span>unreachable patterns</span></div>
          <div className="tile"><b>{x.inert ?? 0}</b><span>inert exclusions</span></div>
        </div>
        <p className="muted small">
          “Unreachable” means a <code>requires</code> flag that nothing in the
          library, the seed deck or the engine ever sets — a static check, and a
          different measurement from patterns that are simply rare in play.
        </p>
      </section>

      <HarvestShare provenance={stats.provenance} />

      <section className="card">
        <h2>Library</h2>
        <div className="row">
          <Group title="by category" data={stats.patterns.byCategory} />
          <Group title="by rarity" data={stats.patterns.byRarity} />
          <Group title="by mode" data={stats.patterns.byMode} />
        </div>
      </section>

      <section className="card">
        <h2>Seed deck</h2>
        <div className="row">
          <Group title="by stage" data={stats.seeds.byStage} />
          <Group title="by weight" data={stats.seeds.byWeight} />
          <Group title="by mode" data={stats.seeds.byMode} />
        </div>
      </section>
    </div>
  );
}
