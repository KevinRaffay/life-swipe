import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const COMMIT_PX = 88;      // drag distance that counts as a decision
const FLICK_VELOCITY = 0.6; // px/ms - a fast flick commits at a shorter distance
const EXIT_MS = 260;

/**
 * The card stack. Pointer events (not touch events) so one code path covers
 * finger, mouse and pen. `touch-action: none` on the card stops the browser
 * from claiming the horizontal drag for scrolling.
 */

/**
 * A card is written in tiers: minor is a bare prompt, standard adds a setting,
 * major adds a beat and one line of dialogue. Every field is optional except
 * the prompt, so a minor card renders as a single line with no empty scaffolding.
 */
function ScenarioBody({ card }) {
  if (!card) return null;
  return (
    <div className="scene">
      {card.setting && <p className="scene__setting">{card.setting}</p>}
      {card.beat && <p className="scene__beat">{card.beat}</p>}
      {card.dialogue && <p className="scene__dialogue">{card.dialogue}</p>}
      <p className="scene__prompt card__text">{card.prompt || card.scenario}</p>
    </div>
  );
}

/* -------------------------------------------------------------- fitting */

// How far the type may shrink before we stop and let the card clip. Below this
// it stops being readable on a phone, and a card that needs it is a content
// bug - a major card is budgeted at 60-90 words and narrativeWarnings already
// logs the ones that blow past it - rather than something the layout should go
// on absorbing silently.
const FIT_MIN = 0.62;
// Halvings of the 0.38-wide range. Seven lands within about half a percent,
// which is finer than a rendered pixel at these sizes.
const FIT_STEPS = 7;

/**
 * Shrink a card's type until its content fits, so nothing is clipped and the
 * card never scrolls.
 *
 * Why measure instead of choosing sizes in CSS: how much text fits depends on
 * where the lines happen to wrap, which depends on the words themselves. Two
 * cards of identical character count can differ by two lines. A media query
 * cannot see that; only the laid-out box can.
 *
 * Binary search rather than one height ratio, for the same reason - halving
 * the font does not halve the height, because wrapping moves in steps. Seven
 * passes, each a forced reflow of one small subtree, on an event that happens
 * when a person swipes. Nowhere near a hot path.
 *
 * useLayoutEffect so the scale lands before paint; in an ordinary effect every
 * deal shows one frame of oversized text first.
 */
function useFitToCard(cardRef, dealKey) {
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const scene = card.querySelector('.scene');
    if (!scene) return undefined;

    const fit = () => {
      const styles = window.getComputedStyle(card);
      const available = card.clientHeight
        - parseFloat(styles.paddingTop || 0)
        - parseFloat(styles.paddingBottom || 0);
      // Not laid out yet - a zero-height stack mid-transition, or display:none.
      // Leaving --fit alone beats deriving a scale from a meaningless box.
      if (!(available > 0)) return;

      const fitsAt = (scale) => {
        card.style.setProperty('--fit', String(scale));
        return scene.scrollHeight <= available;
      };

      if (fitsAt(1)) return;            // the common case: nothing to do

      let low = FIT_MIN;                // the floor, taken whether or not it fits
      let high = 1;                     // known not to fit
      let best = FIT_MIN;
      for (let i = 0; i < FIT_STEPS; i++) {
        const mid = (low + high) / 2;
        if (fitsAt(mid)) { best = mid; low = mid; } else { high = mid; }
      }
      card.style.setProperty('--fit', String(best));
    };

    fit();

    // Rotation, a resized window, a mobile address bar sliding away: the
    // available height changes without the card changing. Observed on the
    // STACK, not the card - the callback writes to the card, and observing
    // what you mutate is how a ResizeObserver loop starts.
    const stack = card.parentElement;
    if (!stack || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [cardRef, dealKey]);
}

export default function CardStack({ card, peek, onDecide, disabled }) {
  const [drag, setDrag] = useState(0);
  const [exiting, setExiting] = useState(null); // 'left' | 'right'
  const pointer = useRef(null);
  const cardRef = useRef(null);
  const peekRef = useRef(null);
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

  // Both cards are fitted: the peek is dimmed and scaled, not hidden, so an
  // overflowing one still shows a clipped line behind the top card.
  useFitToCard(cardRef, dealId);
  useFitToCard(peekRef, peek ? (peek.uid ?? peek.id) : null);

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
        <article className="card card--peek" aria-hidden="true" ref={peekRef}>
          <ScenarioBody card={peek} />
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

        <ScenarioBody card={card} />
        <div className="card__hint" style={{ opacity: 1 - intensity }}>
          <span>&larr; {card.leftLabel}</span>
          <span>{card.rightLabel} &rarr;</span>
        </div>
      </article>
    </div>
  );
}

export { COMMIT_PX };
