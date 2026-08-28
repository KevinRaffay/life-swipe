import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import seedScenarios from '@data/scenarios-seed.json';
import situationLibrary from '@library';
import { Deck } from '@shared/deck.js';
import {
  createState, applyChoice, stageOf, finalStats, stateSummary, recentDecisions, contentTier,
} from '@shared/engine.js';
import { nextRandom } from '@shared/rng.js';

import { fetchScenarios, getConfig, fetchRegion } from './api.js';
import {
  getSeenPatterns, markPatternSeen, getSeenSeedIds, markSeedSeen, beginLife,
  getActiveRegion, getDetectedRegion, setDetectedRegion,
} from './prefs.js';
import { librarySlotDue, scheduleNextSlot, selectPattern } from '@shared/library.js';
import CardStack from './components/CardStack.jsx';
import Hud from './components/Hud.jsx';
import EventToast from './components/EventToast.jsx';
import Obituary from './components/Obituary.jsx';
import StartScreen from './components/StartScreen.jsx';

export default function App() {
  const [phase, setPhase] = useState('title');       // title | playing | ended
  const [state, setState] = useState(null);
  const [cards, setCards] = useState([]);            // [current, peek]
  const [events, setEvents] = useState([]);
  const [config, setConfig] = useState({ llmEnabled: false, model: null });
  const deckRef = useRef(null);

  // decide() is handed to CardStack and fired from a timer, so it must always
  // read the latest values rather than whatever was current when it was built.
  const stateRef = useRef(state);
  const cardsRef = useRef(cards);
  const phaseRef = useRef(phase);
  stateRef.current = state;
  cardsRef.current = cards;
  phaseRef.current = phase;

  useEffect(() => { getConfig().then(setConfig); }, []);

  // Ask the server where this player probably is, once, and only if we have
  // not already been told. The answer is a suggested default that the settings
  // dropdown overrides; a failure leaves it null and names fall back to
  // era-only selection. Nothing here blocks the game starting.
  useEffect(() => {
    if (getDetectedRegion()) return;
    let cancelled = false;
    fetchRegion().then((code) => {
      if (!cancelled && code) setDetectedRegion(code);
    });
    return () => { cancelled = true; };
  }, []);

  // The deck's fetcher is the only place the client talks to the storyteller.
  // It is called in the background by Deck.maybeRefill and its failures are
  // absorbed there, so a dead API never blocks a swipe.
  // Read at deck construction, i.e. once per life, so changing the setting
  // takes effect on the next life rather than mid-story.
  const makeDeck = useCallback((region) => new Deck({
    seedScenarios,
    lookahead: 6,
    seenSeedIds: getSeenSeedIds(),
    onSeedShown: markSeedSeen,
    region,
    // Selection happens here, not on the server: it needs the run's RNG (so a
    // seeded life replays identically) and the cross-life seen list.
    onLibrarySlot: (gameState) => {
      if (!librarySlotDue(gameState)) return null;
      const pattern = selectPattern(gameState, situationLibrary, getSeenPatterns());
      scheduleNextSlot(gameState, () => nextRandom(gameState));
      return pattern;
    },
    fetchBatch: (gameState, librarySlot) => fetchScenarios({
      summary: stateSummary(gameState),
      recent: recentDecisions(gameState, 10),
      count: 5,
      librarySlot,
    }),
  }), []);

  // Mode is fixed at birth and never changes mid-life: switching would orphan
  // in-flight arcs and the flags they planted.
  const start = useCallback((contentMode = 'safe') => {
    // Advances the per-player life counter that the seen-window is measured in.
    beginLife();
    const region = getActiveRegion();
    const deck = makeDeck(region);
    deckRef.current = deck;
    const fresh = createState({ seed: `${Date.now()}-${Math.random()}`, contentMode, region });
    const first = deck.draw(fresh);
    const second = deck.draw(fresh);
    setState(fresh);
    setCards([first, second]);
    setEvents([]);
    setPhase('playing');
  }, [makeDeck]);

  const decide = useCallback((side) => {
    const state = stateRef.current;
    const cards = cardsRef.current;
    if (!state || state.ended || phaseRef.current !== 'playing') return;
    const card = cards[0];
    if (!card) return;

    if (card.libraryId) markPatternSeen(card.libraryId);
    const result = applyChoice(state, card, side);
    setEvents(result.events.filter((e) => e.text));

    if (result.ended) {
      setState(result.state);
      setCards([]);
      setPhase('ended');
      return;
    }

    // Draw against the NEW state so the next card fits who you now are.
    const deck = deckRef.current;
    const promoted = cards[1] || deck.draw(result.state);
    const nextPeek = deck.draw(result.state);
    setState(result.state);
    setCards([promoted, nextPeek]);
  }, []);

  const deltas = useMemo(() => {
    if (!state || !state.history.length) return null;
    const d = state.history[state.history.length - 1].delta;
    const parts = [];
    if (d.money) parts.push(`${d.money > 0 ? '+' : '-'}$${Math.abs(d.money).toLocaleString('en-US')}`);
    if (d.health) parts.push(`${d.health > 0 ? '+' : ''}${d.health} health`);
    if (d.happiness) parts.push(`${d.happiness > 0 ? '+' : ''}${d.happiness} mood`);
    return parts.length ? <span className="deltas">{parts.join('   ')}</span> : null;
  }, [state]);

  if (phase === 'title') {
    return (
      <main className="app">
        <StartScreen onStart={start} llmEnabled={config.llmEnabled} model={config.model} />
      </main>
    );
  }

  if (phase === 'ended') {
    return (
      <main className="app">
        <Obituary
          stats={finalStats(state)}
          history={state.history}
          onRestart={() => start(state.contentMode)}
        />
      </main>
    );
  }

  const deck = deckRef.current;
  const storyteller = config.llmEnabled
    ? { mode: deck && deck.ready() ? 'live' : 'thinking', label: deck && deck.ready() ? 'storyteller ready' : 'storyteller writing ahead' }
    : { mode: 'offline', label: 'offline deck' };

  return (
    <main className="app">
      <Hud state={state} storyteller={storyteller} tier={contentTier(state)} />

      <div className="stage-banner">
        <span className="stage-banner__rule" />
        <span className="stage-banner__label">{stageOf(state).label}</span>
        <span className="stage-banner__rule" />
      </div>

      <EventToast events={events} deltas={deltas} />

      <CardStack
        card={cards[0]}
        peek={cards[1]}
        onDecide={decide}
        disabled={phase !== 'playing'}
      />

      <div className="choices">
        <button className="choice choice--left" onClick={() => decide('left')}>
          {cards[0] ? cards[0].leftLabel : ''}
        </button>
        <button className="choice choice--right" onClick={() => decide('right')}>
          {cards[0] ? cards[0].rightLabel : ''}
        </button>
      </div>

      <p className="app__hint">drag the card, tap a choice, or use &larr; &rarr;</p>
    </main>
  );
}
