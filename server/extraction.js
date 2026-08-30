// Turning source text into candidate library patterns.
//
// This is the extraction CORE, and it lives here rather than in the CLI because
// two callers need exactly the same behaviour: scripts/extract-patterns.js for
// batch runs over many files, and the admin module's paste box. The prompt is
// the product here - if it drifts between the two, drafts stop being
// comparable, so there is one copy of it and both callers import it.
//
// What this module does NOT do, ever: write to server/situation-library.json.
// Extraction produces DRAFTS. A person decides what enters the library.

import { complete, extractJson, MODEL } from './provider.js';

export const CATEGORIES = new Set(['career', 'romance', 'family', 'money', 'health', 'chaos']);
export const RARITIES = new Set(['common', 'uncommon', 'rare']);

// How much source text the model sees. Beyond this it stops being an extraction
// and starts being a summary of a summary.
export const MAX_SOURCE_CHARS = 60000;

export const SYSTEM = `You extract reusable LIFE-EVENT PATTERNS from source text for a
life-simulation game's situation library.

A pattern is a SHAPE, not a story. "A promising early career under a charismatic
senior figure who normalises excess" is a shape. "Worked at a particular firm for
a man with a particular name" is not - that is a fact about one person.

RULES, all of them load-bearing:
1. ANONYMIZE COMPLETELY. No names of people, companies, funds, products, places
   or publications. No dates, no years, no figures that only make sense for one
   person. If a detail identifies the source, it is wrong.
2. GENERALIZE UNTIL IT IS COMMON. Each pattern must plausibly describe thousands
   of different lives across different decades and industries. If it could only
   happen to one person, keep abstracting or discard it.
3. SHAPES, NOT PLOTS. Capture the structure of the decision and its consequence,
   not the sequence of events.
4. NO METHOD. Never describe how to commit a crime, obtain drugs or evade
   detection. Depict decisions and their costs.
5. Discard anything you cannot anonymize. Fewer good patterns beats more weak ones.
6. Write in American English spelling and conventions throughout (e.g. "enroll"
   not "enrol", "color" not "colour", "realize" not "realise", "traveling" not
   "travelling") - regardless of the source text's own spelling conventions.

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

export function buildUserPrompt(source) {
  return `Extract patterns from the following source text.

Remember: a reader of your output must not be able to tell whose life it came from.

--- SOURCE ---
${source}
--- END SOURCE ---

Return the JSON array.`;
}

/** Schema problems with one candidate. Returns [] when it is well formed. */
export function validatePattern(p, i = 0) {
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

export function identityWarnings(p) {
  const fields = [p.pattern, p.typical_effects, p.note || ''];
  // Ignore sentence-initial capitals - they are grammar, not identity. Only a
  // capitalised word sitting mid-sentence is a candidate proper noun. Each
  // field starts a sentence of its own ("Creates a branch point..."), so the
  // decapitalising pass runs per field, BEFORE joining - joined, a field's
  // opening word sits "mid-sentence" whenever the previous field ends without
  // punctuation, which is how "Creates" got flagged as a name.
  const midSentence = fields
    .map((f) => String(f).replace(/(^|[.!?;:][ \t]+)[A-Z]/g, (m) => m.toLowerCase()))
    .join(' ');
  const text = fields.join(' ');
  const names = [...new Set((midSentence.match(/[A-Z][a-z]{2,}/g) || []).filter((w) => !STOPWORDS.has(w)))];
  const years = [...new Set(text.match(/(18|19|20)[0-9][0-9]/g) || [])];
  const out = [];
  if (names.length) out.push('possible proper nouns: ' + names.join(', '));
  if (years.length) out.push('years: ' + years.join(', '));
  return out;
}

/**
 * Run one extraction.
 *
 * Returns the candidates plus everything a caller needs to report on them, and
 * throws only if the model gave back something that is not a JSON array - in
 * which case `raw` is attached to the error so the caller can save it.
 *
 * @param {string} source  raw source text
 * @returns {{ patterns: Array, problems: string[], raw: string, model: string, ms: number }}
 */
export async function extractPatterns(source, { maxTokens = 6000, temperature = 0.7 } = {}) {
  const text = String(source || '').slice(0, MAX_SOURCE_CHARS);
  if (!text.trim()) throw new Error('source text is empty');

  const t0 = Date.now();
  const { text: reply } = await complete({
    system: SYSTEM,
    user: buildUserPrompt(text),
    // Every array-expecting caller passes this, and on Ollama it is load-bearing,
    // not a nudge: the prefill is what tells formatFor to grammar-constrain the
    // output to an array instead of an object the array check below would reject.
    prefill: '[',
    maxTokens,
    temperature,
    // A 15-pattern extraction is a long generation; the 30s default is not enough.
    timeoutMs: 180000,
  });

  const parsed = extractJson(reply);
  if (!Array.isArray(parsed)) {
    const err = new Error('model did not return a JSON array');
    err.raw = reply;
    throw err;
  }

  return {
    patterns: parsed,
    problems: parsed.flatMap((p, i) => validatePattern(p, i)),
    raw: reply,
    model: MODEL,
    ms: Date.now() - t0,
  };
}

/** Candidate ids that already exist in the live library. */
export const idCollisions = (patterns, library) => {
  const existing = new Set((library || []).map((p) => p.id));
  return patterns.filter((p) => existing.has(p.id)).map((p) => p.id);
};

const DUP_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or',
  'with', 'who', 'their', 'that', 'this', 'into', 'from', 'they', 'them', 'has', 'have', 'had',
  'is', 'are', 'was', 'were', 'it', 'its', 'but', 'by', 'as', 'over', 'after', 'before', 'when']);

export const tokenize = (text) => new Set(
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !DUP_STOPWORDS.has(w)),
);

export const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
};

// Two patterns describing the same shape in different words is the failure
// mode id matching can't catch - the model rephrases instead of repeating
// itself verbatim. Word-overlap is crude but the patterns are one anonymised
// sentence each, so it doesn't need to be smarter than that.
export const DUPLICATE_THRESHOLD = 0.6;

/**
 * The scoring itself, over whatever text a caller says identifies a record.
 *
 * Patterns compare their one anonymised sentence; a harvested seed card
 * compares its whole rendered narrative (server/harvest.js). Same measurement,
 * same threshold, different accessor - which is the only reason this is
 * parametrised rather than written twice. Candidates are compared against
 * `existing` AND against earlier candidates in the same batch, because a run
 * that produces the same shape twice is the commonest way a near-repeat gets
 * in.
 *
 * @param {Array} candidates
 * @param {Array} existing
 * @param {(record: object) => string} textOf   the text that identifies a record
 * @param {number} [threshold]
 * @returns {{ id: string, duplicateOf: string, score: number }[]}
 */
export function duplicatesBy(candidates, existing, textOf, threshold = DUPLICATE_THRESHOLD) {
  const pool = (existing || []).map((p) => ({ id: p.id, tokens: tokenize(textOf(p)) }));
  const out = [];
  for (const p of candidates || []) {
    const tokens = tokenize(textOf(p));
    let best = null;
    for (const c of pool) {
      const score = jaccard(tokens, c.tokens);
      if (score >= threshold && (!best || score > best.score)) best = { id: c.id, score };
    }
    if (best) out.push({ id: p.id, duplicateOf: best.id, score: Math.round(best.score * 100) / 100 });
    pool.push({ id: p.id, tokens });
  }
  return out;
}

/**
 * Flags candidates whose `pattern` text closely overlaps an existing pattern
 * (library or draft queue, whatever the caller passes as `existing`) or an
 * earlier candidate in the same batch. Advisory only, same as
 * `identityWarnings` - extraction never blocks or merges, a person reads
 * every flag and decides.
 *
 * @returns {{ id: string, duplicateOf: string, score: number }[]}
 */
export const duplicateWarnings = (patterns, existing) =>
  duplicatesBy(patterns, existing, (p) => p.pattern);
