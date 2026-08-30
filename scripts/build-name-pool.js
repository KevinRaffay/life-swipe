#!/usr/bin/env node
// Build the CANDIDATE name pool from real SSA birth records.
//
//   node scripts/build-name-pool.js <dir-of-SSA-state-files> [--top=N] [--dry]
//   npm run build-name-pool -- ../ssa-state
//
// WHY THIS EXISTS
// The original 187-name pool was authored to satisfy the spec's "at least 150
// names, diverse origins". Nothing ever asked the SSA data WHICH names
// Americans actually have - build-region-weights.js only ever scored names
// that were already in the file. That is why the pool held Ignacio and Rocio
// but not Jose, Maria or Juan, which are among the most frequently registered
// given names in the country. An authored list scored by real data is still an
// authored list; this script generates the candidates FROM the data instead.
//
// WHAT IT DOES NOT DO
// It never deletes. Every existing entry survives untouched, including the
// deliberately rare flavour names (Siobhan, Struan, Aino) that give the pool
// its texture - being uncommon is not a defect, being absent-because-nobody-
// looked is. This script only ADDS what the data surfaces and the pool lacks.
//
// It also does not change how region_frequency is computed. The location
// quotient below is the same statistic, the same constants and the same era
// windowing as scripts/build-region-weights.js - it is applied here to
// real-frequency-sourced candidates rather than to an authored list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { detectMature } from '../shared/content.js';

const POOL_PATH = fileURLToPath(new URL('../server/name-pool.json', import.meta.url));
const CATEGORY_PATH = fileURLToPath(new URL('./name-categories.json', import.meta.url));

// Era buckets for the top-N pull. Twenty-year windows match the granularity
// the pool's own era_start/era_end already use (they sit on 5-year boundaries
// and span 15-40 years), and they are wide enough that a name has to be
// genuinely common for a while to place, not spike for one year.
const ERA_BUCKETS = [
  [1940, 1959],
  [1960, 1979],
  [1980, 1999],
  [2000, 2100],
];

// Top-N per state per era bucket per sex. The union across 51 states x 4
// buckets x 2 sexes is what becomes the candidate list, so N is a knob on
// breadth, not on how many names survive.
const DEFAULT_TOP = 25;

// --- region_frequency constants, identical to build-region-weights.js ------
// Kept as literals rather than imported because that script is a standalone
// one-time build too; if either moves, they must move together.
const MIN_NATIONAL = 120;   // below this a name gets no map at all
const MIN_STATE = 25;       // below this a state is not counted for that name
const LQ_RANGE = [0.1, 25];
const NEUTRAL_BAND = [0.8, 1.3];

// A name is 'neutral' when the minority sex holds at least this much of its
// national births. Measured, not asserted - it is how Rowan and Quinn end up
// neutral and Michael does not.
const NEUTRAL_MIN_SHARE = 0.25;
// Era window: the years where a name is at or above this fraction of its own
// peak year. Below it the name is a rounding error, not "in use".
const ERA_PEAK_FRACTION = 0.10;
const ERA_ROUND = 5;        // era_start/era_end snap to 5-year boundaries

// SSA data is plain ASCII, so 'Rocio' has to match the pool's 'Rocío'. Same
// semantics as build-region-weights.js's fold(), written as a code-point
// filter rather than a combining-marks regex so the range stays readable.
const fold = (s) => [...String(s).normalize('NFD')]
  .filter((c) => { const n = c.codePointAt(0); return n < 0x0300 || n > 0x036f; })
  .join('').toLowerCase();
const STATE_FILE = /^(?:namesbystate_)?([A-Z]{2})\.TXT$/i;

/* ------------------------------------------------------------------ input */

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const TOP = Number((args.find((a) => a.startsWith('--top=')) || '').split('=')[1]) || DEFAULT_TOP;
const sourceDir = args.find((a) => !a.startsWith('--')) || process.env.SSA_STATE_DIR;

if (!sourceDir || !fs.existsSync(sourceDir)) {
  console.error('usage: node scripts/build-name-pool.js <dir-of-SSA-state-files> [--top=N] [--dry]');
  console.error('       the directory holds AK.TXT ... WY.TXT from namesbystate.zip');
  process.exit(2);
}
const files = fs.readdirSync(sourceDir).filter((f) => STATE_FILE.test(f));
if (!files.length) {
  console.error(`no state files in ${sourceDir} (expected AK.TXT or namesbystate_AK.TXT)`);
  process.exit(2);
}

const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
const before = pool.length;
const taken = new Set(pool.map((e) => fold(e.name)));

const bucketOf = (year) => ERA_BUCKETS.findIndex(([lo, hi]) => year >= lo && year <= hi);

/* ------------------------------------- pass A: which names are candidates */

// One state at a time, so peak memory is one state's table rather than the
// whole 6.7M-row corpus. For each (era bucket, sex) this takes the top TOP
// names by RAW BIRTHS - the actual "what are people called here" question the
// old authored list never asked.
const candidates = new Set();
for (const file of files) {
  const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  const tally = new Map();                       // "bucket|sex|name" -> births
  for (const line of text.split('\n')) {
    if (!line) continue;
    const p = line.trim().split(',');
    if (p.length < 5) continue;
    const year = Number(p[2]);
    const count = Number(p[4]);
    if (!Number.isFinite(year) || !Number.isFinite(count)) continue;
    const b = bucketOf(year);
    if (b < 0) continue;
    const key = b + '|' + p[1] + '|' + p[3];
    tally.set(key, (tally.get(key) || 0) + count);
  }
  const byGroup = new Map();                     // "bucket|sex" -> [[name, n]]
  for (const [key, n] of tally) {
    const i = key.lastIndexOf('|');
    const group = key.slice(0, i);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push([key.slice(i + 1), n]);
  }
  for (const rows of byGroup.values()) {
    rows.sort((a, b) => b[1] - a[1]);
    for (const [name] of rows.slice(0, TOP)) candidates.add(name);
  }
}
console.log(`pass A: ${files.length} states x ${ERA_BUCKETS.length} eras x 2 sexes, top ${TOP} each`);
console.log(`        ${candidates.size} distinct candidate names`);

/* --------------------------- pass B: measure only the candidates properly */

// Now that the candidate set is known, re-read for the numbers each one needs:
// national births per year per sex (gender_assoc + the era window), and births
// per state per year (the location quotient). stateYear is every birth in the
// file, candidate or not, because it is the LQ's denominator.
// Keyed by FOLDED name throughout, and covering the candidates UNION every
// name already in the pool - the originals need national_births measured too,
// and an accented one ("Rocío") only matches the archive's ASCII once folded.
const measureKeys = new Set([...candidates].map(fold));
for (const e of pool) measureKeys.add(fold(e.name));

const stateYear = new Map();                     // state -> year -> all births
const natSex = new Map();                        // folded -> {F, M}
const natYear = new Map();                       // folded -> year -> births
const byState = new Map();                       // folded -> state -> year -> births
let minYear = Infinity;
let maxYear = -Infinity;

for (const file of files) {
  const state = file.match(STATE_FILE)[1].toUpperCase();
  const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  let years = stateYear.get(state);
  if (!years) { years = new Map(); stateYear.set(state, years); }

  for (const line of text.split('\n')) {
    if (!line) continue;
    const p = line.trim().split(',');
    if (p.length < 5) continue;
    const year = Number(p[2]);
    const count = Number(p[4]);
    if (!Number.isFinite(year) || !Number.isFinite(count)) continue;
    if (year < minYear) minYear = year;
    if (year > maxYear) maxYear = year;
    years.set(year, (years.get(year) || 0) + count);

    const key = fold(p[3]);
    if (!measureKeys.has(key)) continue;
    const sex = p[1];

    let s = natSex.get(key);
    if (!s) { s = { F: 0, M: 0 }; natSex.set(key, s); }
    s[sex] = (s[sex] || 0) + count;

    let ny = natYear.get(key);
    if (!ny) { ny = new Map(); natYear.set(key, ny); }
    ny.set(year, (ny.get(year) || 0) + count);

    let st = byState.get(key);
    if (!st) { st = new Map(); byState.set(key, st); }
    let sy = st.get(state);
    if (!sy) { sy = new Map(); st.set(state, sy); }
    sy.set(year, (sy.get(year) || 0) + count);
  }
}

const states = [...stateYear.keys()].sort();
const nationalYear = new Map();
for (const years of stateYear.values()) {
  for (const [year, n] of years) nationalYear.set(year, (nationalYear.get(year) || 0) + n);
}
console.log(`pass B: ${states.length} states, years ${minYear}-${maxYear}`);

const sumWindow = (map, lo, hi) => {
  let total = 0;
  if (!map) return 0;
  for (const [year, n] of map) if (year >= lo && year <= hi) total += n;
  return total;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const floorTo = (y, step) => Math.floor(y / step) * step;
const ceilTo = (y, step) => Math.ceil(y / step) * step;

/* ------------------------------------------------- derive the pool fields */

// Which gender the name reads as, from its own national split. A name whose
// minority sex holds >= NEUTRAL_MIN_SHARE of births is 'neutral'.
function genderAssoc(name) {
  const s = natSex.get(fold(name)) || { F: 0, M: 0 };
  const total = s.F + s.M;
  if (!total) return null;
  const minority = Math.min(s.F, s.M) / total;
  if (minority >= NEUTRAL_MIN_SHARE) return 'neutral';
  return s.F > s.M ? 'f' : 'm';
}

// The years a name was actually in use: at or above ERA_PEAK_FRACTION of its
// own peak year, snapped out to 5-year boundaries so these read like the
// pool's existing hand-set windows. A name still in use at the end of the
// data gets NO era_end, which the engine reads as open-ended.
function eraWindow(name) {
  const ny = natYear.get(fold(name));
  if (!ny || !ny.size) return null;
  let peak = 0;
  for (const n of ny.values()) if (n > peak) peak = n;
  const floorCount = peak * ERA_PEAK_FRACTION;
  const live = [...ny.entries()].filter(([, n]) => n >= floorCount).map(([y]) => y).sort((a, b) => a - b);
  if (!live.length) return null;
  const start = Math.max(1900, floorTo(live[0], ERA_ROUND));
  const lastLive = live[live.length - 1];
  // Still current at the edge of the data - do not invent an end date.
  const open = lastLive >= maxYear - ERA_ROUND;
  const end = open ? undefined : Math.min(ceilTo(lastLive, ERA_ROUND), maxYear);
  if (end !== undefined && end <= start) return null;
  return { era_start: start, era_end: end };
}

// The SAME location quotient as build-region-weights.js: a name's share of a
// state's births over its share of national births, measured across the
// name's own era window, with the same rarity floors, clamp and neutral band.
function regionFrequency(name, era) {
  const st = byState.get(fold(name));
  if (!st) return undefined;
  const lo = Math.max(minYear, era.era_start ?? minYear);
  const hi = Math.min(maxYear, era.era_end ?? maxYear);
  if (lo > hi) return undefined;

  const nationalName = states.reduce((sum, s) => sum + sumWindow(st.get(s), lo, hi), 0);
  if (nationalName < MIN_NATIONAL) return undefined;
  let nationalAll = 0;
  for (const [year, n] of nationalYear) if (year >= lo && year <= hi) nationalAll += n;
  const nationalShare = nationalName / nationalAll;
  if (!nationalShare) return undefined;

  const map = {};
  for (const state of states) {
    const stateName = sumWindow(st.get(state), lo, hi);
    if (stateName < MIN_STATE) continue;
    const stateAll = sumWindow(stateYear.get(state), lo, hi);
    if (!stateAll) continue;
    const lq = clamp((stateName / stateAll) / nationalShare, LQ_RANGE[0], LQ_RANGE[1]);
    if (lq >= NEUTRAL_BAND[0] && lq <= NEUTRAL_BAND[1]) continue;
    map['US-' + state] = Math.round(lq * 100) / 100;
  }
  const keys = Object.keys(map).sort();
  if (!keys.length) return undefined;
  return Object.fromEntries(keys.map((k) => [k, map[k]]));
}

/* ------------------------------------------------------------- categorise */

// Category is an ORGANISATIONAL LABEL now, not a selection weight - the real
// region_frequency counts carry commonality. It still has to be right, though:
// a Jose filed under "anglo" would make the admin's Category tab a fiction.
// scripts/name-categories.json maps folded name -> category; anything absent
// falls back to FALLBACK_CATEGORY and is reported, never silently absorbed.
const FALLBACK_CATEGORY = 'anglo';
const categoryMap = fs.existsSync(CATEGORY_PATH)
  ? JSON.parse(fs.readFileSync(CATEGORY_PATH, 'utf8'))
  : {};
const knownCategories = new Set(pool.map((e) => e.category));
const uncategorised = [];
const unknownCategoryValues = new Set();

/* ------------------------------------------------------------- merge only */

const added = [];
const skippedExisting = [];
const contentCollisions = [];
const rejected = { noGender: 0, noEra: 0 };

// A name that IS a mature-content keyword poisons every card it lands on.
// "Molly" is a top-75 girl's name in several states and also slang for MDMA,
// so a safe-mode life could deal "Ask Molly about it" and the keyword backstop
// would correctly flag its own engine's output as drug content - which is
// exactly what it did: the simulator's mature-in-safe assertion failed 5 times
// on one synthesised card once frequency weighting started reaching that name.
//
// Fixed HERE rather than in shared/content.js on purpose. The backstop is one
// of three independent content gates and is supposed to be blunt; teaching it
// to ignore words that happen to be cast names would put a hole in it that a
// card could aim at deliberately. The pool is generated, so the pool is where
// a name that cannot be safely spoken gets filtered out.
const tripsContentBackstop = (name) => {
  const found = detectMature(`Ask ${name} about it.`);
  return Array.isArray(found) ? found.length > 0 : Boolean(found);
};

for (const name of [...candidates].sort()) {
  const key = fold(name);
  // Never touch an existing entry. A candidate already in the pool - under any
  // accenting - is left exactly as authored, which is what keeps Rocio from
  // quietly overwriting Rocío and Siobhan from being "corrected".
  if (taken.has(key)) { skippedExisting.push(name); continue; }

  if (tripsContentBackstop(name)) { contentCollisions.push(name); continue; }

  const gender_assoc = genderAssoc(name);
  if (!gender_assoc) { rejected.noGender++; continue; }
  const era = eraWindow(name);
  if (!era) { rejected.noEra++; continue; }

  let category = categoryMap[key];
  if (!category) { category = FALLBACK_CATEGORY; uncategorised.push(name); }
  else if (!knownCategories.has(category)) unknownCategoryValues.add(category);

  // Key order matches every entry already in the file.
  const entry = { name, category, gender_assoc, active: true, era_start: era.era_start };
  if (era.era_end !== undefined) entry.era_end = era.era_end;
  const rf = regionFrequency(name, era);
  if (rf) entry.region_frequency = rf;

  pool.push(entry);
  taken.add(key);
  added.push(entry);
}

/* ------------------------------------------- national births, every entry */

// How many Americans actually carry this name, summed across the whole
// archive. This is the number the location quotient DIVIDES OUT: an LQ says
// "2.4x commoner in Massachusetts than nationally" for Aino and for James
// alike, so it carries where a name is used and never how much. Without this
// the category draw had no idea that anglo is not the same size as maori.
//
// Stored per NAME rather than per category so it composes with the pool's own
// controls: deactivate half of anglo and anglo's weight falls, because
// shared/names.js sums this over the candidates that actually survived
// filtering rather than reading a fixed per-category total.
//
// Applied to EVERY entry, the original 187 included - it is a measurement
// being attached, not an authored value, and an entry without it would read
// as a category with no people in it.
let measured = 0;
let unmeasured = 0;
for (const entry of pool) {
  const ny = natYear.get(fold(entry.name));
  let total = 0;
  if (ny) for (const n of ny.values()) total += n;
  if (total > 0) { entry.national_births = total; measured++; }
  else { delete entry.national_births; unmeasured++; }
}
console.log(`national_births: measured for ${measured} of ${pool.length} entries`
  + `, ${unmeasured} below the archive's reporting floor (they take BAL.NAMES.categoryBirthsFloor)`);

// One key order for every entry, new and original alike, so national_births
// lands in a readable spot rather than trailing after region_frequency's
// fifty-key object. Same motive as scripts/normalise-content.js has for the
// library and the seed deck: a stable order keeps the diffs legible.
const KEY_ORDER = ['name', 'category', 'gender_assoc', 'active', 'era_start', 'era_end',
  'national_births', 'region_frequency'];
for (let i = 0; i < pool.length; i++) {
  const e = pool[i];
  const ordered = {};
  for (const k of KEY_ORDER) if (e[k] !== undefined) ordered[k] = e[k];
  for (const k of Object.keys(e)) if (!(k in ordered)) ordered[k] = e[k];   // never drop a field
  pool[i] = ordered;
}

/* ---------------------------------------------------------------- report */

console.log(`\ncandidates already in the pool: ${skippedExisting.length}`);
console.log(`dropped: ${rejected.noGender} with no usable sex split, ${rejected.noEra} with no usable era window`);
if (contentCollisions.length) {
  console.log(`dropped ${contentCollisions.length} name(s) that ARE mature-content keywords: ${contentCollisions.join(', ')}`);
}
console.log(`added: ${added.length}   (${added.filter((e) => e.region_frequency).length} with region_frequency)`);
console.log(`pool: ${before} -> ${pool.length} entries`);
if (uncategorised.length) {
  // Not a warning. Most of the SSA top-N IS mainstream American naming stock,
  // so the fallback is the correct answer for it - this stays a visible count,
  // plus a sample, so a genuinely missed cluster is still easy to spot.
  console.log(`\n${uncategorised.length} name(s) took the "${FALLBACK_CATEGORY}" default (no scripts/name-categories.json entry)`);
  console.log('  e.g. ' + uncategorised.slice(0, 12).join(', ') + (uncategorised.length > 12 ? ' ...' : ''));
}
if (unknownCategoryValues.size) {
  console.log(`\n! category value(s) not used anywhere else in the pool: ${[...unknownCategoryValues].join(', ')}`);
}

if (DRY) {
  console.log('\n--dry: nothing written');
} else {
  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2) + '\n');
  console.log(`\nwrote ${POOL_PATH}`);
}
