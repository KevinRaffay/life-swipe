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
import {
  librarySlotDue, scheduleNextSlot, selectPattern, filterPatterns, patternWantsPending,
} from '../shared/library.js';

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
const situationLibrary = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../server/situation-library.json', import.meta.url)), 'utf8'),
);

// How many lives one simulated player lives. seen_patterns persists across
// them, which is the whole point of storing it outside per-life state.
const LIVES_PER_PLAYER = 3;

// SIMULATION ONLY. With no model in the loop there is no real card for a
// library slot, so we synthesise a stand-in that carries the pattern's id and
// the snake_case flags its guidance names. That is enough to exercise
// selection, the requires/excludes chains and seen-tracking; it is not a
// substitute for reading what the storyteller actually writes.
const FLAG_TOKEN = /[a-z]+(?:_[a-z]+)+/g;
const NOT_A_FLAG = new Set(['pending_event', 'typical_effects', 'life_stage', 'library_id', 'branch_point']);

function synthesiseLibraryCard(pattern) {
  const flags = [...new Set((pattern.typical_effects.match(FLAG_TOKEN) || []))]
    .filter((f) => !NOT_A_FLAG.has(f))
    .slice(0, 3);
  // Both sides carry the pattern flags: the EVENT happened either way, and the
  // random chooser must not decide whether the pattern took effect at all. That
  // artefact made four-deep chains survive only 6% of the time and eight of the
  // thirteen patterns look permanently dead.
  const effects = { happiness: 2, flags };
  if (patternWantsPending(pattern)) {
    effects.pendingEvent = { id: pattern.id + '_outcome', label: 'Consequence pending.', dueInMonths: 30 };
  }
  return {
    id: 'lib_' + pattern.id,
    libraryId: pattern.id,
    scenario: '[library stand-in] ' + pattern.pattern,
    leftLabel: 'Lean in',
    rightLabel: 'Step back',
    weight: 'major',
    modes: pattern.modes,
    leftEffects: effects,
    rightEffects: { ...effects, happiness: -2 },
    source: 'library',
  };
}

// SIMULATION ONLY, same bargain as the library stand-in above. With no model
// in the loop nothing ever emits a "{{new:role}}" tag, so the naming path
// would go completely unexercised by a run that otherwise touches everything.
// This injects the card the storyteller would have written.
const NEW_CHARACTER_ROLES = [
  'roommate', 'coworker', 'friend', 'neighbour', 'boss', 'rival', 'landlord', 'sibling',
];

/**
 * A card that makes the engine name somebody.
 *
 * Two shapes, and the second one exists for a specific reason. The ordinary
 * shape tags the prose AND the left label. The `labelOnly` shape tags NOTHING
 * BUT the label - no prose tag, no tagged relationship - which is the only
 * card that can tell whether `Deck.resolveNames`'s "is there anything to do"
 * pre-check reads the labels. Without it, reverting that pre-check alone still
 * passes every assertion here, because every other tagged card trips the gate
 * through its prose and gets its labels resolved on the way past.
 */
function synthesiseNamedCard(state, role, stageId, { labelOnly = false } = {}) {
  const tag = '{{new:' + role + '}}';
  if (labelOnly) {
    return {
      id: 'namelabel_' + role + '_' + state.turn,
      prompt: 'Somebody from the neighbourhood wants to split the cost of a van.',
      scenario: 'Somebody from the neighbourhood wants to split the cost of a van.',
      leftLabel: `Split it with ${tag}`,
      rightLabel: 'Pass',
      weight: 'minor',
      stages: [stageId],
      modes: ['safe', 'mature'],
      leftEffects: { happiness: 2, money: -40 },
      rightEffects: { happiness: -1 },
      source: 'llm',
    };
  }
  return {
    id: 'name_' + role + '_' + state.turn,
    prompt: `${tag} turns up with an opinion. ${tag} is not going to let it go.`,
    scenario: `${tag} turns up with an opinion. ${tag} is not going to let it go.`,
    // The left label names them ON PURPOSE. A card is allowed to put a
    // person on a button ("Marry {{cast:sam}}", in the seed deck), and the
    // labels went unresolved for a long time precisely because nothing here
    // ever put a tag in one - so the check below had nothing to catch.
    leftLabel: `Hear ${tag} out`,
    rightLabel: 'Walk away',
    weight: 'minor',
    stages: [stageId],
    modes: ['safe', 'mature'],
    leftEffects: { happiness: 2, relationship: { name: tag, role, qualityDelta: 4 } },
    rightEffects: { happiness: -2, relationship: { name: tag, role, qualityDelta: -4 } },
    source: 'llm',
  };
}

const firstNameOf = (n) => String(n || '').trim().split(/\s+/)[0].toLowerCase();

// Everything a dealt card puts in front of a player. Deliberately a superset of
// the narrative fields: the choice labels are the half that was being missed.
const PLAYER_VISIBLE_FIELDS = ['scenario', 'setting', 'beat', 'dialogue', 'prompt', 'leftLabel', 'rightLabel'];

function playOne(seed, contentMode, seenPatterns = [], seenSeedIds = [], seedStore = null) {
  let bypassWarnings = 0;
  const deck = new Deck({
    seedScenarios,
    seenSeedIds,
    onSeedShown: (id) => { if (seedStore) seedStore.ids[id] = seedStore.life; },
    warn: () => { bypassWarnings += 1; },   // counted, not printed, per life
  });
  let state = createState({ seed, contentMode });
  const libraryFired = [];
  let slotsOffered = 0;
  let slotsUnfilled = 0;
  const rejectionReasons = new Map();
  const chooser = { rngState: seedFrom('choices:' + seed) };
  const violations = [];
  const nameViolations = [];
  // The name checks re-run every turn, so a collision that happens once would
  // otherwise be reported for the rest of the life and make 30 real problems
  // look like 300.
  const reportedNameIssues = new Set();
  const noteNameViolation = (v) => {
    const key = v.kind + '|' + v.text;
    if (reportedNameIssues.has(key)) return;
    reportedNameIssues.add(key);
    nameViolations.push(v);
  };
  let darkScenarios = 0;

  while (!state.ended && state.turn < MAX_TURNS) {
    let card;
    // Roughly one card in six introduces somebody new, which is about the rate
    // a real batch does it at.
    if (state.turn % 6 === 3) {
      const role = NEW_CHARACTER_ROLES[state.turn % NEW_CHARACTER_ROLES.length];
      // Every other injection is the label-only shape, so both halves of the
      // naming gate - the resolver's field list and the deck's pre-check -
      // are exercised on every run rather than only the first.
      deck.buffer.push(synthesiseNamedCard(state, role, stageOf(state).id, {
        labelOnly: state.turn % 12 === 9,
      }));
    }
    if (librarySlotDue(state)) {
      slotsOffered += 1;
      const { eligible, rejected } = filterPatterns(state, situationLibrary, seenPatterns);
      for (const r of rejected) {
        for (const reason of r.reasons) {
          const key = r.id + ':' + reason;
          rejectionReasons.set(key, (rejectionReasons.get(key) || 0) + 1);
        }
      }
      const pattern = eligible.length ? selectPattern(state, situationLibrary, seenPatterns) : null;
      scheduleNextSlot(state, () => nextRandom(state));
      if (pattern) {
        card = synthesiseLibraryCard(pattern);
        libraryFired.push(pattern.id);
      } else {
        slotsUnfilled += 1;      // no candidate - fall back to free generation
      }
    }
    if (!card) card = deck.draw(state);
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

    // A tag that survives to the player is the naming feature failing loudly.
    //
    // Every field a player can READ, not only the two the card is written
    // around. This used to check `scenario` and `prompt` alone, which is why
    // "Be friends with {{cast:sam}}" sat on a live choice button through
    // several passes of this file: the assertion could not see the buttons.
    const unresolved = PLAYER_VISIBLE_FIELDS.filter((f) => String(card[f] || '').includes('{{'));
    if (unresolved.length) {
      noteNameViolation({
        kind: 'unresolved-name-tag', age: Math.floor(ageAtDeal), id: card.id,
        text: `${unresolved.join('/')}: ${String(card[unresolved[0]]).slice(0, 70)}`,
      });
    }

    const side = nextRandom(chooser) < 0.5 ? 'left' : 'right';
    state = applyChoice(state, card, side).state;

    // Two characters landing on one name is the collision the ledger exists to
    // prevent. It has to be measured on the LEDGER, not on the relationships
    // map: the map is keyed by name, so a collision there does not show up as
    // two entries, it shows up as two people silently becoming one.
    const firsts = new Map();
    const byTag = (state.names && state.names.byTag) || {};
    for (const [tag, name] of Object.entries(byTag)) {
      const key = firstNameOf(name);
      if (firsts.has(key)) {
        noteNameViolation({
          kind: 'duplicate-first-name', age: Math.floor(ageOf(state)), id: card.id,
          text: `${firsts.get(key)} and ${tag} are both "${name}"`,
        });
      }
      firsts.set(key, tag);
    }
    // The starting cast and any children count as spent names too.
    for (const name of [...Object.keys(state.relationships), ...state.kids.map((k) => k.name)]) {
      const key = firstNameOf(name);
      if (firsts.has(key) && byTag[firsts.get(key)] && firstNameOf(byTag[firsts.get(key)]) === key
          && !Object.values(byTag).includes(name)) {
        noteNameViolation({
          kind: 'duplicate-first-name', age: Math.floor(ageOf(state)), id: card.id,
          text: `${name} collides with an assigned name`,
        });
      }
    }
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
    nameViolations,
    namesAssigned: Object.keys((state.names && state.names.byTag) || {}).length,
    libraryFired,
    bypassWarnings,
    seedRepeats: deck.stats.seenFilterBypassed,
    slotsOffered,
    slotsUnfilled,
    rejectionReasons,
    pendingCreated: (state.pending || []).length,
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

  /* ----------------------------------------------------- situation library */

  const fired = runs.flatMap((r) => r.libraryFired);
  const offered = runs.reduce((a, r) => a + r.slotsOffered, 0);
  const unfilled = runs.reduce((a, r) => a + r.slotsUnfilled, 0);
  const perLife = runs.map((r) => r.libraryFired.length);
  console.log('\nSITUATION LIBRARY');
  console.log(`  slots offered ${offered}   filled ${offered - unfilled}   fell back to free generation ${unfilled}`);
  console.log(`  library events per life  mean ${mean(perLife).toFixed(2)}   median ${pct(perLife, 50)}   max ${Math.max(...perLife, 0)}`);
  console.log(`  pending events created   mean ${mean(runs.map((r) => r.pendingCreated)).toFixed(2)}`);

  const firedCounts = new Map();
  for (const id of fired) firedCounts.set(id, (firedCounts.get(id) || 0) + 1);
  const maxFired = Math.max(1, ...firedCounts.values());
  console.log('\n  patterns fired');
  for (const p of situationLibrary) {
    const n = firedCounts.get(p.id) || 0;
    const tag = n === 0 ? 'DEAD' : '    ';
    console.log(`    ${tag} ${String(n).padStart(4)} ${bar(n, maxFired, 16).padEnd(16)} ${p.id} (${p.rarity})`);
  }

  // Why the rest never got a look in. This is how a dead pattern shows itself.
  const reasons = new Map();
  for (const r of runs) {
    for (const [key, n] of r.rejectionReasons) {
      const reason = key.split(':')[1];
      reasons.set(reason, (reasons.get(reason) || 0) + n);
    }
  }
  const totalRejections = [...reasons.values()].reduce((a, b) => a + b, 0) || 1;
  console.log('\n  filtered out by');
  for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${reason.padEnd(16)} ${String(n).padStart(6)}  ${((n / totalRejections) * 100).toFixed(0)}%`);
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
const allNameViolations = [];
let totalNamesAssigned = 0;
const repeatOffences = [];
for (const mode of MODES_TO_RUN) {
  const runs = [];
  const players = Math.ceil(LIVES / LIVES_PER_PLAYER);
  let lifeNo = 0;
  for (let p = 0; p < players && lifeNo < LIVES; p++) {
    // One player, several lives, one shared memory of what they have been shown.
    const seen = [];
    // Cross-life seed memory, keyed by the life a card was last shown, so the
    // lookback is measured in lives exactly as prefs.js measures it.
    const seedStore = { life: 0, ids: {} };
    const LOOKBACK = 2;
    const firedByLife = [];
    for (let l = 0; l < LIVES_PER_PLAYER && lifeNo < LIVES; l++, lifeNo++) {
      seedStore.life += 1;
      for (const [id, at] of Object.entries(seedStore.ids)) {
        if (at < seedStore.life - LOOKBACK) delete seedStore.ids[id];
      }
      const cutoff = seedStore.life - LOOKBACK;
      const seenSeeds = Object.entries(seedStore.ids).filter(([, at]) => at > cutoff).map(([id]) => id);
      const run = playOne(`${BASE_SEED}:${mode}:${lifeNo}`, mode, seen, seenSeeds, seedStore);
      run.player = p;
      runs.push(run);
      firedByLife.push(run.libraryFired);
      for (const id of run.libraryFired) if (!seen.includes(id)) seen.push(id);
    }
    // Did any pattern reach this player more than once, across all their lives?
    const counts = new Map();
    for (const list of firedByLife) for (const id of list) counts.set(id, (counts.get(id) || 0) + 1);
    for (const [id, n] of counts) if (n > 1) repeatOffences.push({ mode, player: p, id, times: n });
  }
  report(runs, mode);
  for (const r of runs) {
    allViolations.push(...r.violations);
    allNameViolations.push(...r.nameViolations);
    totalNamesAssigned += r.namesAssigned;
  }
}

console.log('\n=== LIBRARY ASSERTION ===');
if (repeatOffences.length === 0) {
  console.log(`  PASS  no pattern fired twice for the same player (${LIVES_PER_PLAYER} lives each)`);
} else {
  console.log(`  FAIL  ${repeatOffences.length} pattern(s) repeated for a player:`);
  for (const r of repeatOffences.slice(0, 5)) {
    console.log(`          ${r.mode} player #${r.player}: ${r.id} fired ${r.times}x`);
  }
  process.exitCode = 1;
}


console.log('\n=== NAME ASSERTIONS ===');
console.log(`  ${totalNamesAssigned} names assigned by the engine across all lives`);
if (allNameViolations.length === 0) {
  console.log('  PASS  no unresolved "{{new:role}}" tag reached a player (prose or choice label)');
  console.log('  PASS  no two characters shared a first name in one life');
} else {
  const byKind = new Map();
  for (const v of allNameViolations) byKind.set(v.kind, [...(byKind.get(v.kind) || []), v]);
  for (const [kind, list] of byKind) {
    console.log(`  FAIL  ${kind}: ${list.length} occurrence(s)`);
    for (const v of list.slice(0, 5)) console.log(`          age ${v.age}  ${v.id}  "${v.text}"`);
    if (list.length > 5) console.log(`          ...and ${list.length - 5} more`);
  }
  process.exitCode = 1;
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
