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
 * tap teaches them the one mechanic they need for the whole life. No new UI
 * pattern is introduced until the beat, which has no choice to make at all.
 */
export default function Intro({ step, cards, beat, framing, onDecide, onContinue }) {
  if (step < cards.length) {
    const card = cards[step];
    const peek = cards[step + 1] || null;
    return (
      <>
        {framing && <p className="intro__framing">{framing}</p>}
        <CardStack card={card} peek={peek} onDecide={onDecide} disabled={false} />
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
    );
  }
  return <GroundingBeat beat={beat} onContinue={onContinue} />;
}
