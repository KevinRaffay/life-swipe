import React, { useCallback, useEffect, useRef, useState } from 'react';

const COMMIT_PX = 88;      // drag distance that counts as a decision
const FLICK_VELOCITY = 0.6; // px/ms - a fast flick commits at a shorter distance
const EXIT_MS = 260;

/**
 * The card stack. Pointer events (not touch events) so one code path covers
 * finger, mouse and pen. `touch-action: none` on the card stops the browser
 * from claiming the horizontal drag for scrolling.
 */
export default function CardStack({ card, peek, onDecide, disabled }) {
  const [drag, setDrag] = useState(0);
  const [exiting, setExiting] = useState(null); // 'left' | 'right'
  const pointer = useRef(null);
  const cardRef = useRef(null);
  const queued = useRef(null);

  // Any new deal resets the gesture state. Keyed on uid rather than id: the
  // deck can legitimately deal the same scenario twice, and if this effect
  // does not fire the card stays stuck mid-exit and stops accepting input.
  const dealId = card ? (card.uid ?? card.id) : null;
  useEffect(() => {
    setDrag(0);
    setExiting(null);
    pointer.current = null;

    // Replay an input that arrived mid-animation.
    if (queued.current) {
      const side = queued.current;
      queued.current = null;
      const t = window.setTimeout(() => commitRef.current(side), 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [dealId]);

  const commit = useCallback((side) => {
    if (disabled) return;
    if (exiting) { queued.current = side; return; }
    setExiting(side);
    window.setTimeout(() => {
      onDecide(side);
      // Clear the exit state ourselves rather than waiting for a new card to
      // arrive. If the parent no-ops (a stale handler re-dealing the same card)
      // the old code left this stuck true forever and the card stopped
      // accepting input for the rest of the run.
      setExiting(null);
      setDrag(0);
    }, EXIT_MS);
  }, [disabled, exiting, onDecide]);

  const commitRef = useRef(commit);
  useEffect(() => { commitRef.current = commit; }, [commit]);

  const onPointerDown = (e) => {
    if (disabled || exiting) return;
    pointer.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, startT: performance.now(), axis: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;

    // Lock to an axis once the gesture shows its intent, so a vertical scroll
    // on a small screen does not smear the card sideways.
    if (!p.axis && Math.abs(dx) + Math.abs(dy) > 10) {
      p.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (p.axis === 'y') return;
    setDrag(dx);
  };

  const onPointerUp = (e) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    pointer.current = null;

    const dx = e.clientX - p.startX;
    const dt = Math.max(1, performance.now() - p.startT);
    const velocity = Math.abs(dx) / dt;
    const decisive = Math.abs(dx) > COMMIT_PX || (velocity > FLICK_VELOCITY && Math.abs(dx) > 34);

    if (decisive) commit(dx < 0 ? 'left' : 'right');
    else setDrag(0);
  };

  // Desktop: arrow keys are first-class, not an afterthought.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); commit('left'); }
      if (e.key === 'ArrowRight') { e.preventDefault(); commit('right'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit]);

  if (!card) return <div className="card-stack" />;

  const offset = exiting ? (exiting === 'left' ? -700 : 700) : drag;
  const rotation = offset * 0.055;
  const intensity = Math.min(1, Math.abs(offset) / COMMIT_PX);
  const leaning = offset < 0 ? 'left' : 'right';

  const style = {
    transform: `translate3d(${offset}px, ${Math.abs(offset) * 0.04}px, 0) rotate(${rotation}deg)`,
    transition: exiting
      ? `transform ${EXIT_MS}ms cubic-bezier(.3,0,.4,1), opacity ${EXIT_MS}ms linear`
      : pointer.current ? 'none' : 'transform 260ms cubic-bezier(.2,1.2,.4,1)',
    opacity: exiting ? 0 : 1,
  };

  return (
    <div className="card-stack">
      {peek && (
        <article className="card card--peek" aria-hidden="true">
          <p className="card__text">{peek.scenario}</p>
        </article>
      )}

      <article
        ref={cardRef}
        className={`card card--top${exiting ? ' is-exiting' : ''}`}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className={`card__verdict card__verdict--left${leaning === 'left' ? ' is-active' : ''}`}
             style={{ opacity: leaning === 'left' ? intensity : 0 }}>
          {card.leftLabel}
        </div>
        <div className={`card__verdict card__verdict--right${leaning === 'right' ? ' is-active' : ''}`}
             style={{ opacity: leaning === 'right' ? intensity : 0 }}>
          {card.rightLabel}
        </div>

        <p className="card__text">{card.scenario}</p>
        <div className="card__hint" style={{ opacity: 1 - intensity }}>
          <span>&larr; {card.leftLabel}</span>
          <span>{card.rightLabel} &rarr;</span>
        </div>
      </article>
    </div>
  );
}

export { COMMIT_PX };
