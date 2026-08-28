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
