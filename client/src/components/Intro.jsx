import React from 'react';
import CardStack from './CardStack.jsx';
import GroundingBeat from './GroundingBeat.jsx';
import FramingModal from './FramingModal.jsx';

/**
 * The four-step opening sequence, before the first deck.draw() card:
 * framing modal (required dismiss), two authored identity choices, then grounding beat.
 * `cards` is the two identity cards; `step` -1 shows framing, 0/1 show identity cards, 2 shows beat.
 *
 * The identity steps reuse CardStack - the exact same swipe gesture and
 * choice-button layout the rest of the game uses - so the player's very first
 * tap teaches them the one mechanic they need for the whole life.
 *
 * The framing modal is a dismissible popup that blocks interaction until cleared.
 * The grounding beat is also a popup over the (empty) card slot, dimming the background.
 * Everything still mounted is inert while a modal is up.
 */
export default function Intro({ step, cards, beat, framing, onDecide, onDismissFraming, onContinue }) {
  const showFraming = step === -1;
  const groundingBeat = step >= cards.length;
  const card = groundingBeat || showFraming ? null : cards[step];

  return (
    <>
      <CardStack
        card={card}
        peek={groundingBeat || showFraming ? null : cards[step + 1] || null}
        onDecide={onDecide}
        disabled={groundingBeat || showFraming}
      />
      {!groundingBeat && !showFraming && (
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
      {showFraming && <FramingModal framing={framing} onContinue={onDismissFraming} />}
      {groundingBeat && <GroundingBeat beat={beat} onContinue={onContinue} />}
    </>
  );
}
