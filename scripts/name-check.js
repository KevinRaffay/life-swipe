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
import { assignName, createNameLedger, impliedBirthYear, GENDER_ASSOCS } from '../shared/names.js';
import { BAL } from '../shared/balance.js';
import { seedFrom, nextRandom } from '../shared/rng.js';
import { computeNamePoolHealth } from '../server/name-pool-health.js';

const POOL_PATH = fileURLToPath(new URL('../server/name-pool.json', import.meta.url));
const CONTROLS_PATH = fileURLToPath(new URL('../server/name-pool-controls.json', import.meta.url));
const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
const controls = fs.existsSync(CONTROLS_PATH)
  ? JSON.parse(fs.readFileSync(CONTROLS_PATH, 'utf8'))
  : { deactivatedCategories: [], deactivatedRegions: [], deactivatedGenderAssocs: [] };

const LIVES = Number(process.argv[2]) || 400;
const NAMES_PER_LIFE = 8;
const MIN_ENTRIES = 150;
const MAX_CATEGORY_SHARE = 0.08;
const GENDERS = new Set(GENDER_ASSOCS);

// What the pool held before scripts/build-name-pool.js generated candidates
// from the SSA data. Reported, not enforced - the floor that actually fails is
// MIN_ENTRIES. It is here so the size of that rebuild stays visible in the
// output rather than being something you have to remember.
const AUTHORED_BASELINE = 187;

// The bug this pool had for its whole life: it was authored to satisfy "at
// least 150 names, diverse origins" and never asked the SSA data which names
// Americans actually have, so it carried Ignacio and Rocio but not Jose, Maria
// or Juan. These are among the most frequently registered given names in the
// country - if any of them is missing, candidate generation has regressed to
// an authored list again. A HARD failure, because it is silent otherwise.
const MUST_INCLUDE = {
  'latin-american': ['Jose', 'Maria', 'Juan', 'Guadalupe'],
  anglo: ['James', 'Mary', 'Robert'],
};

// Compare names the way the pool builder does, so "Rocio" and "Rocío" are one
// name here too - otherwise the regression check below could be satisfied by
// an accented near-duplicate.
const fold = (s) => [...String(s).normalize('NFD')]
  .filter((c) => { const n = c.codePointAt(0); return n < 0x0300 || n > 0x036f; })
  .join('').toLowerCase();

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
  if (e.active !== undefined && typeof e.active !== 'boolean') errors.push(`${at}: active must be true or false when present`);
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

  // region_frequency is optional and generated (scripts/build-region-weights.js).
  // A zero or a negative would silently erase a name from a region, turning a
  // weight into the exclusion filter this feature is specifically not.
  if (e.region_frequency !== undefined) {
    if (typeof e.region_frequency !== 'object' || Array.isArray(e.region_frequency)) {
      errors.push(`${at}: region_frequency must be an object`);
    } else {
      for (const [code, lq] of Object.entries(e.region_frequency)) {
        if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code)) errors.push(`${at}: bad region code "${code}"`);
        if (!Number.isFinite(lq) || lq <= 0) errors.push(`${at}: region_frequency.${code} must be > 0`);
      }
    }
  }
});

// Category-share warnings live in the pool-health block below (it also knows
// which categories are deactivated, so an intentionally-sidelined category
// does not read as an accidental imbalance).
const categories = new Map();
for (const e of pool) categories.set(e.category, (categories.get(e.category) || 0) + 1);

const withRegion = pool.filter((e) => e.region_frequency).length;
const growth = pool.length - AUTHORED_BASELINE;
console.log(
  `pool: ${pool.length} names, ${categories.size} categories, ${withRegion} with region_frequency`
  + `\n      (authored baseline ${AUTHORED_BASELINE}, ${growth >= 0 ? '+' : ''}${growth} from the SSA-sourced rebuild)`,
);

// Regression check: the real high-frequency names must actually be in here.
const haveFolded = new Set(pool.map((e) => fold(e.name)));
const missingByCategory = [];
for (const [category, names] of Object.entries(MUST_INCLUDE)) {
  const gone = names.filter((n) => !haveFolded.has(fold(n)));
  if (gone.length) missingByCategory.push(`${category}: ${gone.join(', ')}`);
}
if (missingByCategory.length) {
  errors.push(
    `high-frequency names missing from the pool - candidate generation has regressed to an `
    + `authored list (rerun: npm run build-name-pool -- ../ssa-state). ${missingByCategory.join(' | ')}`,
  );
} else {
  const checked = Object.values(MUST_INCLUDE).flat().length;
  console.log(`high-frequency regression check: all ${checked} present`);
}

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

/* ------------------------------------------------------- regional weighting */

// Does the region actually move the draw, and does it move it the RIGHT way?
// Both halves matter. A weighting strong enough to shift the mix but not
// strong enough to flatten it is the whole design, so measure both.
const REGION_SAMPLE = 4000;

function drawFor(region, seedTag) {
  const holder = { rngState: seedFrom('region:' + seedTag) };
  const rng = () => nextRandom(holder);
  const counts = new Map();
  const names = new Map();
  for (let i = 0; i < REGION_SAMPLE; i++) {
    // A fresh life every 8 draws, so the diversity weighting behaves as it
    // does in play rather than accumulating over thousands of names.
    if (i % 8 === 0) { drawFor.taken = new Set(); drawFor.use = {}; }
    const role = ROLES[Math.floor(rng() * ROLES.length) % ROLES.length];
    const picked = assignName({
      pool, role, birthYear: impliedBirthYear(24, role),
      taken: drawFor.taken, categoryUse: drawFor.use, rng, region,
    });
    if (!picked) continue;
    drawFor.taken.add(picked.name.toLowerCase());
    drawFor.use[picked.category] = (drawFor.use[picked.category] || 0) + 1;
    counts.set(picked.category, (counts.get(picked.category) || 0) + 1);
    names.set(picked.name, (names.get(picked.name) || 0) + 1);
  }
  return { counts, names };
}

const share = (m, key) => (m.get(key) || 0) / REGION_SAMPLE;
const topShareOf = (m) => [...m.values()].sort((a, b) => b - a).slice(0, 8)
  .reduce((a, b) => a + b, 0) / REGION_SAMPLE;

const baseline = drawFor(null, 'baseline');

// What a region "should" produce is read OUT of the data, never asserted at
// it. Writing the expectations by hand is how you end up testing your own
// assumptions about who lives where - and an early version of this check did
// exactly that, expecting Armenian and Filipino names to lead in California.
// They are genuinely elevated there (3.4x and 1.7x), but Vietnamese and
// Persian are elevated MORE, so the hand-written expectation failed while the
// weighting was working perfectly. The data picks the target now.
function topCategoriesFor(region, n = 3) {
  const byCat = new Map();
  for (const e of pool) {
    const lq = (e.region_frequency || {})[region] ?? 1;
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(lq);
  }
  return [...byCat.entries()]
    .map(([c, v]) => [c, v.reduce((a, b) => a + b, 0) / v.length])
    .filter(([, mean]) => mean > 1.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([c]) => c);
}

const PROBES = ['US-MN', 'US-HI', 'US-NM', 'US-MA', 'US-CA', 'US-IL']
  .map((region) => [region, topCategoriesFor(region)]);

console.log(`\nregional weighting (${REGION_SAMPLE} draws each, regionPower ${BAL.NAMES.regionPower})`);
console.log('  region   expected origins                        share  vs none   top8');
let regionMoves = 0;
for (const [region, cats] of PROBES) {
  const got = drawFor(region, region);
  const here = cats.reduce((s, c) => s + share(got.counts, c), 0);
  const there = cats.reduce((s, c) => s + share(baseline.counts, c), 0);
  const lift = there > 0 ? here / there : (here > 0 ? Infinity : 1);
  const top8 = topShareOf(got.counts);
  console.log(`  ${region}    ${cats.join('/').padEnd(38)} ${(here * 100).toFixed(1)}%  ${lift.toFixed(1)}x   ${(top8 * 100).toFixed(0)}%`);
  if (lift > 1.15) regionMoves++;
  // Weighting must not become a filter: no one origin may take over a region.
  if (top8 > 0.6) errors.push(`${region}: top 8 origins hold ${(top8 * 100).toFixed(0)}% - weighting is too strong`);
}
if (regionMoves < PROBES.length) {
  errors.push(`${PROBES.length - regionMoves} of ${PROBES.length} regions did not lift their own origins`);
}

// The no-region path must stay exactly what it was before regions existed.
const neutral = drawFor(null, 'baseline');
if (JSON.stringify([...neutral.counts]) !== JSON.stringify([...baseline.counts])) {
  errors.push('the no-region draw is not reproducible');
}
console.log(`  (none)   era-only baseline                       -      1.0x   ${(topShareOf(baseline.counts) * 100).toFixed(0)}%`);

/* ----------------------------------------------------------- pool health */

// Shared with the admin's Name Pool health panel (server/name-pool-health.js)
// so the two never disagree about what these numbers mean. Advisory here too:
// none of this fails the build on its own - every warning below can only
// exist after deliberate deactivation, never from the pool as shipped.
const health = computeNamePoolHealth({ pool, controls });
console.log(`\npool health: ${health.active} active, ${health.inactive} inactive, ${health.eligible} eligible for selection`);
if (health.deactivatedCategories.length) console.log(`  deactivated categories: ${health.deactivatedCategories.join(', ')}`);
if (health.deactivatedRegions.length) console.log(`  deactivated regions: ${health.deactivatedRegions.join(', ')}`);
if (health.deactivatedGenderAssocs.length) console.log(`  deactivated gender_assocs: ${health.deactivatedGenderAssocs.join(', ')}`);
if (health.duplicateNames.length) warnings.push(`duplicate name entries: ${health.duplicateNames.join(', ')}`);
for (const c of health.categorySpread) {
  if (c.overrepresented && !c.deactivated) warnings.push(`category "${c.category}" is ${(c.share * 100).toFixed(1)}% of the pool (cap ${MAX_CATEGORY_SHARE * 100}%)`);
}
if (health.eraCoverageGaps.length) warnings.push(`no name in the pool covers era window(s): ${health.eraCoverageGaps.join(', ')}`);
if (health.zeroCandidateWarnings.length) {
  const sample = health.zeroCandidateWarnings.slice(0, 5)
    .map((w) => `${w.year} (${w.want})`).join(', ');
  warnings.push(`${health.zeroCandidateWarnings.length} era+gender combination(s) have zero eligible candidates before the engine's reuse-a-name fallback, e.g. ${sample}`);
}

/* -------------------------------------------------------------- verdict */

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
