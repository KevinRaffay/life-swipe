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

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { complete, extractJson, hasKey, MODEL } from '../server/anthropic.js';

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

const source = fs.readFileSync(sourcePath, 'utf8').slice(0, 60000);

const SYSTEM = `You extract reusable LIFE-EVENT PATTERNS from source text for a
life-simulation game's situation library.

A pattern is a SHAPE, not a story. "A promising early career under a charismatic
senior figure who normalises excess" is a shape. "Worked at a particular firm for
a man with a particular name" is not - that is a fact about one person.

RULES, all of them load-bearing:
1. ANONYMISE COMPLETELY. No names of people, companies, funds, products, places
   or publications. No dates, no years, no figures that only make sense for one
   person. If a detail identifies the source, it is wrong.
2. GENERALISE UNTIL IT IS COMMON. Each pattern must plausibly describe thousands
   of different lives across different decades and industries. If it could only
   happen to one person, keep abstracting or discard it.
3. SHAPES, NOT PLOTS. Capture the structure of the decision and its consequence,
   not the sequence of events.
4. NO METHOD. Never describe how to commit a crime, obtain drugs or evade
   detection. Depict decisions and their costs.
5. Discard anything you cannot anonymise. Fewer good patterns beats more weak ones.

Return between 8 and 15 patterns as a JSON array and nothing else. Each object:

{
  "id": "unique_snake_case_id",
  "pattern": "one sentence, anonymous, describing the life-event shape",
  "category": "career|romance|family|money|health|chaos",
  "life_stage": [minAge, maxAge],
  "modes": ["safe"] or ["mature"] or ["safe","mature"],
  "requires": ["flag_a"],
  "excludes": ["flag_b"],
  "typical_effects": "guidance for the storyteller on effect shape, including
                      whether it should create a pending_event or a branch point",
  "rarity": "common|uncommon|rare",
  "note": "optional authoring or firing guidance"
}

"modes" is mature only if the pattern inherently involves drugs, crime, prison,
gambling or vice. requires/excludes are snake_case flags gating when a pattern
may fire; use excludes to stop a pattern repeating within one life.`;

const USER = `Extract patterns from the following source text.

Remember: a reader of your output must not be able to tell whose life it came from.

--- SOURCE ---
${source}
--- END SOURCE ---

Return the JSON array.`;

const CATEGORIES = new Set(['career', 'romance', 'family', 'money', 'health', 'chaos']);
const RARITIES = new Set(['common', 'uncommon', 'rare']);

function validate(p, i) {
  const problems = [];
  if (!p || typeof p !== 'object') return ['[' + i + '] not an object'];
  if (typeof p.id !== 'string' || !/^[a-z0-9_]+$/.test(p.id)) problems.push('[' + i + '] bad id');
  if (typeof p.pattern !== 'string' || p.pattern.length < 20) problems.push('[' + i + '] pattern too short');
  if (!CATEGORIES.has(p.category)) problems.push('[' + i + '] category: ' + p.category);
  if (!Array.isArray(p.life_stage) || p.life_stage.length !== 2) problems.push('[' + i + '] life_stage');
  else if (!(p.life_stage[0] >= 0 && p.life_stage[1] > p.life_stage[0])) problems.push('[' + i + '] life_stage range');
  if (!Array.isArray(p.modes) || !p.modes.length) problems.push('[' + i + '] modes');
  else if (p.modes.some((m) => m !== 'safe' && m !== 'mature')) problems.push('[' + i + '] unknown mode');
  if (typeof p.typical_effects !== 'string' || !p.typical_effects.trim()) problems.push('[' + i + '] typical_effects');
  if (!RARITIES.has(p.rarity)) problems.push('[' + i + '] rarity: ' + p.rarity);
  return problems;
}

// A last, blunt sweep for the thing that matters most here: leaked identity.
const STOPWORDS = new Set(['The', 'A', 'An', 'In', 'At', 'On', 'When', 'After', 'Before',
  'His', 'Her', 'Their', 'One', 'Two', 'Both', 'If', 'As', 'It', 'He', 'She', 'They',
  'Set', 'Create', 'Money', 'Happiness', 'Health', 'Requires', 'Effects', 'Note']);

function identityWarnings(p) {
  const text = [p.pattern, p.typical_effects, p.note || ''].join(' ');
  // Ignore sentence-initial capitals - they are grammar, not identity. Only a
  // capitalised word sitting mid-sentence is a candidate proper noun.
  const midSentence = text.replace(/(^|[.!?;:][ 	]+)[A-Z]/g, (m) => m.toLowerCase());
  const names = [...new Set((midSentence.match(/[A-Z][a-z]{2,}/g) || []).filter((w) => !STOPWORDS.has(w)))];
  const years = [...new Set(text.match(/(18|19|20)[0-9][0-9]/g) || [])];
  const out = [];
  if (names.length) out.push('possible proper nouns: ' + names.join(', '));
  if (years.length) out.push('years: ' + years.join(', '));
  return out;
}

const t0 = Date.now();
console.log('reading  ' + sourcePath + ' (' + source.length + ' chars)');
console.log('model    ' + MODEL);

const { text } = await complete({
  system: SYSTEM,
  user: USER,
  maxTokens: 6000,
  temperature: 0.7,
  // A 15-pattern extraction is a long generation; the 30s default is not enough.
  timeoutMs: 180000,
});

const parsed = extractJson(text);
if (!Array.isArray(parsed)) {
  console.error('\nModel did not return a JSON array. Raw reply saved for inspection.');
  fs.writeFileSync(OUT + '.raw.txt', text);
  process.exit(1);
}

const problems = parsed.flatMap((p, i) => validate(p, i));
const existing = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'situation-library.json'), 'utf8'));
const existingIds = new Set(existing.map((p) => p.id));
const collisions = parsed.filter((p) => existingIds.has(p.id)).map((p) => p.id);

fs.writeFileSync(OUT, JSON.stringify(parsed, null, 2) + '\n');

console.log('\nwrote    ' + OUT + '  (' + parsed.length + ' candidates, ' +
            ((Date.now() - t0) / 1000).toFixed(1) + 's)\n');

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
for (const p of parsed) {
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
