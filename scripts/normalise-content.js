#!/usr/bin/env node
// Rewrite the content files in the admin's canonical key order, once.
//
//   npm run normalise-content            # report what would change
//   npm run normalise-content -- --write # do it
//
// WHY THIS EXISTS. The admin saves every file through server/admin/store.js,
// which imposes a stable key order so diffs stay readable. scenarios-seed.json
// did not have one order before: some cards put "modes" near the front and
// others near the back, so the first save of any card would have reshuffled all
// 57 and buried a one-line edit in a 900-line diff. Running this once, in its
// own commit, moves that churn out of the way.
//
// Key order only. No value is read, changed, added or dropped, and the script
// proves that to itself before writing.

import fs from 'node:fs';
import { read, write, serialise, fileOf } from '../server/admin/store.js';

const WRITE = process.argv.includes('--write');
// The demo pool is a seed-shaped file written by the same store, so it takes
// the same canonical key order. It is generated rather than hand-authored, so
// it starts canonical and this is a no-op on it - which is the point: if it
// ever stops being canonical, that is worth seeing.
const TARGETS = ['library', 'seeds', 'demoSeeds'];

/** Deep key-sorted JSON, so two values compare equal whatever order they hold. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

let changed = 0;
for (const name of TARGETS) {
  const { data, version, exists } = read(name);
  if (!exists) { console.log(`${name}: not present, skipped`); continue; }

  const before = fs.readFileSync(fileOf(name), 'utf8');
  const after = serialise(data, name === 'library' ? 'pattern' : 'seed');

  // The safety check: compare both sides as VALUES. A plain JSON.stringify
  // comparison will not do - stringify preserves key order, so it reports every
  // reorder as a data change, which is the one thing this must not confuse.
  // Sorting keys recursively first makes the comparison order-blind, so a
  // failure here really does mean a value was dropped or invented.
  const same = canonical(JSON.parse(before)) === canonical(JSON.parse(after));
  if (!same) {
    console.error(`${name}: ABORT - reordering changed the data, not just the key order`);
    process.exit(1);
  }

  if (before === after) {
    console.log(`${name}: already canonical`);
    continue;
  }
  changed++;
  const diffLines = after.split('\n').length - before.split('\n').length;
  console.log(`${name}: key order differs (${diffLines >= 0 ? '+' : ''}${diffLines} lines) -> ${fileOf(name)}`);
  if (WRITE) {
    const result = write(name, data, { version });
    console.log(`  written, previous kept as ${result.backup}`);
  }
}

if (!WRITE && changed) {
  console.log('\nNothing written. Re-run with --write to apply.');
} else if (!changed) {
  console.log('\nEverything already in canonical order.');
}
