#!/usr/bin/env node
// Seed-content coverage. Run standalone (npm run coverage) and also called at
// server startup, so a thin bucket is visible immediately instead of being
// discovered as "I keep seeing the same card".

import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

export const BUCKETS = [
  { id: 'highschool', label: 'High School', range: [16, 18], first: true },
  { id: 'college', label: 'College / First Job', range: [18, 22] },
  { id: 'early', label: 'Early Career', range: [22, 30] },
  { id: 'family', label: 'Family & Mid-Career', range: [30, 50] },
  { id: 'late', label: 'Late Career', range: [50, 65] },
  { id: 'retirement', label: 'Retirement', range: [65, 110] },
];

// The first playable bracket carries the whole opening of every run, so it
// needs more. Later buckets get topped up by the storyteller and fallbacks.
export const TARGET_FIRST = 8;
export const TARGET_OTHER = 4;

export function overlaps(scenarioRange, bucketRange) {
  return scenarioRange[0] < bucketRange[1] && scenarioRange[1] > bucketRange[0];
}

/** Scenarios usable in a bucket for a mode, ignoring flag gating. */
export function coverage(seeds) {
  const rows = [];
  for (const bucket of BUCKETS) {
    for (const mode of ['safe', 'mature']) {
      const matches = seeds.filter((s) => {
        const range = s.life_stage || [16, 110];
        if (!overlaps(range, bucket.range)) return false;
        if (!s.modes.includes(mode)) return false;
        // Flag-gated cards cannot be relied on for baseline coverage.
        if (s.requiresFlags && s.requiresFlags.length) return false;
        return true;
      });
      const target = bucket.first ? TARGET_FIRST : TARGET_OTHER;
      rows.push({
        bucket: bucket.id,
        label: bucket.label,
        mode,
        count: matches.length,
        target,
        short: matches.length < target,
        ids: matches.map((s) => s.id),
      });
    }
  }
  return rows;
}

export function loadSeeds() {
  return JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../data/scenarios-seed.json', import.meta.url)), 'utf8'),
  );
}

/** Returns the short buckets; prints a table when verbose. */
export function checkCoverage({ verbose = true, seeds = loadSeeds() } = {}) {
  const rows = coverage(seeds);
  const shortfalls = rows.filter((r) => r.short);
  if (verbose) {
    console.log('\nSEED COVERAGE  (unGated scenarios per bucket and mode)\n');
    console.log('  bucket            mode     count  target');
    for (const r of rows) {
      const mark = r.short ? '  SHORT' : '';
      console.log(`  ${r.bucket.padEnd(17)} ${r.mode.padEnd(8)} ${String(r.count).padStart(5)}  ${String(r.target).padStart(6)}${mark}`);
    }
    console.log(`\n  ${seeds.length} seeds total, ${shortfalls.length} bucket/mode pairs below target\n`);
  }
  return shortfalls;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('coverage.js');
if (invokedDirectly) {
  const shortfalls = checkCoverage();
  process.exitCode = shortfalls.length ? 1 : 0;
}
