import React, { useState } from 'react';
import {
  getContentMode, setContentMode, hasConfirmedAge, confirmAge,
  getRegionChoice, setRegionChoice, getDetectedRegion,
} from '../prefs.js';
import { US_REGIONS, labelFor } from '@shared/regions.js';

export default function StartScreen({ onStart, llmEnabled, model }) {
  const [mode, setMode] = useState(getContentMode);
  const [askingAge, setAskingAge] = useState(false);
  const [region, setRegion] = useState(getRegionChoice);
  const detected = getDetectedRegion();

  const chooseRegion = (value) => {
    setRegion(value);
    setRegionChoice(value);
  };

  const chooseMode = (next) => {
    if (next === 'mature' && !hasConfirmedAge()) {
      setAskingAge(true);
      return;
    }
    setMode(next);
    setContentMode(next);
  };

  const acceptAge = () => {
    confirmAge();
    setMode('mature');
    setContentMode('mature');
    setAskingAge(false);
  };

  return (
    <div className="start">
      <div className="start__mark">
        <span className="start__mark-left">&larr;</span>
        <span className="start__mark-right">&rarr;</span>
      </div>

      <h1 className="start__title">LIFE<span>SWIPE</span></h1>
      <p className="start__tagline">One life. Two choices at a time.<br />Until you die or go broke.</p>

      {askingAge ? (
        <div className="agegate" role="dialog" aria-label="Age confirmation">
          <p className="agegate__title">Mature mode</p>
          <p className="agegate__body">
            Adds addiction, crime, prison and gambling arcs, written with
            consequence. No explicit sexual content in either mode.
          </p>
          <div className="agegate__actions">
            <button className="btn btn--ghost" onClick={() => setAskingAge(false)}>Not now</button>
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

      <ul className="start__rules">
        <li>You start at 16. The clock does not stop.</li>
        <li>Swipe left or right. There is no third option.</li>
        <li>Every choice compounds. Some of them wait years.</li>
      </ul>

      <button className="btn btn--primary btn--large" onClick={() => onStart(mode)}>Begin</button>

      <p className={`start__status start__status--${llmEnabled ? 'live' : 'offline'}`}>
        {llmEnabled ? `Storyteller: ${model}` : 'Storyteller offline - playing hand-written scenarios'}
      </p>
    </div>
  );
}
