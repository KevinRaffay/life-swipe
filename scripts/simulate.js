#!/usr/bin/env node
// Headless balance check. Plays N random lives against the deterministic engine
// with no LLM in the loop, then prints the distributions you need to answer
// "is this game too lethal / too rich / too long?".
//
//   npm run simulate                   -> 100 safe lives
//   npm run simulate -- 1000           -> 1000 lives
//   npm run simulate -- 500 42         -> 500 lives from base seed 42
//   npm run simulate -- 300 x --mode=mature
//   npm run simulate -- 300 x --mode=both
//
// Two assertions are hard failures (exit 1): mature content must never reach a
// safe-mode life, and must never reach a character under 18 in ANY mode.

import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { Deck } from '../shared/deck.js';
import { createState, applyChoice, ageOf, stageOf, finalStats } from '../shared/engine.js';
import { nextRandom, seedFrom } from '../shared/rng.js';
import { isMatureScenario, ADULT_AGE } from '../shared/content.js';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const LIVES = Number(positional[0]) || 100;
const BASE_SEED = positional[1] || 'lifeswipe';
const MAX_TURNS = 400;

const modeFlag = (flags.find((f) => f.startsWith('--mode=')) || '--mode=safe').split('=')[1];
if (!['safe', 'mature', 'both'].includes(modeFlag)) {
  console.error(`unknown --mode=${modeFlag} (expected safe | mature | both)`);
  process.exit(2);
}
const MODES_TO_RUN = modeFlag === 'both' ? ['safe', 'mature'] : [modeFlag];

const seedScenarios = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../data/scenarios-seed.json', import.meta.url)), 'utf8'),
);

function playOne(seed, contentMode) {
  const deck = new Deck({ seedScenarios });
  let state = createState({ seed, contentMode });
  const chooser = { rngState: seedFrom('choices:' + seed) };
  const violations = [];
  let darkScenarios = 0;

  while (!state.ended && state.turn < MAX_TURNS) {
    const card = deck.draw(state);
    const ageAtDeal = ageOf(state);

    // Every card that reaches a player is audited, not just the ones we expect
    // to be clean. This is the assertion the whole feature rests on.
    if (isMatureScenario(card)) {
      darkScenarios += 1;
      if (contentMode === 'safe') {
        violations.push({ kind: 'mature-in-safe', age: Math.floor(ageAtDeal), id: card.id, text: card.scenario.slice(0, 80) });
      }
      if (ageAtDeal < ADULT_AGE) {
        violations.push({ kind: 'mature-under-18', age: Math.floor(ageAtDeal), id: card.id, text: card.scenario.slice(0, 80) });
      }
    }

    const side = nextRandom(chooser) < 0.5 ? 'left' : 'right';
    state = applyChoice(state, card, side).state;
  }
  return {
    state,
    stats: finalStats(state),
    deckStats: deck.stats,
    timedOut: !state.ended,
    contentMode,
    darkScenarios,
    darkArcs: state.dark ? state.dark.arcsUsed : 0,
    darkBudget: state.dark ? state.dark.budget : 0,
    violations,
  };
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

const bar = (n, max, width = 30) => '#'.repeat(Math.max(0, Math.round((n / (max || 1)) * width)));

function report(runs, mode) {
  const ages = runs.map((r) => r.stats.age);
  const monies = runs.map((r) => r.stats.money);
  const turns = runs.map((r) => r.stats.turns);
  const credits = runs.map((r) => r.stats.credits);

  const causes = new Map();
  for (const r of runs) {
    const key = r.timedOut ? `ran out of turns (BUG: raise MAX_TURNS)` : `${r.stats.ending}: ${r.stats.cause}`;
    causes.set(key, (causes.get(key) || 0) + 1);
  }

  const bankrupt = runs.filter((r) => r.stats.ending === 'bankrupt').length;
  const diedYoung = runs.filter((r) => r.stats.age < 40).length;
  const reachedRetirement = runs.filter((r) => r.stats.age >= 65).length;
  const n = runs.length;

  console.log(`\n=== LIFE SWIPE :: ${n} simulated lives :: ${mode.toUpperCase()} mode (seed "${BASE_SEED}") ===\n`);

  console.log('LIFESPAN');
  console.log(`  mean ${mean(ages).toFixed(1)}   median ${pct(ages, 50)}   p10 ${pct(ages, 10)}   p90 ${pct(ages, 90)}   min ${Math.min(...ages)}   max ${Math.max(...ages)}`);
  console.log(`  died before 40: ${diedYoung} (${((diedYoung / n) * 100).toFixed(0)}%)   reached 65: ${reachedRetirement} (${((reachedRetirement / n) * 100).toFixed(0)}%)`);

  console.log('\nSWIPES PER LIFE');
  console.log(`  mean ${mean(turns).toFixed(1)}   median ${pct(turns, 50)}   p10 ${pct(turns, 10)}   p90 ${pct(turns, 90)}   target 40-80`);

  console.log('\nMONEY AT DEATH');
  for (const p of [10, 25, 50, 75, 90, 99]) console.log(`  p${String(p).padStart(2)}  ${money(pct(monies, p)).padStart(14)}`);
  console.log(`  mean ${money(mean(monies))}   broke endings: ${bankrupt} (${((bankrupt / n) * 100).toFixed(0)}%)`);

  const buckets = [
    ['negative', (m) => m < 0],
    ['$0-25k', (m) => m >= 0 && m < 25000],
    ['$25k-100k', (m) => m >= 25000 && m < 100000],
    ['$100k-500k', (m) => m >= 100000 && m < 500000],
    ['$500k-2M', (m) => m >= 500000 && m < 2000000],
    ['$2M+', (m) => m >= 2000000],
  ];
  console.log('\n  distribution');
  const counts = buckets.map(([label, fn]) => [label, monies.filter(fn).length]);
  const maxCount = Math.max(...counts.map((c) => c[1]));
  for (const [label, c] of counts) console.log(`    ${label.padEnd(11)} ${String(c).padStart(4)} ${bar(c, maxCount)}`);

  console.log('\nCREDITS (score)');
  console.log(`  mean ${Math.round(mean(credits)).toLocaleString('en-US')}   median ${pct(credits, 50).toLocaleString('en-US')}   p90 ${pct(credits, 90).toLocaleString('en-US')}`);

  /* ------------------------------------------------------- content mode */

  const arcs = runs.map((r) => r.darkArcs);
  const darkCards = runs.map((r) => r.darkScenarios);
  console.log('\nCONTENT MODE');
  if (mode === 'mature') {
    const inTarget = arcs.filter((a) => a >= 1 && a <= 3).length;
    const withNone = arcs.filter((a) => a === 0).length;
    console.log(`  dark arcs per life      mean ${mean(arcs).toFixed(2)}   median ${pct(arcs, 50)}   max ${Math.max(...arcs)}   target 1-3`);
    console.log(`  dark scenarios per life mean ${mean(darkCards).toFixed(2)}   max ${Math.max(...darkCards)}`);
    console.log(`  lives within 1-3 arcs: ${inTarget}/${n} (${((inTarget / n) * 100).toFixed(0)}%)   lives with none: ${withNone}`);
    const hist = new Map();
    for (const a of arcs) hist.set(a, (hist.get(a) || 0) + 1);
    const maxA = Math.max(...hist.values());
    for (const k of [...hist.keys()].sort((a, b) => a - b)) {
      console.log(`    ${k} arc${k === 1 ? ' ' : 's'}  ${String(hist.get(k)).padStart(4)} ${bar(hist.get(k), maxA, 22)}`);
    }
  } else {
    console.log(`  dark scenarios dealt: ${darkCards.reduce((a, b) => a + b, 0)} (must be 0)`);
  }

  console.log('\nCAUSES OF DEATH');
  const sorted = [...causes.entries()].sort((a, b) => b[1] - a[1]);
  const maxCause = sorted[0] ? sorted[0][1] : 1;
  for (const [cause, c] of sorted) console.log(`  ${String(c).padStart(4)}  ${bar(c, maxCause, 18).padEnd(18)} ${cause}`);

  const deckTotals = runs.reduce((acc, r) => {
    for (const k of ['seed', 'llm', 'fallback']) acc[k] = (acc[k] || 0) + r.deckStats[k];
    return acc;
  }, {});
  console.log('\nCARD SOURCES (no API in simulation)');
  console.log(`  seed ${deckTotals.seed}   fallback ${deckTotals.fallback}   llm ${deckTotals.llm}`);

  const timeouts = runs.filter((r) => r.timedOut).length;
  if (timeouts) console.log(`\n!! ${timeouts} lives hit the ${MAX_TURNS}-turn cap without ending.`);
}

/* ----------------------------------------------------------------- main */

const allViolations = [];
for (const mode of MODES_TO_RUN) {
  const runs = [];
  for (let i = 0; i < LIVES; i++) runs.push(playOne(`${BASE_SEED}:${mode}:${i}`, mode));
  report(runs, mode);
  for (const r of runs) allViolations.push(...r.violations);
}

console.log('\n=== CONTENT ASSERTIONS ===');
if (allViolations.length === 0) {
  console.log('  PASS  no mature content in safe-mode lives');
  console.log('  PASS  no mature content dealt to a character under 18');
  console.log('');
} else {
  const byKind = new Map();
  for (const v of allViolations) byKind.set(v.kind, [...(byKind.get(v.kind) || []), v]);
  for (const [kind, list] of byKind) {
    console.log(`  FAIL  ${kind}: ${list.length} occurrence(s)`);
    for (const v of list.slice(0, 5)) console.log(`          age ${v.age}  ${v.id}  "${v.text}"`);
    if (list.length > 5) console.log(`          ...and ${list.length - 5} more`);
  }
  console.log('');
  process.exitCode = 1;
}
