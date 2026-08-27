import React from 'react';

export default function StartScreen({ onStart, llmEnabled, model }) {
  return (
    <div className="start">
      <div className="start__mark">
        <span className="start__mark-left">&larr;</span>
        <span className="start__mark-right">&rarr;</span>
      </div>

      <h1 className="start__title">LIFE<span>SWIPE</span></h1>
      <p className="start__tagline">One life. Two choices at a time.<br />Until you die or go broke.</p>

      <ul className="start__rules">
        <li>You start at 16. The clock does not stop.</li>
        <li>Swipe left or right. There is no third option.</li>
        <li>Every choice compounds. Some of them wait years.</li>
      </ul>

      <button className="btn btn--primary btn--large" onClick={onStart}>Begin</button>

      <p className={`start__status start__status--${llmEnabled ? 'live' : 'offline'}`}>
        {llmEnabled
          ? `Storyteller: ${model}`
          : 'Storyteller offline - playing hand-written scenarios'}
      </p>
    </div>
  );
}
