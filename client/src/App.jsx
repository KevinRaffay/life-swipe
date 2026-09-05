import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import seedScenarios from '@data/scenarios-seed.json';
import demoSeedScenarios from '@data/demo-seed-scenarios.json';
import situationLibrary from '@library';
import { Deck } from '@shared/deck.js';
import {
  createState, applyChoice, stageOf, finalStats, stateSummary, recentDecisions, contentTier,
} from '@shared/engine.js';
import { nextRandom } from '@shared/rng.js';
import { buildIdentityCard, fallbackGroundingBeat, INTRO_CARD_ORDER, pickFramingLine } from '@shared/intro.js';

import { BAL } from '@shared/balance.js';

import { fetchScenarios, getConfig, fetchRegion, fetchIntroBeat } from './api.js';
import {
  getSeenPatterns, markPatternSeen, getSeenSeedIds, markSeedSeen, beginLife,
  getActiveRegion, getDetectedRegion, setDetectedRegion, getActiveTheme,
  hasConfirmedAge,
} from './prefs.js';
import { librarySlotDue, scheduleNextSlot, selectPattern } from '@shared/library.js';
import { classifyConsequence } from './severity.js';
import CardStack from './components/CardStack.jsx';
import Hud from './components/Hud.jsx';
import EventToast from './components/EventToast.jsx';
import Obituary from './components/Obituary.jsx';
import StartScreen from './components/StartScreen.jsx';
import Intro from './components/Intro.jsx';

export default function App() {
  const [phase, setPhase] = useState('title');       // title | intro | playing | ended
  const [state, setState] = useState(null);
  const [cards, setCards] = useState([]);            // [current, peek]
  const [events, setEvents] = useState([]);
  const [severity, setSeverity] = useState('standard');
  const [config, setConfig] = useState({ llmEnabled: false, model: null });
  // The intro sequence's own tiny bit of state - never persisted, and never
  // touched again once phase leaves 'intro'. introStep is 0/1 for the two
  // identity cards, 2 for the grounding beat; introBeat is null while that
  // beat's generation call is in flight (see beginGroundingBeat below).
  const [introCards, setIntroCards] = useState([]);
  const [introStep, setIntroStep] = useState(0);
  const [introBeat, setIntroBeat] = useState(null);
  const [introFraming, setIntroFraming] = useState(null);
  const deckRef = useRef(null);

  // decide() is handed to CardStack and fired from a timer, so it must always
  // read the latest values rather than whatever was current when it was built.
  const stateRef = useRef(state);
  const cardsRef = useRef(cards);
  const phaseRef = useRef(phase);
  const introCardsRef = useRef(introCards);
  const introStepRef = useRef(introStep);
  stateRef.current = state;
  cardsRef.current = cards;
  phaseRef.current = phase;
  introCardsRef.current = introCards;
  introStepRef.current = introStep;

  useEffect(() => { getConfig().then(setConfig); }, []);

  // Apply theme class to document root, update when theme preference changes.
  useEffect(() => {
    const root = document.documentElement;
    const theme = getActiveTheme();
    if (theme === 'dark') {
      root.classList.add('dark-theme');
    } else {
      root.classList.remove('dark-theme');
    }
  }, []);

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
  // in-flight arcs and the flags they planted. The deck is built here, same as
  // before, but its first draw() waits until the intro sequence hands off to
  // completeIntro below - the two identity cards and the grounding beat come
  // first, every life, never persisted across lives.
  const start = useCallback((contentMode = 'safe') => {
    // Advances the per-player life counter that the seen-window is measured in.
    beginLife();
    const region = getActiveRegion();
    const deck = makeDeck(region);
    deckRef.current = deck;
    const fresh = createState({ seed: `${Date.now()}-${Math.random()}`, contentMode, region });
    const rng = () => nextRandom(fresh);
    const identityCards = INTRO_CARD_ORDER.map((kind) => buildIdentityCard(kind, rng));
    const framing = pickFramingLine(rng);
    setState(fresh);
    setIntroCards(identityCards);
    setIntroStep(-1);
    setIntroBeat(null);
    setIntroFraming(framing);
    setEvents([]);
    setSeverity('standard');
    setPhase('intro');
  }, [makeDeck]);

  // A DEMO life. Three things make it different from `start` above, and
  // nothing else does - it is the same engine, the same deck class and the
  // same game loop:
  //
  //  1. Its deck reads the DEMO POOL and passes `demoMode`, so no swipe can
  //     ever trigger a live provider call. `fetchBatch` is left null as well;
  //     the flag is the half that cannot be forgotten (shared/deck.js).
  //  2. The life starts at 18 in mature mode. The age gate that guards mature
  //     selection has already been satisfied before this runs - StartScreen
  //     will not call it otherwise - and 18 SATISFIES the age invariant
  //     rather than dodging it, so `effectiveTier` is untouched.
  //  3. There is no intro phase. Demo mode goes straight to the first card,
  //     which is also why it makes no `/api/intro` call: skipping the phase
  //     skips the one generation call that sequence contains.
  //
  // The library slot is deliberately absent too: its only consumer is
  // `fetchBatch`, so a demo deck has nothing to brief.
  const startDemo = useCallback(() => {
    beginLife();
    const deck = new Deck({
      seedScenarios: demoSeedScenarios,
      demoMode: true,
      fetchBatch: null,
      seenSeedIds: getSeenSeedIds(),
      onSeedShown: markSeedSeen,
      region: getActiveRegion(),
    });
    deckRef.current = deck;
    const fresh = createState({
      seed: `demo-${Date.now()}-${Math.random()}`,
      contentMode: 'mature',
      startAge: BAL.DEMO.startAge,
      demoMode: true,
      region: getActiveRegion(),
    });
    setState(fresh);
    setEvents([]);
    setSeverity('standard');
    setCards([deck.draw(fresh), deck.draw(fresh)]);
    setPhase('playing');
  }, []);

  // A demo-booth / kiosk link: /?demo=1 starts a demo life on load. It does
  // NOT bypass the age gate - an unconfirmed visitor lands on the start
  // screen with the mature confirmation open, and the demo begins when they
  // accept. Read once on mount; the parameter is not watched afterwards.
  const [demoRequested, setDemoRequested] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('demo')) return;
    if (hasConfirmedAge()) startDemo();
    else setDemoRequested(true);
  }, [startDemo]);

  // Dismiss the opening framing modal and advance to the first identity card.
  const dismissFraming = useCallback(() => {
    if (phaseRef.current !== 'intro') return;
    setIntroStep(0);
  }, []);

  // The identity cards go through the exact same applyChoice/normalizeEffects
  // path as any real card (invariant 1) - this only decides what happens
  // around that call: advance to the next identity card, or move on to the
  // grounding beat once both have resolved. Death is astronomically unlikely
  // at 16 but not impossible, so it is handled here exactly like decide() does.
  const decideIntro = useCallback((side) => {
    const s = stateRef.current;
    const card = introCardsRef.current[introStepRef.current];
    if (!s || phaseRef.current !== 'intro' || !card) return;

    const result = applyChoice(s, card, side);
    if (result.ended) {
      setState(result.state);
      setPhase('ended');
      return;
    }
    setState(result.state);
    if (introStepRef.current < introCardsRef.current.length - 1) {
      setIntroStep(introStepRef.current + 1);
    } else {
      setIntroStep(introStepRef.current + 1); // -> the grounding beat step
      beginGroundingBeat(result.state);
    }
  }, []);

  // Kicks off the one generation call the intro flow makes, tagged
  // 'intro_generation' server-side so the harvester never sees it (this is a
  // fixed non-interactive beat, not a scenario a life could repeat). Same
  // "cannot fail" guarantee as deck.draw: any failure or timeout falls back to
  // shared/intro.js's authored beat, so the intro is never stuck waiting.
  const beginGroundingBeat = useCallback((s) => {
    const financialTier = s.flags.includes('comfortable_upbringing') ? 'comfortable_upbringing' : 'modest_upbringing';
    const personality = s.flags.includes('social') ? 'social' : 'bookish';
    fetchIntroBeat({ financialTier, personality, region: getActiveRegion() }).then((beat) => {
      setIntroBeat(beat || fallbackGroundingBeat(financialTier));
    });
  }, []);

  // The intro's last step: draw the first two real cards and hand off to the
  // ordinary game loop, exactly as start() used to do before the intro existed.
  const completeIntro = useCallback(() => {
    const s = stateRef.current;
    const deck = deckRef.current;
    if (!s || !deck || phaseRef.current !== 'intro') return;
    const first = deck.draw(s);
    const second = deck.draw(s);
    setCards([first, second]);
    setPhase('playing');
  }, []);

  const decide = useCallback((side) => {
    const state = stateRef.current;
    const cards = cardsRef.current;
    if (!state || state.ended || phaseRef.current !== 'playing') return;
    const card = cards[0];
    if (!card) return;

    if (card.libraryId) markPatternSeen(card.libraryId);
    const result = applyChoice(state, card, side);
    const newFlags = result.state.flags.filter((f) => !state.flags.includes(f));
    const lastDelta = result.state.history.length
      ? result.state.history[result.state.history.length - 1].delta
      : null;
    setEvents(result.events.filter((e) => e.text));
    setSeverity(classifyConsequence({ events: result.events, newFlags, delta: lastDelta }));

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
        <StartScreen
          onStart={start}
          onStartDemo={startDemo}
          demoRequested={demoRequested}
          llmEnabled={config.llmEnabled}
          model={config.model}
        />
      </main>
    );
  }

  if (phase === 'intro') {
    return (
      <main className="app">
        <Intro
          step={introStep}
          cards={introCards}
          beat={introBeat}
          framing={introFraming}
          onDecide={decideIntro}
          onDismissFraming={dismissFraming}
          onContinue={completeIntro}
        />
      </main>
    );
  }

  if (phase === 'ended') {
    return (
      <main className="app">
        <Obituary
          stats={finalStats(state)}
          history={state.history}
          demoMode={state.demoMode === true}
          onRestart={() => (state.demoMode ? startDemo() : start(state.contentMode))}
        />
      </main>
    );
  }

  const deck = deckRef.current;
  // A demo life has no storyteller at all, and says so rather than borrowing
  // the "offline" label - offline means the model was unreachable, which is a
  // degraded state. This one is the design.
  const storyteller = state.demoMode
    ? { mode: 'demo', label: 'demo deck - no storyteller' }
    : config.llmEnabled
      ? { mode: deck && deck.ready() ? 'live' : 'thinking', label: deck && deck.ready() ? 'storyteller ready' : 'storyteller writing ahead' }
      : { mode: 'offline', label: 'offline deck' };

  return (
    <main className="app">
      <Hud
        state={state}
        storyteller={storyteller}
        tier={contentTier(state)}
        swipeCap={state.demoMode ? BAL.DEMO.maxSwipes : null}
      />

      <div className="stage-banner">
        <span className="stage-banner__rule" />
        <span className="stage-banner__label">{stageOf(state).label}</span>
        <span className="stage-banner__rule" />
      </div>

      <EventToast events={events} deltas={deltas} severity={severity} />

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
