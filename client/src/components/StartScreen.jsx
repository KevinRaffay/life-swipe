import React, { useState } from 'react';
import {
  getContentMode, setContentMode, hasConfirmedAge, confirmAge,
  getRegionChoice, setRegionChoice, getDetectedRegion, getTheme, setTheme, getActiveTheme,
} from '../prefs.js';
import { US_REGIONS, labelFor } from '@shared/regions.js';
import { BAL } from '@shared/balance.js';

// `onStartDemo` is a deliberately SEPARATE entry point, not a third value of
// the Safe/Mature picker: demo mode is a short fixed-format sample, not a
// permanent mode a player picks for a real life, and putting it in that
// radiogroup would say otherwise. `demoRequested` is the /?demo=1 kiosk link
// arriving with the age gate not yet satisfied - the gate still runs, it just
// opens by itself.
export default function StartScreen({ onStart, onStartDemo, demoRequested = false, llmEnabled, model }) {
  const [mode, setMode] = useState(getContentMode);
  // null = closed. 'mature' = confirming to pick mature mode. 'demo' = confirming
  // to start a demo life. One dialog, two callers, because the confirmation
  // being asked for is the same one - the demo is mature content too, so it
  // goes through the identical gate rather than around it.
  const [askingAge, setAskingAge] = useState(demoRequested ? 'demo' : null);
  const [region, setRegion] = useState(getRegionChoice);
  const [theme, setThemeLocal] = useState(getTheme);
  const detected = getDetectedRegion();
  const activeTheme = getActiveTheme();

  const chooseRegion = (value) => {
    setRegion(value);
    setRegionChoice(value);
  };

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : theme === 'dark' ? null : 'light';
    setThemeLocal(next);
    setTheme(next);
    const root = document.documentElement;
    if (next === 'dark') {
      root.classList.add('dark-theme');
    } else {
      root.classList.remove('dark-theme');
    }
  };

  const chooseMode = (next) => {
    if (next === 'mature' && !hasConfirmedAge()) {
      setAskingAge('mature');
      return;
    }
    setMode(next);
    setContentMode(next);
  };

  // Demo mode is mature content, so it goes through the SAME gate - never
  // around it. An already-confirmed player starts immediately; anyone else
  // sees the dialog and starts on accept.
  const beginDemo = () => {
    if (!hasConfirmedAge()) {
      setAskingAge('demo');
      return;
    }
    onStartDemo();
  };

  const acceptAge = () => {
    const forDemo = askingAge === 'demo';
    confirmAge();
    setAskingAge(null);
    if (forDemo) {
      onStartDemo();
      return;
    }
    setMode('mature');
    setContentMode('mature');
  };

  return (
    <div className="start">
      <div className="start__mark">
        <span className="start__mark-left">&larr;</span>
        <span className="start__mark-right">&rarr;</span>
      </div>

      <h1 className="start__title">FATE</h1>
      <p className="start__tagline">One life. Two choices at a time.<br />Until you die or go broke.</p>

      {askingAge ? (
        <div className="agegate" role="dialog" aria-label="Age confirmation">
          <p className="agegate__title">{askingAge === 'demo' ? 'Quick demo' : 'Mature mode'}</p>
          <p className="agegate__body">
            {askingAge === 'demo'
              ? 'The demo runs on mature content: addiction, crime, gambling and vice, written for laughs and consequence. No explicit sexual content in either mode.'
              : 'Adds addiction, crime, prison and gambling arcs, written with consequence. No explicit sexual content in either mode.'}
          </p>
          <div className="agegate__actions">
            <button className="btn btn--ghost" onClick={() => setAskingAge(null)}>Not now</button>
            <button className="btn btn--primary" onClick={acceptAge}>I am 18 or older</button>
          </div>
        </div>
      ) : (
        <div className="modes" role="radiogroup" aria-label="Content mode">
          {['safe', 'mature'].map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={`mode-pill mode-pill--${m}${mode === m ? ' is-on' : ''}`}
              onClick={() => chooseMode(m)}
            >
              <span className="mode-pill__name">{m === 'safe' ? 'Safe' : 'Mature'}</span>
              <span className="mode-pill__desc">
                {m === 'safe' ? 'Money, health, love, loss' : 'Also addiction, crime, vice'}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="region">
        <label className="region__label" htmlFor="region-select">
          Where you are
        </label>
        <select
          id="region-select"
          className="region__select"
          value={region}
          onChange={(e) => chooseRegion(e.target.value)}
        >
          <option value="auto">
            Auto-detect{detected ? ` (${labelFor(detected)})` : ''}
          </option>
          <option value="none">No regional flavour</option>
          <optgroup label="United States">
            {US_REGIONS.map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </optgroup>
        </select>
        <p className="region__note">
          Nudges what the people you meet are called. Detection is often wrong
          on a VPN or a phone &mdash; set it yourself and it stays set.
        </p>
      </div>

      <div className="theme-toggle">
        <label htmlFor="theme-btn" className="theme-toggle__label">
          {theme === null ? 'Light/dark' : theme === 'light' ? 'Light' : 'Dark'}
        </label>
        <button
          id="theme-btn"
          className="btn theme-toggle__btn"
          onClick={toggleTheme}
          title={`Switch theme (now: ${activeTheme})`}
          aria-label={`Switch theme (now: ${activeTheme})`}
        >
          {activeTheme === 'light' ? '☀️' : '🌙'}
        </button>
      </div>

      <ul className="start__rules">
        <li>You start at 16. The clock does not stop.</li>
        <li>Swipe left or right. There is no third option.</li>
        <li>Every choice compounds. Some of them wait years.</li>
      </ul>

      <button className="btn btn--primary btn--large" onClick={() => onStart(mode)}>Begin</button>

      {/* Below the fold of the real game, behind a rule, in smaller type: a
          demo is a sample, not a fourth thing to weigh up against Safe and
          Mature. Deliberately NOT a mode pill. */}
      <div className="start__demo">
        <span className="start__demo-rule" />
        <button className="start__demo-link" onClick={beginDemo}>
          Just show me &mdash; {BAL.DEMO.maxSwipes} swipes, a few minutes
        </button>
        <p className="start__demo-note">
          A short mature-only life starting at 18. No storyteller, no waiting.
        </p>
      </div>

      <p className={`start__status start__status--${llmEnabled ? 'live' : 'offline'}`}>
        {llmEnabled ? `Storyteller: ${model}` : 'Storyteller offline - playing hand-written scenarios'}
      </p>
    </div>
  );
}
