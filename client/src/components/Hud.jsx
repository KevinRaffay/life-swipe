import React from 'react';

const money = (n) => {
  const v = Math.round(n);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs}`;
};

function Meter({ label, value, tone }) {
  return (
    <div className="meter" title={`${label}: ${Math.round(value)}/100`}>
      <span className="meter__label">{label}</span>
      <div className="meter__track">
        <div
          className={`meter__fill meter__fill--${tone}${value < 25 ? ' is-critical' : ''}`}
          style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  );
}

export default function Hud({ state, stage, storyteller, tier }) {
  const age = Math.floor(state.ageMonths / 12);
  const broke = state.money < 0;

  return (
    <header className="hud">
      <div className="hud__row">
        <div className="hud__age">
          <span className="hud__age-number">{age}</span>
          <span className="hud__age-label">years</span>
        </div>
        <div className="hud__stage">
          <span className="hud__stage-name">{stage.label}</span>
          <span className="hud__turn">swipe {state.turn + 1}</span>
        </div>
        <div className={`hud__money${broke ? ' is-broke' : ''}`}>{money(state.money)}</div>
      </div>

      <div className="hud__row hud__row--tags">
        <span
          className={`mode-chip mode-chip--${state.contentMode}`}
          title={
            state.contentMode === 'mature' && tier === 'safe'
              ? 'Mature life, but safe content is forced while under 18'
              : `${state.contentMode} mode`
          }
        >
          {state.contentMode === 'mature' ? 'MATURE' : 'SAFE'}
          {state.contentMode === 'mature' && tier === 'safe' && <em> · minor</em>}
        </span>
      </div>

      <div className="hud__row hud__row--meters">
        <Meter label="health" value={state.health} tone="health" />
        <Meter label="mood" value={state.happiness} tone="mood" />
      </div>

      {storyteller && (
        <div className={`hud__storyteller hud__storyteller--${storyteller.mode}`}>
          {storyteller.label}
        </div>
      )}
    </header>
  );
}

export { money };
