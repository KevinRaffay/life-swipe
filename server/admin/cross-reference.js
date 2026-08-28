// Can this pattern ever actually fire?
//
// A library pattern gates on snake_case flags (shared/library.js -> filterPatterns).
// If a `requires` flag is one that nothing in the game ever SETS, the pattern is
// unreachable: it will sit in the file looking like content forever. This walks
// every place a flag can come from and reports the ones that cannot.
//
// BEST-EFFORT, AND IT SAYS SO. The storyteller invents flags freely on ordinary
// generated cards, and this check cannot see those. So everything here is a
// WARNING for a human to judge, never a hard error and never a save blocker.
//
// Not to be confused with the "8 of 13 patterns are dead in simulation" item in
// CLAUDE.md. That has a different cause entirely - chains needing upstream flags
// that cross-life `seen_patterns` stops recurring - and a pattern can be clean
// here while still rarely firing in practice. This answers only: "is there any
// path at all by which this flag becomes true?"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { read, exists } from './store.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Flag-shaped tokens in prose. Same shape scripts/simulate.js uses to synthesise
// library stand-ins, so the two agree on what "looks like a flag" means.
const FLAG_TOKEN = /[a-z]+(?:_[a-z]+)+/g;
const NOT_A_FLAG = new Set([
  'pending_event', 'typical_effects', 'life_stage', 'library_id', 'branch_point',
  'snake_case', 'time_cost', 'left_effects', 'right_effects',
]);

// Flags the ENGINE itself sets or reacts to, which no content file mentions in
// a way this scanner would see. Mirrors the canonical list in server/prompt.js.
export const ENGINE_FLAGS = [
  'in_school', 'student_debt', 'married', 'retired', 'lives_with_parents',
  'smoker', 'heavy_drinker', 'chronic_illness', 'has_kids',
];

/** Every flag any content in this repo can set, with where it came from. */
export function collectSettableFlags({ library, seeds, threads = [] } = {}) {
  const sources = new Map();
  const add = (flag, source) => {
    if (!flag || NOT_A_FLAG.has(flag)) return;
    if (!sources.has(flag)) sources.set(flag, new Set());
    sources.get(flag).add(source);
  };

  for (const flag of ENGINE_FLAGS) add(flag, 'engine');

  // Seed cards: the flags they actually set, and the ones they clear (a flag
  // being cleared somewhere is proof it can be set somewhere).
  for (const card of seeds || []) {
    for (const side of ['leftEffects', 'rightEffects']) {
      const eff = card[side] || {};
      for (const f of eff.flags || []) add(f, `seed:${card.id}`);
      for (const f of eff.clearFlags || []) add(f, `seed:${card.id}`);
    }
  }

  // Pattern guidance is prose, not structured effects, so the flags it asks the
  // storyteller to set have to be mined out of the sentence.
  for (const p of library || []) {
    for (const token of String(p.typical_effects || '').match(FLAG_TOKEN) || []) {
      add(token, `library:${p.id}`);
    }
  }

  // Procedural fallbacks are real cards too, and they set flags.
  const fallbackPath = path.join(ROOT, 'shared', 'fallback.js');
  if (fs.existsSync(fallbackPath)) {
    const src = fs.readFileSync(fallbackPath, 'utf8');
    for (const block of src.match(/flags:\s*\[[^\]]*\]/g) || []) {
      for (const quoted of block.match(/'([a-z0-9_]+)'/g) || []) add(quoted.replace(/'/g, ''), 'fallback');
    }
  }

  for (const thread of threads || []) {
    for (const beat of thread.beats || []) {
      for (const f of beat.sets || beat.flags || []) add(f, `thread:${thread.id}`);
    }
  }

  return sources;
}

/**
 * Run the whole check.
 * @returns {{ warnings: Array, stats: object }}
 */
export function crossReference() {
  const library = read('library').data;
  const seeds = read('seeds').data;
  const threadsPresent = exists('threads');
  const threads = threadsPresent ? read('threads').data : [];

  const settable = collectSettableFlags({ library, seeds, threads });
  const patternIds = new Set(library.map((p) => p.id));
  const warnings = [];

  for (const p of library) {
    // The serious one: a requirement nothing can satisfy means the pattern can
    // never be selected, in any life, ever.
    for (const flag of p.requires || []) {
      if (!settable.has(flag)) {
        warnings.push({
          severity: 'unreachable',
          patternId: p.id,
          field: 'requires',
          flag,
          message: `"${p.id}" requires "${flag}", which nothing in the library, the seed deck or the engine ever sets. This pattern can never fire.`,
        });
      }
    }
    // The milder one: an exclusion that can never trigger is not broken, it is
    // simply doing nothing, so the pattern is more available than it looks.
    for (const flag of p.excludes || []) {
      if (!settable.has(flag)) {
        warnings.push({
          severity: 'inert',
          patternId: p.id,
          field: 'excludes',
          flag,
          message: `"${p.id}" excludes "${flag}", which nothing ever sets, so the exclusion never applies.`,
        });
      }
    }
  }

  // Thread beats pointing at patterns that do not exist. Skipped entirely while
  // the file is absent, which is the state this repo is in today.
  if (threadsPresent) {
    for (const thread of threads) {
      for (const [i, beat] of (thread.beats || []).entries()) {
        const ref = beat.patternId || beat.pattern_id || beat.pattern;
        if (ref && !patternIds.has(ref)) {
          warnings.push({
            severity: 'broken-reference',
            threadId: thread.id,
            beat: i,
            message: `thread "${thread.id}" beat ${i} references pattern "${ref}", which is not in the library.`,
          });
        }
      }
    }
  }

  const bySeverity = (s) => warnings.filter((w) => w.severity === s).length;
  return {
    warnings,
    stats: {
      patterns: library.length,
      seeds: seeds.length,
      threads: threadsPresent ? threads.length : null,
      settableFlags: settable.size,
      unreachable: bySeverity('unreachable'),
      inert: bySeverity('inert'),
      brokenReferences: bySeverity('broken-reference'),
      // Distinct patterns affected, which is what a "dead pattern count" means
      // to a person reading the stats screen.
      unreachablePatterns: new Set(
        warnings.filter((w) => w.severity === 'unreachable').map((w) => w.patternId),
      ).size,
    },
  };
}
