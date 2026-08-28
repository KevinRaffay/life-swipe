#!/usr/bin/env node
// Turn a piece of source text - a memoir summary, an obituary, a long profile -
// into candidate situation-library patterns.
//
//   node scripts/extract-patterns.js path/to/source.txt
//   node scripts/extract-patterns.js source.txt --out=my-draft.json
//
// Writes situation-library.draft.json for a human to read, edit and merge by
// hand. It NEVER writes to server/situation-library.json. The whole point is
// that a person decides what enters the library.
//
// The extraction itself - the prompt, the schema check, the anonymity sweep -
// lives in server/extraction.js, shared with the admin module's paste box so
// the two cannot drift apart. This file owns the command line and the report.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { hasKey } from '../server/anthropic.js';
import { extractPatterns, identityWarnings, idCollisions, MAX_SOURCE_CHARS } from '../server/extraction.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const sourcePath = args.find((a) => !a.startsWith('--'));
const outFlag = args.find((a) => a.startsWith('--out='));
const OUT = outFlag ? outFlag.split('=')[1] : path.join(ROOT, 'situation-library.draft.json');

if (!sourcePath) {
  console.error('usage: node scripts/extract-patterns.js <source.txt> [--out=file.json]');
  process.exit(2);
}
if (!fs.existsSync(sourcePath)) {
  console.error('no such file: ' + sourcePath);
  process.exit(2);
}
if (!hasKey()) {
  console.error('ANTHROPIC_API_KEY is not set - see the README.');
  process.exit(2);
}

const source = fs.readFileSync(sourcePath, 'utf8').slice(0, MAX_SOURCE_CHARS);
console.log('reading  ' + sourcePath + ' (' + source.length + ' chars)');

let result;
try {
  result = await extractPatterns(source);
} catch (err) {
  if (err.raw) {
    console.error('\nModel did not return a JSON array. Raw reply saved for inspection.');
    fs.writeFileSync(OUT + '.raw.txt', err.raw);
  } else {
    console.error('\n' + err.message);
  }
  process.exit(1);
}

const { patterns, problems, model, ms } = result;
console.log('model    ' + model);

const existing = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'situation-library.json'), 'utf8'));
const collisions = idCollisions(patterns, existing);

fs.writeFileSync(OUT, JSON.stringify(patterns, null, 2) + '\n');

console.log('\nwrote    ' + OUT + '  (' + patterns.length + ' candidates, ' +
            (ms / 1000).toFixed(1) + 's)\n');

if (problems.length) {
  console.log('SCHEMA PROBLEMS');
  for (const p of problems) console.log('  ' + p);
  console.log('');
}
if (collisions.length) {
  console.log('ID COLLISIONS with the live library: ' + collisions.join(', ') + '\n');
}

console.log('ANONYMITY REVIEW - read every one of these yourself');
let flagged = 0;
for (const p of patterns) {
  const warnings = identityWarnings(p);
  if (warnings.length) {
    flagged++;
    console.log('  ' + p.id);
    for (const w of warnings) console.log('      ' + w);
  }
}
if (!flagged) console.log('  no proper nouns or years detected (still read them yourself)');

console.log('\nThis is a DRAFT. Nothing has been added to the library.');
console.log('Review, edit, then merge the entries you want into server/situation-library.json.');
