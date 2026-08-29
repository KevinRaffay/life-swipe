import React, { useRef, useState } from 'react';

const EXIT_MS = 220;

/**
 * The one non-interactive screen in the intro flow: a short establishing
 * scene, shown once, between the two identity choices and the first real
 * deck.draw() card. Reuses the major-tier card's visual treatment (`.card` /
 * `.scene__setting` / `.scene__beat`) since this is the first thing a player
 * reads in the game and deserves that weight - but there is nothing to choose
 * here, so it takes a plain continue, not a left/right swipe. A tap and a
 * swipe both count: this uses pointerup rather than click so a deliberate
 * drag still registers, the same as the card stack's own gesture.
 *
 * `beat` is `{ setting, beat }` or null while the generation call
 * (fetchIntroBeat) is still in flight - see App.jsx's beginGroundingBeat.
 */
export default function GroundingBeat({ beat, onContinue }) {
  const [exiting, setExiting] = useState(false);
  const pointer = useRef(null);

  const commit = () => {
    if (!beat || exiting) return;
    setExiting(true);
    window.setTimeout(onContinue, EXIT_MS);
  };

  const onPointerDown = (e) => {
    if (!beat || exiting) return;
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerUp = (e) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    commit();
  };

  return (
    <div className="card-stack">
      <article
        className={`card card--top intro-beat${exiting ? ' is-exiting' : ''}${beat ? '' : ' intro-beat--loading'}`}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { pointer.current = null; }}
      >
        {beat ? (
          <div className="scene">
            <p className="scene__setting">{beat.setting}</p>
            <p className="scene__beat">{beat.beat}</p>
          </div>
        ) : (
          <p className="intro-beat__loading-text">Getting your bearings&hellip;</p>
        )}
        {beat && (
          <div className="card__hint intro-beat__hint">
            <span>tap or swipe to continue</span>
          </div>
        )}
      </article>
    </div>
  );
}
