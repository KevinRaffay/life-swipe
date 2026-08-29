import React from 'react';
import CardStack from './CardStack.jsx';
import GroundingBeat from './GroundingBeat.jsx';

/**
 * The three-step opening sequence, before the first deck.draw() card: two
 * authored identity choices (shared/intro.js), then a non-interactive
 * grounding beat. `cards` is always the two identity cards, dealt once at
 * `start()`; `step` 0/1 shows one of them, `step` 2 shows the beat.
 *
 * The identity steps reuse CardStack - the exact same swipe gesture and
 * choice-button layout the rest of the game uses - so the player's very first
 * tap teaches them the one mechanic they need for the whole life.
 *
 * The beat is a popup over that same screen rather than a replacement for it:
 * the framing line and the (now empty) card slot stay mounted underneath, so
 * the intro dims and holds its shape instead of blanking. The choice buttons
 * go, because the card they belonged to has just been swiped away. Everything
 * still mounted is inert while the dialog is up - `disabled` is what stops
 * CardStack's window-level arrow-key handler from firing under it, since the
 * backdrop only swallows pointers; the dialog's own `aria-modal` is what
 * takes the rest out of the accessibility tree, same as ConsequenceModal.
 */
export default function Intro({ step, cards, beat, framing, onDecide, onContinue }) {
  const groundingBeat = step >= cards.length;
  const card = groundingBeat ? null : cards[step];

  return (
    <>
      {framing && <p className="intro__framing">{framing}</p>}
      <CardStack
        card={card}
        peek={groundingBeat ? null : cards[step + 1] || null}
        onDecide={onDecide}
        disabled={groundingBeat}
      />
      {!groundingBeat && (
        <>
          <div className="choices">
            <button className="choice choice--left" onClick={() => onDecide('left')}>
              {card ? card.leftLabel : ''}
            </button>
            <button className="choice choice--right" onClick={() => onDecide('right')}>
              {card ? card.rightLabel : ''}
            </button>
          </div>
          <p className="app__hint">drag the card, tap a choice, or use &larr; &rarr;</p>
        </>
      )}
      {groundingBeat && <GroundingBeat beat={beat} onContinue={onContinue} />}
    </>
  );
}
