#!/usr/bin/env node
// One-time build: generate the region_frequency maps in server/name-pool.json
// from real US Social Security Administration state-level birth data.
//
//   node scripts/build-region-weights.js <dir-of-SSA-state-files> [--dry]
//   npm run build-region-weights -- ../ssa-state
//
// WHY A SCRIPT AND NOT HAND-WRITTEN WEIGHTS
// Guessing which names "belong" in which state is exactly how you encode a
// stereotype instead of a demographic. Every number this writes comes from
// counted births. Where the data is silent the name gets no entry, which the
// engine reads as "no regional signal", never as "does not belong here".
//
// GETTING THE SOURCE DATA (not committed - 114MB extracted)
//   https://www.ssa.gov/oact/babynames/limits.html -> "State-specific data"
//   which is https://www.ssa.gov/oact/babynames/state/namesbystate.zip
// Unzip it anywhere and pass the directory. Files are one per state, either
// SSA's own "AK.TXT" or the commonly mirrored "namesbystate_AK.TXT", each line
//   STATE,SEX,YEAR,NAME,COUNT
// COUNT is suppressed below 5 births, which is the SSA's own privacy floor and
// the reason rare names go missing from small states.
//
// THE STATISTIC: LOCATION QUOTIENT, NOT RAW COUNTS
// Raw counts rank states by population and nothing else - "Ayaan" peaks in
// California, "Mai" peaks in California, everything peaks in California. What
// the game wants is over-representation:
//
//   LQ(name, state) = (name's share of that state's births)
//                     ---------------------------------------
//                     (name's share of all US births)
//
// so 1.0 means "exactly as common here as nationally", 3.0 means "three times
// more common here". That is comparable ACROSS names, which matters because
// the sampler weighs names against each other. It also gives the engine a
// principled default for a name with no data: 1.0, meaning no opinion.
//
// Counted only over each name's own era window (era_start..era_end), so a name
// that was current in the 1950s is measured against the 1950s, not against a
// century in which it barely appears.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const POOL_PATH = fileURLToPath(new URL('../server/name-pool.json', import.meta.url));

// Tuning. All three exist to keep noise out: the SSA's own 5-birth floor means
// a name can look wildly over-represented in one small state on the strength
// of a single family.
// Measured, not guessed. Sorting every pool name by its US births shows a
// clean break around 110: above it names appear across 2-8 states, which is a
// population; below it they appear in one state with 5-20 births, which is a
// family. MIN_STATE then stops any single state's weight resting on fewer
// than 25 births, so a suppression-floor artefact cannot become a signal.
const MIN_NATIONAL = 120;   // below this a name gets no map at all
const MIN_STATE = 25;       // below this a state is not counted for that name
// Real LQs run past 50 (Nizhoni in New Mexico, Keanu in Hawaii). Clamping at
// 25 keeps the handful of extreme values from swamping the sampler while
// leaving every ordinary signal untouched - it binds on 7 pairs out of ~2200.
// How hard this tilts the draw is the ENGINE's decision (BAL.NAMES.regionPower),
// not this file's: what gets stored here is the measurement.
const LQ_RANGE = [0.1, 25];
// Only regions that actually say something get stored. A name that sits at
// national average everywhere would otherwise write 50 entries meaning nothing.
const NEUTRAL_BAND = [0.8, 1.3];

// SSA data is plain ASCII, so "Océane" has to be matched as "oceane".
const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/* ------------------------------------------------------------------ input */

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const sourceDir = args.find((a) => !a.startsWith('--')) || process.env.SSA_STATE_DIR;

if (!sourceDir) {
  console.error('usage: node scripts/build-region-weights.js <dir-of-SSA-state-files> [--dry]');
  console.error('       the directory holds AK.TXT ... WY.TXT from namesbystate.zip');
  console.error('       https://www.ssa.gov/oact/babynames/limits.html');
  process.exit(2);
}
if (!fs.existsSync(sourceDir)) {
  console.error(`no such directory: ${sourceDir}`);
  process.exit(2);
}

const STATE_FILE = /^(?:namesbystate_)?([A-Z]{2})\.TXT$/i;
const files = fs.readdirSync(sourceDir).filter((f) => STATE_FILE.test(f));
if (!files.length) {
  console.error(`no state files in ${sourceDir} (expected AK.TXT or namesbystate_AK.TXT)`);
  process.exit(2);
}

const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
// Two pool entries could fold to one SSA spelling; keep every entry that does.
const wanted = new Map();
for (const entry of pool) {
  const key = fold(entry.name);
  if (!wanted.has(key)) wanted.set(key, []);
  wanted.get(key).push(entry);
}

/* ------------------------------------------------------------- counting */

// stateYear[state][year] = every birth recorded that year, so a name's share
// has a denominator. nameState[foldedName][state][year] = that name's births.
const stateYear = new Map();
const nameState = new Map();
let minYear = Infinity;
let maxYear = -Infinity;
let lines = 0;

for (const file of files) {
  const state = file.match(STATE_FILE)[1].toUpperCase();
  const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
  const years = new Map();
  stateYear.set(state, years);

  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.trim().split(',');
    if (parts.length < 5) continue;
    const year = Number(parts[2]);
    const count = Number(parts[4]);
    if (!Number.isFinite(year) || !Number.isFinite(count)) continue;
    lines++;
    if (year < minYear) minYear = year;
    if (year > maxYear) maxYear = year;
    years.set(year, (years.get(year) || 0) + count);

    const key = fold(parts[3]);
    if (!wanted.has(key)) continue;
    let byState = nameState.get(key);
    if (!byState) { byState = new Map(); nameState.set(key, byState); }
    let byYear = byState.get(state);
    if (!byYear) { byYear = new Map(); byState.set(state, byYear); }
    byYear.set(year, (byYear.get(year) || 0) + count);
  }
}

const states = [...stateYear.keys()].sort();
console.log(`read ${lines.toLocaleString()} rows, ${states.length} states, years ${minYear}-${maxYear}`);

/* ------------------------------------------------- location quotient pass */

// National totals per year, summed from the states themselves so numerator and
// denominator always come from the same 50-odd files.
const nationalYear = new Map();
for (const years of stateYear.values()) {
  for (const [year, n] of years) nationalYear.set(year, (nationalYear.get(year) || 0) + n);
}

const sumWindow = (byYear, lo, hi) => {
  let total = 0;
  if (!byYear) return 0;
  for (const [year, n] of byYear) if (year >= lo && year <= hi) total += n;
  return total;
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const report = { withMap: 0, noData: 0, tooRare: 0, flat: 0, entries: 0 };
const examples = [];

for (const [key, entries] of wanted) {
  const byState = nameState.get(key);
  for (const entry of entries) {
    delete entry.region_frequency;

    // Cross-reference the era fields: measure a name against its own years.
    const lo = Math.max(minYear, entry.era_start ?? minYear);
    const hi = Math.min(maxYear, entry.era_end ?? maxYear);
    if (!byState || lo > hi) { report.noData++; continue; }

    const nationalName = states.reduce((sum, st) => sum + sumWindow(byState.get(st), lo, hi), 0);
    if (nationalName < MIN_NATIONAL) { report.tooRare++; continue; }

    let nationalAll = 0;
    for (const [year, n] of nationalYear) if (year >= lo && year <= hi) nationalAll += n;
    const nationalShare = nationalName / nationalAll;
    if (!nationalShare) { report.noData++; continue; }

    const map = {};
    for (const state of states) {
      const stateName = sumWindow(byState.get(state), lo, hi);
      if (stateName < MIN_STATE) continue;
      const stateAll = sumWindow(stateYear.get(state), lo, hi);
      if (!stateAll) continue;
      const lq = clamp((stateName / stateAll) / nationalShare, LQ_RANGE[0], LQ_RANGE[1]);
      if (lq >= NEUTRAL_BAND[0] && lq <= NEUTRAL_BAND[1]) continue;   // says nothing
      map['US-' + state] = Math.round(lq * 100) / 100;
    }

    const keys = Object.keys(map);
    if (!keys.length) { report.flat++; continue; }
    // Deterministic key order, so a rebuild produces a byte-identical file.
    entry.region_frequency = Object.fromEntries(keys.sort().map((k) => [k, map[k]]));
    report.withMap++;
    report.entries += keys.length;
    const top = keys.sort((a, b) => map[b] - map[a])[0];
    examples.push({ name: entry.name, category: entry.category, top, lq: map[top], n: nationalName });
  }
}

console.log(`\nnames with a regional map : ${report.withMap}`);
console.log(`  no SSA presence at all   : ${report.noData}`);
console.log(`  under ${MIN_NATIONAL} US births      : ${report.tooRare}`);
console.log(`  national-average everywhere: ${report.flat}`);
console.log(`  region entries written   : ${report.entries}`);

console.log('\nmost regionally distinctive names:');
examples.sort((a, b) => b.lq - a.lq).slice(0, 15).forEach((e) => {
  console.log(`  ${e.name.padEnd(12)} ${e.category.padEnd(20)} ${e.top}  ${e.lq}x  (${e.n.toLocaleString()} births)`);
});

if (DRY) {
  console.log('\n--dry: name-pool.json not written');
} else {
  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2) + '\n');
  const kb = Math.round(fs.statSync(POOL_PATH).size / 1024);
  console.log(`\nwrote ${POOL_PATH} (${kb}KB)`);
}
