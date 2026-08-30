import React, { useCallback, useEffect, useRef, useState } from 'react';

const EXIT_MS = 220;

// Nothing here is a decision, so every key that means "yes, go on" is accepted
// - including the two arrows the player has just used on both identity cards,
// which would otherwise be the one input that silently does nothing.
const CONTINUE_KEYS = ['Enter', ' ', 'Spacebar', 'Escape', 'ArrowLeft', 'ArrowRight'];

/**
 * The one non-interactive screen in the intro flow: a short establishing
 * scene, shown once, between the two identity choices and the first real
 * deck.draw() card.
 *
 * It is a popup over the intro screen, not a screen of its own - the same
 * backdrop + centered-dialog shape as ConsequenceModal (the player app's
 * other modal), so the two read as one pattern. The panel keeps the card's
 * gradient and ink because its body is major-tier `.scene` content, whose
 * colours are card colours; this is the first thing a player reads and
 * deserves that weight. There is nothing to choose, so it takes a plain
 * continue rather than a left/right swipe: a tap, a drag or a key all count,
 * and it listens on pointerup rather than click so a deliberate drag still
 * registers.
 *
 * `beat` is `{ setting, beat }` or null while the generation call
 * (fetchIntroBeat) is still in flight - see App.jsx's beginGroundingBeat.
 * Until it lands there is nothing to acknowledge, so every input is ignored.
 */
export default function GroundingBeat({ beat, onContinue }) {
  const [exiting, setExiting] = useState(false);
  const pointer = useRef(null);
  const dialogRef = useRef(null);
  const ready = Boolean(beat) && !exiting;

  const commit = useCallback(() => {
    if (!ready) return;
    setExiting(true);
    window.setTimeout(onContinue, EXIT_MS);
  }, [ready, onContinue]);

  // Focus the panel so a screen reader announces the dialog, and so the
  // keyboard is already inside it rather than on whatever the last card left
  // focused behind the backdrop.
  useEffect(() => { dialogRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (!CONTINUE_KEYS.includes(e.key)) return;
      e.preventDefault();
      commit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit]);

  // The gesture lives on the backdrop, not the panel, so tapping anywhere on
  // the darkened intro behind it continues too - the same "click outside to
  // dismiss" the consequence modal gives, where dismissing IS the continue.
  const onPointerDown = (e) => {
    if (!ready) return;
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerUp = (e) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    commit();
  };

  return (
    <div
      className={`grounding-backdrop${exiting ? ' is-exiting' : ''}${beat ? '' : ' grounding-backdrop--loading'}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { pointer.current = null; }}
    >
      <article
        className="grounding-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Where your life starts"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="grounding-modal__body" aria-live="polite">
          {beat ? (
            <div className="scene">
              <p className="scene__setting">{beat.setting}</p>
              <p className="scene__beat">{beat.beat}</p>
            </div>
          ) : (
            <p className="grounding-modal__loading">Getting your bearings&hellip;</p>
          )}
        </div>
        {beat && (
          <p className="grounding-modal__hint">tap, swipe, or press a key to continue</p>
        )}
      </article>
    </div>
  );
}
