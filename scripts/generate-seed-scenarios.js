#!/usr/bin/env node
// Bulk-generate seed-scenario CANDIDATES for coverage-thin buckets, down the
// real storyteller path (server/prompt.js), called directly rather than
// through the player-facing /api/scenarios endpoint.
//
//   node scripts/generate-seed-scenarios.js --mode=both --target=15
//   node scripts/generate-seed-scenarios.js --mode=mature
//   node scripts/generate-seed-scenarios.js --mode=safe --target=10 --out=my-draft.json
//   node scripts/generate-seed-scenarios.js --force   # every bucket, not just short ones
//
// Writes scenarios-seed.draft.json for a human to review - in the admin
// module's "Generate seeds" tab, or by hand. It NEVER writes to
// data/scenarios-seed.json. Entering the seed deck is always an explicit
// human approval, exactly like scripts/extract-patterns.js and the
// situation library.
//
// The generation core - sampling a plausible state per bucket, calling the
// same prompt builders and validators live play uses, the weight-tier mix,
// occasional library-pattern grounding - lives in server/seed-generation.js,
// shared with the admin module's "Generate" button so the two cannot drift.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { hasKey } from '../server/provider.js';
import { loadSeeds } from './coverage.js';
import { generateSeedDrafts, DEFAULT_TARGET_FIRST, DEFAULT_TARGET_OTHER } from '../server/seed-generation.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const boolFlag = (name) => args.includes(`--${name}`);

const mode = flag('mode', 'both');
if (!['safe', 'mature', 'both'].includes(mode)) {
  console.error('--mode must be safe, mature or both');
  process.exit(2);
}

const targetRaw = flag('target', null);
const target = targetRaw !== null ? Number(targetRaw) : null;
if (targetRaw !== null && (!Number.isFinite(target) || target < 1)) {
  console.error('--target must be a positive number');
  process.exit(2);
}

const OUT = flag('out', null) || path.join(ROOT, 'scenarios-seed.draft.json');
const force = boolFlag('force');

if (!hasKey()) {
  console.error('ANTHROPIC_API_KEY is not set - see the README.');
  process.exit(2);
}

const seeds = loadSeeds();
const library = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'situation-library.json'), 'utf8'));
const existingDrafts = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];

console.log(`generating seed candidates  mode=${mode}  target=${target || `default (${DEFAULT_TARGET_FIRST} opening / ${DEFAULT_TARGET_OTHER} elsewhere)`}${force ? '  (--force: ignoring current coverage)' : ''}\n`);

const results = await generateSeedDrafts({
  seeds,
  library,
  mode,
  target,
  force,
  existingIds: new Set(existingDrafts.map((d) => d.id)),
  onBucket: ({ bucket, mode: m, target: t, current, note }) => {
    console.log(`${bucket.padEnd(12)} ${m.padEnd(7)} ${String(current).padStart(2)} on hand, short - generating ${t} candidate(s)...`);
    if (note) console.log(`  note: ${note}`);
  },
  onBatch: ({ batch, tier, slot, produced, error }) => {
    if (error) { console.log(`  batch ${batch}: call failed - ${error}`); return; }
    console.log(`  batch ${batch}: ${produced} candidate(s) validated (tier ${tier})${slot ? `, grounded in ${slot}` : ''}`);
  },
});

if (!results.length) {
  console.log(`Nothing short for mode=${mode}. Run "npm run coverage" to check current bucket coverage, or pass --force to generate anyway.`);
  process.exit(0);
}

const generated = results.flatMap((r) => r.accepted);
const merged = [...existingDrafts, ...generated];
fs.writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');

console.log(`\nwrote  ${OUT}  (${generated.length} new candidate(s), ${merged.length} total awaiting review)\n`);

console.log('  bucket            mode     got / target');
let short = 0;
for (const r of results) {
  const flag2 = r.accepted.length < r.target ? '  SHORT of target - model or validator ran dry' : '';
  console.log(`  ${r.bucket.padEnd(17)} ${r.mode.padEnd(8)} ${String(r.accepted.length).padStart(3)} / ${r.target}${flag2}`);
  if (r.accepted.length < r.target) short++;
}

const withWarnings = generated.filter((g) => g.validationWarnings && g.validationWarnings.length).length;
if (withWarnings) console.log(`\n  ${withWarnings} candidate(s) carry validationWarnings (major-tier craft drift) - read them before approving.`);

console.log('\nThis is a DRAFT. Nothing has been added to data/scenarios-seed.json.');
console.log('Review in the admin module ("Generate seeds" tab) or by hand, then approve the ones you want.');

process.exitCode = short ? 1 : 0;
