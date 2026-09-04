#!/usr/bin/env node
// Bulk-generate DEMO seed candidates, down the demo storyteller path
// (server/demo-prompt.js) and the game's real validators.
//
//   node scripts/generate-demo-seeds.js                    # ~1000 candidates
//   node scripts/generate-demo-seeds.js --total=60          # a pilot run
//   node scripts/generate-demo-seeds.js --out=pilot.json
//
// Writes demo-seed-scenarios.draft.json for a human to review - in the admin
// module's "Demo pool" tab, or by hand. It NEVER writes to
// data/demo-seed-scenarios.json. Entering the demo pool is always an explicit
// human approval, exactly like the seed deck and the situation library.
//
// The generation core - age-band targeting, theme rotation, batching, the
// register screen, de-duplication - lives in server/demo-seed-generation.js,
// shared with the admin module's "Generate demo pool" button so the two
// cannot drift. Same relationship scripts/generate-seed-scenarios.js has to
// server/seed-generation.js.
//
// Provider: whatever LLM_PROVIDER says (server/provider.js). No backend is
// named here or in anything this calls.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { hasKey, PROVIDER, MODEL } from '../server/provider.js';
import { generateDemoDrafts, DEFAULT_TOTAL } from '../server/demo-seed-generation.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const totalRaw = flag('total', null);
const total = totalRaw !== null ? Number(totalRaw) : DEFAULT_TOTAL;
if (!Number.isFinite(total) || total < 1) {
  console.error('--total must be a positive number');
  process.exit(2);
}

const OUT = flag('out', null) || path.join(ROOT, 'demo-seed-scenarios.draft.json');

if (!hasKey()) {
  console.error('No LLM provider is configured - set ANTHROPIC_API_KEY, or LLM_PROVIDER=ollama with OLLAMA_MODEL. See the README.');
  process.exit(2);
}

const existingDrafts = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
const livePoolPath = path.join(ROOT, 'data', 'demo-seed-scenarios.json');
const livePool = fs.existsSync(livePoolPath) ? JSON.parse(fs.readFileSync(livePoolPath, 'utf8')) : [];

console.log(`generating demo candidates  total=${total}  provider=${PROVIDER} (${MODEL})`);
console.log(`  ${existingDrafts.length} already in the draft queue, ${livePool.length} already approved into the pool\n`);

const started = Date.now();
let stopped = false;
process.on('SIGINT', () => {
  if (stopped) process.exit(130);
  stopped = true;
  console.log('\n  stopping after the current batch - anything already accepted is still written...');
});

const results = await generateDemoDrafts({
  total,
  existingIds: new Set([...existingDrafts, ...livePool].map((d) => d.id)),
  existingPrompts: [...existingDrafts, ...livePool].map((d) => d.prompt).filter(Boolean),
  shouldStop: () => stopped,
  onStage: ({ stage, label, target, marked }) => {
    // The final cross-stage near-duplicate sweep reports through the same
    // callback with stage 'all' and no target, so it needs its own line
    // rather than "generating undefined candidate(s)".
    if (stage === 'all') {
      console.log(`\nnear-duplicate pass: flagged ${marked} card(s) as the same situation as an earlier one`);
      return;
    }
    console.log(`${stage.padEnd(9)} ${label} - generating ${target} candidate(s)...`);
  },
  onBatch: ({ batch, stage, produced, total: got, target, error }) => {
    if (error) { console.log(`    ${stage} batch ${batch}: call failed - ${error}`); return; }
    console.log(`    ${stage} batch ${batch}: +${produced} accepted  (${got}/${target})`);
  },
});

const generated = results.flatMap((r) => r.accepted);
const merged = [...existingDrafts, ...generated];
fs.writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nwrote  ${OUT}  (${generated.length} new candidate(s), ${merged.length} total awaiting review)  in ${mins} min\n`);

console.log('  stage     got / target   batches  returned  invalid  non-minor  register  duplicate  warned');
const totals = { batches: 0, returned: 0, invalid: 0, nonMinor: 0, register: 0, duplicate: 0, warned: 0 };
for (const r of results) {
  const s = r.stats;
  for (const k of Object.keys(totals)) totals[k] += s[k] || 0;
  console.log(
    `  ${r.stage.padEnd(9)} ${String(r.accepted.length).padStart(4)} / ${String(r.target).padEnd(6)} ` +
    `${String(s.batches).padStart(7)} ${String(s.returned).padStart(9)} ${String(s.invalid).padStart(8)} ` +
    `${String(s.nonMinor).padStart(10)} ${String(s.register).padStart(9)} ${String(s.duplicate).padStart(10)} ` +
    `${String(s.warned).padStart(7)}`,
  );
}
console.log(
  `  ${'TOTAL'.padEnd(9)} ${String(generated.length).padStart(4)} / ${String(total).padEnd(6)} ` +
  `${String(totals.batches).padStart(7)} ${String(totals.returned).padStart(9)} ${String(totals.invalid).padStart(8)} ` +
  `${String(totals.nonMinor).padStart(10)} ${String(totals.register).padStart(9)} ${String(totals.duplicate).padStart(10)} ` +
  `${String(totals.warned).padStart(7)}`,
);

const clean = generated.filter((g) => !g.validationWarnings).length;
console.log(`\n  ${clean} of ${generated.length} new candidate(s) carry NO warnings; ${generated.length - clean} are flagged.`);
console.log('  The admin\'s "Approve all without warnings" / "Reject all with warnings" act on exactly that split.');

// Register drops are the interesting failure: a candidate the model wrote that
// crossed the line the register brief draws. Worth seeing, not just counting.
const drops = results.flatMap((r) => r.registerDrops || []);
if (drops.length) {
  console.log(`\n  ${totals.register} candidate(s) dropped on the register screen. First few:`);
  for (const d of drops.slice(0, 5)) {
    console.log(`    - ${d.violations[0]}`);
    console.log(`      "${String(d.prompt).slice(0, 100)}"`);
  }
}

console.log('\nThis is a DRAFT. Nothing has been added to data/demo-seed-scenarios.json.');
console.log('Review in the admin module ("Demo pool" tab) or by hand, then approve the ones you want.');

process.exitCode = generated.length ? 0 : 1;
