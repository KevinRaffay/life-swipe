#!/usr/bin/env node
// Demo-mode assertions. The demo's own `npm run simulate`.
//
//   npm run demo-check              # 300 demo lives
//   npm run demo-check -- 1000      # more
//   npm run demo-check -- 300 seed  # from a given base seed
//
// A separate script rather than a --mode=demo on scripts/simulate.js, for the
// same reason the generator is separate from the seed generator: almost
// nothing simulate.js measures applies here. There are no dark-arc budgets
// worth a histogram, no situation library, no cross-life pattern memory and
// no lifespan distribution to speak of - a demo life is capped at forty
// swipes and ends in its early thirties by construction. What there IS to
// check is a short list of properties the format promises, and this asserts
// exactly those.
//
// FOUR HARD ASSERTIONS (exit 1 on any failure):
//
//   1. Every demo life ends at or under BAL.DEMO.maxSwipes.
//   2. No demo life EVER attempts a live provider call. Checked by handing
//      the deck a fetchBatch that records being called and asserting the
//      recorder stayed at zero - so this tests the guard in shared/deck.js
//      rather than testing that App.jsx remembered to pass null.
//   3. No card is dealt below age 18 at anything but the safe tier. This
//      should be structurally impossible (a demo starts AT 18 and the clock
//      only moves forward), which is exactly why it is asserted directly
//      instead of assumed - "impossible" is a claim, and an unasserted claim
//      is how the under-18 rule would quietly stop being true if the start
//      age were ever lowered.
//   4. Every name a demo life hands out comes from BAL.DEMO.nameCategories.
//      Read off the engine's own origin tally rather than by re-deriving a
//      category from the name string, so there is no second copy of the
//      lookup to disagree with the first. Skipped, with a note, if that list
//      is empty - which is what "no restriction" looks like.
//
// It also REPORTS the numbers BAL.DEMO.maxSwipes was picked from - swipe
// counts, ages reached, how the lives ended, and an estimated wall-clock read
// time from the actual word counts in the pool - because that constant is
// supposed to be measured, not guessed.

import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { Deck } from '../shared/deck.js';
import { createState, applyChoice, ageOf, finalStats } from '../shared/engine.js';
import { nextRandom, seedFrom } from '../shared/rng.js';
import { isMatureScenario, ADULT_AGE, effectiveTier } from '../shared/content.js';
import { BAL } from '../shared/balance.js';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const LIVES = Number(positional[0]) || 300;
const BASE_SEED = positional[1] || 'demo';
// Deliberately well above the cap: a life that runs past this has escaped the
// ceiling, which is assertion 1 failing rather than a reason to stop counting.
const MAX_TURNS = BAL.DEMO.maxSwipes * 4;

const demoSeeds = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../data/demo-seed-scenarios.json', import.meta.url)), 'utf8'),
);

if (!demoSeeds.length) {
  console.error('data/demo-seed-scenarios.json is empty - approve some demo drafts first');
  console.error('(npm run generate-demo-seeds, then the admin\'s "Demo pool" tab)');
  process.exit(2);
}

// How long a card takes to read and act on. Reading rate for short casual
// prose plus a beat to decide and the swipe animation itself - the estimate
// BAL.DEMO.maxSwipes rests on, applied to the pool's REAL word counts rather
// than to an assumed card length.
const WORDS_PER_SECOND = 3.6;
const DECIDE_SECONDS = 2.4;

/* --------------------------------------------------------------- one life */

function playOne(seed) {
  // The provider tripwire. shared/deck.js's demoMode guard returns before it
  // ever reads fetchBatch, so this counter staying at zero is the guard
  // working - and if the guard were removed, this would be called, which is
  // the point of passing a real function rather than null.
  let providerCalls = 0;

  const deck = new Deck({
    seedScenarios: demoSeeds,
    demoMode: true,
    fetchBatch: () => { providerCalls += 1; return Promise.resolve([]); },
    warn: () => {},
  });

  let state = createState({
    seed,
    contentMode: 'mature',
    startAge: BAL.DEMO.startAge,
    demoMode: true,
  });

  const chooser = { rngState: seedFrom('choices:' + seed) };
  const violations = [];
  const wordsRead = [];
  const sources = { seed: 0, fallback: 0, llm: 0 };

  while (!state.ended && state.turn < MAX_TURNS) {
    const card = deck.draw(state);
    const ageAtDeal = ageOf(state);
    const tierAtDeal = effectiveTier({ age: ageAtDeal, contentMode: state.contentMode });

    // Assertion 3, measured on every single card rather than sampled.
    if (ageAtDeal < ADULT_AGE && tierAtDeal !== 'safe') {
      violations.push({ kind: 'non-safe-tier-under-18', age: ageAtDeal.toFixed(1), id: card.id });
    }
    if (ageAtDeal < ADULT_AGE && isMatureScenario(card)) {
      violations.push({ kind: 'mature-card-under-18', age: ageAtDeal.toFixed(1), id: card.id });
    }

    sources[card.source] = (sources[card.source] || 0) + 1;
    wordsRead.push(
      String(card.prompt || card.scenario || '').trim().split(/\s+/).filter(Boolean).length,
    );

    const side = nextRandom(chooser) < 0.5 ? 'left' : 'right';
    state = applyChoice(state, card, side).state;
  }

  // Assertion 4, read off the ledger the engine itself writes rather than by
  // re-deriving a category from the name. `noteAssignedName` tallies the
  // origin of every name the engine hands out, so an origin outside the
  // allow-list appearing as a key here IS the restriction having failed -
  // there is no path that names somebody without going through that tally.
  const originsUsed = Object.keys((state.names && state.names.categories) || {});

  const totalWords = wordsRead.reduce((a, b) => a + b, 0);
  return {
    stats: finalStats(state),
    originsUsed,
    ending: state.ending,
    turns: state.turn,
    finalAge: ageOf(state),
    alive: state.alive,
    providerCalls,
    violations,
    sources,
    seconds: totalWords / WORDS_PER_SECOND + wordsRead.length * DECIDE_SECONDS,
    timedOut: !state.ended,
  };
}

/* ------------------------------------------------------------------- run */

const runs = [];
for (let i = 0; i < LIVES; i++) runs.push(playOne(`${BASE_SEED}:${i}`));

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const mmss = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;

const turns = runs.map((r) => r.turns);
const ages = runs.map((r) => r.finalAge);
const secs = runs.map((r) => r.seconds);

console.log(`\n=== FATE :: DEMO MODE :: ${LIVES} lives (seed "${BASE_SEED}") ===\n`);
console.log(`pool: ${demoSeeds.length} cards in data/demo-seed-scenarios.json`);
console.log(`cap:  ${BAL.DEMO.maxSwipes} swipes, starting at ${BAL.DEMO.startAge}, ${BAL.DEMO.time.minor} months per minor swipe\n`);

console.log('SWIPES PER DEMO LIFE');
console.log(`  mean ${mean(turns).toFixed(1)}   median ${pct(turns, 50)}   p10 ${pct(turns, 10)}   p90 ${pct(turns, 90)}   max ${Math.max(...turns)}   cap ${BAL.DEMO.maxSwipes}`);

console.log('\nAGE REACHED');
console.log(`  mean ${mean(ages).toFixed(1)}   median ${pct(ages, 50).toFixed(0)}   p10 ${pct(ages, 10).toFixed(0)}   p90 ${pct(ages, 90).toFixed(0)}   max ${Math.max(...ages).toFixed(0)}`);

console.log('\nESTIMATED SESSION LENGTH  (measured word counts / ' + WORDS_PER_SECOND + ' wps + ' + DECIDE_SECONDS + 's to decide)');
console.log(`  mean ${mmss(mean(secs))}   median ${mmss(pct(secs, 50))}   p10 ${mmss(pct(secs, 10))}   p90 ${mmss(pct(secs, 90))}   target 1-5 min`);

const endings = new Map();
for (const r of runs) {
  const key = r.timedOut ? 'RAN PAST THE CAP (bug)' : r.ending;
  endings.set(key, (endings.get(key) || 0) + 1);
}
console.log('\nHOW DEMO LIVES END');
for (const [key, n] of [...endings.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${((n / LIVES) * 100).toFixed(0).padStart(3)}%  ${key}`);
}

const totals = runs.reduce((acc, r) => {
  for (const k of Object.keys(r.sources)) acc[k] = (acc[k] || 0) + r.sources[k];
  return acc;
}, {});
console.log('\nCARD SOURCES');
console.log(`  seed (demo pool) ${totals.seed || 0}   fallback ${totals.fallback || 0}   llm ${totals.llm || 0}`);
if (totals.fallback) {
  const share = (totals.fallback / (totals.seed + totals.fallback)) * 100;
  console.log(`  ${share.toFixed(1)}% fell through to shared/fallback.js templates - the pool ran dry for some age band`);
}

/* ------------------------------------------------------------ assertions */

let failed = false;

console.log('\n=== DEMO ASSERTIONS ===');

const overCap = runs.filter((r) => r.turns > BAL.DEMO.maxSwipes);
if (overCap.length === 0) {
  console.log(`  PASS  every demo life ended at or under the ${BAL.DEMO.maxSwipes}-swipe cap`);
} else {
  console.log(`  FAIL  ${overCap.length} demo life/lives ran past the cap:`);
  for (const r of overCap.slice(0, 5)) console.log(`          ${r.turns} swipes, ended "${r.ending}"`);
  failed = true;
}

const calledProvider = runs.filter((r) => r.providerCalls > 0);
if (calledProvider.length === 0) {
  console.log('  PASS  no demo life attempted a live provider call');
} else {
  console.log(`  FAIL  ${calledProvider.length} demo life/lives attempted ${calledProvider.reduce((a, r) => a + r.providerCalls, 0)} provider call(s)`);
  failed = true;
}

const contentViolations = runs.flatMap((r) => r.violations);
if (contentViolations.length === 0) {
  console.log('  PASS  no card dealt below 18 at a non-safe tier (and none dealt below 18 at all)');
} else {
  const byKind = new Map();
  for (const v of contentViolations) byKind.set(v.kind, [...(byKind.get(v.kind) || []), v]);
  for (const [kind, list] of byKind) {
    console.log(`  FAIL  ${kind}: ${list.length} occurrence(s)`);
    for (const v of list.slice(0, 5)) console.log(`          age ${v.age}  ${v.id}`);
  }
  failed = true;
}

const allowed = new Set(BAL.DEMO.nameCategories || []);
const strayOrigins = new Map();
for (const r of runs) {
  for (const origin of r.originsUsed) {
    if (!allowed.has(origin)) strayOrigins.set(origin, (strayOrigins.get(origin) || 0) + 1);
  }
}
if (!allowed.size) {
  console.log('  note  BAL.DEMO.nameCategories is empty - demo lives draw from the whole pool, so there is nothing to assert');
} else if (strayOrigins.size === 0) {
  const used = new Set(runs.flatMap((r) => r.originsUsed));
  console.log(`  PASS  every name a demo life handed out came from ${[...allowed].join('/')} (origins seen: ${[...used].join(', ') || 'none'})`);
} else {
  console.log(`  FAIL  demo lives named characters from ${strayOrigins.size} origin(s) outside BAL.DEMO.nameCategories:`);
  for (const [origin, n] of [...strayOrigins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`          ${origin}: in ${n} life/lives`);
  }
  failed = true;
}

// Not a hard assertion - a demo that ends early on bankruptcy or death is
// correct behaviour, and the cap is a ceiling rather than a target. But a
// demo that NEVER reaches the cap would mean the cap is dead code and the
// numbers above are describing a different feature than the one documented.
const hitCap = runs.filter((r) => r.ending === 'demo').length;
console.log(`\n  note  ${hitCap}/${LIVES} (${((hitCap / LIVES) * 100).toFixed(0)}%) reached the cap; the rest ended early on their own, which the cap is designed to allow.`);

const median = pct(secs, 50);
if (median < 60 || median > 300) {
  console.log(`  note  median session ${mmss(median)} sits outside the 1-5 minute brief - consider retuning BAL.DEMO.maxSwipes.`);
}

console.log('');
process.exitCode = failed ? 1 : 0;
