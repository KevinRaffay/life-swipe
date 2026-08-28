#!/usr/bin/env node
// Checks the name pool, and MEASURES the thing the pool exists to provide.
//
//   npm run names              -> validate + 400 simulated lives
//   npm run names -- 2000      -> more lives
//
// The structural half is a hard failure (exit 1): a malformed entry would
// silently narrow every draw. The distribution half is a report, because
// "diverse" is a claim about numbers and this project does not take those on
// trust - see the seen-window and the "odd" regex in CLAUDE.md.

import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { assignName, createNameLedger, impliedBirthYear } from '../shared/names.js';
import { seedFrom, nextRandom } from '../shared/rng.js';

const POOL_PATH = fileURLToPath(new URL('../server/name-pool.json', import.meta.url));
const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));

const LIVES = Number(process.argv[2]) || 400;
const NAMES_PER_LIFE = 8;
const MIN_ENTRIES = 150;
const MAX_CATEGORY_SHARE = 0.08;
const GENDERS = new Set(['f', 'm', 'neutral']);

/* ------------------------------------------------------------ structure */

const errors = [];
const warnings = [];
const seen = new Map();

if (!Array.isArray(pool)) {
  console.error('name-pool.json is not an array');
  process.exit(1);
}
if (pool.length < MIN_ENTRIES) errors.push(`${pool.length} entries, want at least ${MIN_ENTRIES}`);

pool.forEach((e, i) => {
  const at = `entry[${i}]${e && e.name ? ' "' + e.name + '"' : ''}`;
  if (!e || typeof e !== 'object') return errors.push(`${at}: not an object`);
  if (typeof e.name !== 'string' || !e.name.trim()) errors.push(`${at}: name must be a non-empty string`);
  if (typeof e.category !== 'string' || !e.category.trim()) errors.push(`${at}: category required`);
  if (!GENDERS.has(e.gender_assoc)) errors.push(`${at}: gender_assoc must be f | m | neutral`);
  if (!Number.isFinite(e.era_start)) errors.push(`${at}: era_start must be a number`);
  else if (e.era_start < 1900 || e.era_start > 2030) errors.push(`${at}: era_start ${e.era_start} out of range`);
  if (e.era_end !== undefined) {
    if (!Number.isFinite(e.era_end)) errors.push(`${at}: era_end must be a number when present`);
    else if (e.era_end <= e.era_start) errors.push(`${at}: era_end ${e.era_end} not after era_start ${e.era_start}`);
  }
  if (typeof e.name === 'string') {
    const key = e.name.toLowerCase();
    if (seen.has(key)) errors.push(`${at}: duplicate of entry[${seen.get(key)}]`);
    else seen.set(key, i);
  }
});

const categories = new Map();
for (const e of pool) categories.set(e.category, (categories.get(e.category) || 0) + 1);
for (const [cat, n] of categories) {
  const share = n / pool.length;
  if (share > MAX_CATEGORY_SHARE) {
    warnings.push(`category "${cat}" is ${(share * 100).toFixed(1)}% of the pool (cap ${MAX_CATEGORY_SHARE * 100}%)`);
  }
}

console.log(`pool: ${pool.length} names, ${categories.size} categories`);

/* ------------------------------------------------------- the seed deck */

// A hand-authored card may not hardcode a person's name: it would be the same
// person in every life, which is the thing this whole feature removes. Cards
// name their cast with "{{cast:sam}}" instead. Mom and Dad are exempt - those
// are how you address a parent, not names.
const ADDRESS_TERMS = new Set(['Mom', 'Dad']);
const seedPath = fileURLToPath(new URL('../data/scenarios-seed.json', import.meta.url));
const seedDeck = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const hardcoded = [];

for (const card of seedDeck) {
  for (const side of ['leftEffects', 'rightEffects']) {
    const rel = card[side] && card[side].relationship;
    if (!rel || typeof rel.name !== 'string') continue;
    if (rel.name.includes('{{') || ADDRESS_TERMS.has(rel.name)) continue;
    hardcoded.push(`${card.id}.${side} names "${rel.name}"`);
  }
}
if (hardcoded.length) {
  errors.push(`${hardcoded.length} seed card(s) hardcode a name: ${hardcoded.slice(0, 3).join(', ')}`);
}
console.log(`seed deck: ${seedDeck.length} cards, ${hardcoded.length} hardcoded names`);

/* ---------------------------------------------------------- distribution */

// Roles a life actually generates, weighted the way the storyteller reaches
// for them: mostly peers, occasionally family, occasionally authority.
const ROLES = [
  'roommate', 'friend', 'coworker', 'friend', 'rival', 'coworker',
  'boss', 'spouse', 'neighbour', 'sibling', 'landlord', 'daughter',
];

const globalCategories = new Map();
let repeatsWithinLife = 0;
let assignments = 0;
let unnamed = 0;
const eraMisses = [];

for (let life = 0; life < LIVES; life++) {
  const holder = { rngState: seedFrom('names:' + life) };
  const rng = () => nextRandom(holder);
  const ledger = createNameLedger();
  const taken = new Set(['mom', 'dad', 'priya']);
  const categoryUse = {};
  const usedThisLife = new Set();
  let age = 16;

  for (let n = 0; n < NAMES_PER_LIFE; n++) {
    age += 4;
    const role = ROLES[Math.floor(rng() * ROLES.length) % ROLES.length];
    const birthYear = impliedBirthYear(age, role);
    const picked = assignName({ pool, role, birthYear, taken, categoryUse, rng });
    assignments++;
    if (!picked) { unnamed++; continue; }

    // The pool must never hand back a name that had fallen out of use by the
    // time this person was born - that is the whole point of the era fields.
    const e = picked.entry;
    if (e.era_start > birthYear || (Number.isFinite(e.era_end) && e.era_end < birthYear)) {
      eraMisses.push(`${e.name} (${e.era_start}-${e.era_end ?? 'now'}) for a ${role} born ${birthYear}`);
    }

    if (usedThisLife.has(picked.category)) repeatsWithinLife++;
    usedThisLife.add(picked.category);
    categoryUse[picked.category] = (categoryUse[picked.category] || 0) + 1;
    taken.add(picked.name.toLowerCase());
    ledger.byTag['tag' + n] = picked.name;
    globalCategories.set(picked.category, (globalCategories.get(picked.category) || 0) + 1);
  }
}

const ranked = [...globalCategories.entries()].sort((a, b) => b[1] - a[1]);
const top = ranked.slice(0, 8);
const topShare = top.reduce((sum, [, n]) => sum + n, 0) / assignments;

console.log(`\n${LIVES} lives x ${NAMES_PER_LIFE} names = ${assignments} assignments`);
console.log(`categories actually used: ${ranked.length} of ${categories.size}`);
console.log(`same-origin repeat within one life: ${(repeatsWithinLife / assignments * 100).toFixed(1)}%`);
console.log(`top 8 categories hold ${(topShare * 100).toFixed(1)}% of all names`);
console.log('\nmost common origins:');
for (const [cat, n] of top) {
  console.log(`  ${cat.padEnd(22)} ${String(n).padStart(5)}  ${(n / assignments * 100).toFixed(1)}%`);
}

if (unnamed) errors.push(`${unnamed} assignments came back empty - the pool ran dry`);
if (eraMisses.length) errors.push(`${eraMisses.length} era violations, e.g. ${eraMisses[0]}`);
// A uniform draw over 49 categories would put ~16% in the top 8. Anything near
// half means the weighting has stopped working and one origin is dominating.
if (topShare > 0.5) warnings.push(`top 8 categories hold ${(topShare * 100).toFixed(1)}% - weighting looks weak`);

if (warnings.length) {
  console.log('\nwarnings:');
  for (const w of warnings) console.log('  ! ' + w);
}
if (errors.length) {
  console.error('\nFAILED:');
  for (const e of errors) console.error('  x ' + e);
  process.exit(1);
}
console.log('\nname pool OK');
