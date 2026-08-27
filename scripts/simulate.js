#!/usr/bin/env node
// Headless balance check. Plays N random lives against the deterministic engine
// with no LLM in the loop, then prints the distributions you need to answer
// "is this game too lethal / too rich / too long?".
//
//   npm run simulate            -> 100 lives
//   npm run simulate -- 1000    -> 1000 lives
//   npm run simulate -- 500 42  -> 1000 lives from base seed 42

import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { Deck } from '../shared/deck.js';
import { createState, applyChoice, ageOf, stageOf, finalStats } from '../shared/engine.js';
import { nextRandom, seedFrom } from '../shared/rng.js';

const LIVES = Number(process.argv[2]) || 100;
const BASE_SEED = process.argv[3] || 'lifeswipe';
const MAX_TURNS = 400;

const seedScenarios = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../data/scenarios-seed.json', import.meta.url)), 'utf8'),
);

function playOne(seed) {
  const deck = new Deck({ seedScenarios });
  let state = createState({ seed });
  const chooser = { rngState: seedFrom('choices:' + seed) };

  while (!state.ended && state.turn < MAX_TURNS) {
    const card = deck.draw(state);
    const side = nextRandom(chooser) < 0.5 ? 'left' : 'right';
    state = applyChoice(state, card, side).state;
  }
  return { state, stats: finalStats(state), deckStats: deck.stats, timedOut: !state.ended };
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

const runs = [];
for (let i = 0; i < LIVES; i++) runs.push(playOne(`${BASE_SEED}:${i}`));

const ages = runs.map((r) => r.stats.age);
const monies = runs.map((r) => r.stats.money);
const turns = runs.map((r) => r.stats.turns);
const credits = runs.map((r) => r.stats.credits);

const causes = new Map();
for (const r of runs) {
  const key = r.timedOut ? 'ran out of turns (BUG: raise MAX_TURNS)' : `${r.stats.ending}: ${r.stats.cause}`;
  causes.set(key, (causes.get(key) || 0) + 1);
}

const bankrupt = runs.filter((r) => r.stats.ending === 'bankrupt').length;
const diedYoung = runs.filter((r) => r.stats.age < 40).length;
const reachedRetirement = runs.filter((r) => r.stats.age >= 65).length;

const bar = (n, max, width = 30) => '#'.repeat(Math.max(0, Math.round((n / (max || 1)) * width)));

console.log(`\n=== LIFE SWIPE :: ${LIVES} simulated lives (seed "${BASE_SEED}") ===\n`);

console.log('LIFESPAN');
console.log(`  mean ${mean(ages).toFixed(1)}   median ${pct(ages, 50)}   p10 ${pct(ages, 10)}   p90 ${pct(ages, 90)}   min ${Math.min(...ages)}   max ${Math.max(...ages)}`);
console.log(`  died before 40: ${diedYoung} (${((diedYoung / LIVES) * 100).toFixed(0)}%)   reached 65: ${reachedRetirement} (${((reachedRetirement / LIVES) * 100).toFixed(0)}%)`);

console.log('\nSWIPES PER LIFE');
console.log(`  mean ${mean(turns).toFixed(1)}   median ${pct(turns, 50)}   p10 ${pct(turns, 10)}   p90 ${pct(turns, 90)}   target 40-80`);

console.log('\nMONEY AT DEATH');
for (const p of [10, 25, 50, 75, 90, 99]) console.log(`  p${String(p).padStart(2)}  ${money(pct(monies, p)).padStart(14)}`);
console.log(`  mean ${money(mean(monies))}   broke endings: ${bankrupt} (${((bankrupt / LIVES) * 100).toFixed(0)}%)`);

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
for (const [label, n] of counts) console.log(`    ${label.padEnd(11)} ${String(n).padStart(4)} ${bar(n, maxCount)}`);

console.log('\nCREDITS (score)');
console.log(`  mean ${Math.round(mean(credits)).toLocaleString('en-US')}   median ${pct(credits, 50).toLocaleString('en-US')}   p90 ${pct(credits, 90).toLocaleString('en-US')}`);

console.log('\nCAUSES OF DEATH');
const sorted = [...causes.entries()].sort((a, b) => b[1] - a[1]);
const maxCause = sorted[0] ? sorted[0][1] : 1;
for (const [cause, n] of sorted) {
  console.log(`  ${String(n).padStart(4)}  ${bar(n, maxCause, 18).padEnd(18)} ${cause}`);
}

const deckTotals = runs.reduce((acc, r) => {
  for (const k of ['seed', 'llm', 'fallback']) acc[k] = (acc[k] || 0) + r.deckStats[k];
  return acc;
}, {});
console.log('\nCARD SOURCES (no API in simulation)');
console.log(`  seed ${deckTotals.seed}   fallback ${deckTotals.fallback}   llm ${deckTotals.llm}`);

const timeouts = runs.filter((r) => r.timedOut).length;
if (timeouts) console.log(`\n!! ${timeouts} lives hit the ${MAX_TURNS}-turn cap without ending.`);
console.log('');
