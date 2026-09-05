// Bulk, offline authoring of DEMO seed candidates.
//
// The same relationship to server/demo-prompt.js that server/seed-generation.js
// has to server/prompt.js, and a deliberate sibling of that file rather than a
// mode flag inside it: the targeting logic is different in kind. Seed
// generation is COVERAGE-DRIVEN - it asks scripts/coverage.js which
// bucket/mode pairs are short and fills exactly those. Demo generation is
// VOLUME-DRIVEN - there is one mode, one weight tier, three age bands and a
// target of roughly a thousand cards, so what it needs is batching, theme
// rotation and de-duplication, none of which the coverage path has any use for.
//
// What is IDENTICAL, on purpose:
//   - the provider seam. `complete` from server/provider.js, so this runs on
//     Anthropic or Ollama according to LLM_PROVIDER and the admin's runtime
//     toggle. No backend is named anywhere in this file.
//   - the validators. shared/schema.js's validateBatch and shared/content.js's
//     checkCompliance, unchanged and unrelaxed. A demo card has to be a
//     structurally valid scenario and has to comply with the tier it was
//     generated under, exactly like anything else in this project.
//   - draft-only output. This module returns candidates; the CLI and the admin
//     route write them to demo-seed-scenarios.draft.json and stop. Nothing
//     here can write data/demo-seed-scenarios.json, and nothing should ever
//     be taught to. A person approves demo content, same as all of it.
//
// The one check that is NOT shared is the explicit-content screen below. That
// is an AUTHORING-side register policy for this pool, not a runtime content
// rule, so it lives here rather than in shared/content.js - which stays
// exactly as it was, per the invariant that content.js is the single source of
// truth for what a LIFE may contain.

import { complete, extractJson, hasKey } from './provider.js';
import { buildDemoSystemPrompt, buildDemoUserPrompt, DEMO_STAGES, DEMO_THEMES } from './demo-prompt.js';
import { validateBatch } from '../shared/schema.js';
import { checkCompliance } from '../shared/content.js';
import { britishSpellingWarnings } from '../shared/scenario-format.js';
import { NAME_TAG } from '../shared/names.js';
import { DEMO_GENERATED } from '../shared/provenance.js';

export { DEMO_STAGES };

/** Roughly a thousand cards, which is what the pool is specified at. */
export const DEFAULT_TOTAL = 1000;

// Cards per model call. Six is a compromise measured against the two things
// that fight here: a bigger batch is fewer calls for the same thousand cards,
// but every card in one call shares a context, and past about eight the model
// starts writing variations on its own third card. Minor cards are short, so
// six of them is a small response either way.
export const BATCH_SIZE = 6;

// How the total is split across the three age bands (server/demo-prompt.js's
// DEMO_STAGES). Weighted toward the front because that is roughly where a demo
// life spends its swipes: starting at 18 at BAL.DEMO.time's five months a
// swipe, a 32-swipe demo is ~10 cards in the 18-22 band, ~19 in 22-30 and ~3
// past 30, and the pool wants to be deepest where the draws are.
//
// The split is deliberately FLATTER than that 30/60/10 draw profile. Two
// reasons: the opening cards are the ones every demo shows and a first
// impression is worth over-provisioning, and a band that only supplies three
// draws still needs enough cards that two demos in a row do not repeat it.
export const STAGE_SHARE = { college: 0.40, early: 0.42, family: 0.18 };

/* --------------------------------------------------- the register screen */

// Explicit sexual content. A HARD DROP, not a warning.
//
// This exists because the demo register is deliberately suggestive, and the
// game's own runtime gates do not catch this case: shared/content.js's
// `sexual` pattern classifies its terms as MATURE content, which is legal in
// a mature-tier life, so a card that crossed the line would pass
// checkCompliance cleanly. The "no explicit sexual content in either mode"
// rule has always been prompt-side only; a pool written to sit right next to
// that line is the one place worth also checking the output.
//
// Blunt on purpose, and biased toward false positives - a dropped card costs
// one more batch, an approved one costs the rule. Anatomical vocabulary,
// explicit acts and arousal language. Innuendo passes, which is the point:
// "spot you rent" and "using your shower" are not on this list and are not
// meant to be.
const EXPLICIT = new RegExp(
  '\\b(?:' + [
    'sex', 'sexual', 'sexually', 'intercourse', 'foreplay', 'orgasm\\w*', 'climax(?:ed|ing)?',
    'aroused', 'arousal', 'horny', 'erection', 'erect', 'boner', 'hard[- ]on',
    'genital\\w*', 'penis', 'vagina', 'vulva', 'clitor\\w*', 'testicl\\w*', 'scrotum',
    'nipple\\w*', 'breasts?', 'buttocks', 'crotch', 'groin',
    'naked', 'nude', 'nudes', 'topless', 'undress\\w*', 'strip(?:ped|ping) (?:off|down|naked)',
    'masturbat\\w*', 'blowjob\\w*', 'handjob\\w*', 'cunnilingus', 'fellatio',
    'penetrat\\w*', 'thrust\\w*', 'moan\\w*', 'grind(?:ing)? (?:on|against)',
    'fuck\\w*', 'screw(?:ing|ed) (?:her|him|them)', 'bang(?:ing|ed) (?:her|him|them)',
    'went down on', 'hooked up with', 'hookup', 'hook[- ]up',
    'in bed with', 'sleep(?:ing|s)? with', 'slept with', 'lingerie', 'thong', 'condom\\w*',
  ].join('|') + ')\\b',
  'i',
);

// A card written for a cast that is not adult. The prompt says everyone is 18
// or over; this measures whether that held. Also a hard drop - a demo pool
// aimed at a mature-only, 18-and-up life has no legitimate use for any of it.
const UNDERAGE = /\b(?:high[- ]school|highschool|freshman year of high|sophomore year of high|junior year of high|senior year of high|homeroom|prom|middle school|eighth grade|ninth grade|tenth grade|eleventh grade|twelfth grade|underage|minors?|kids? from school|your little (?:brother|sister)|teenager|fifteen[- ]year[- ]old|sixteen[- ]year[- ]old|seventeen[- ]year[- ]old|1[0-7][- ]year[- ]old)\b/i;

// Slang the prompt bans by name because it is dated, dead, or the sound of an
// adult impersonating a young person. A WARNING, not a drop: one wrong word in
// an otherwise good card is a thing a reviewer can fix in the edit form, and
// the point of the warning is that they see it before approving.
const STALE_SLANG = /\b(?:yeet|on fleek|bae|sksksk|vibe check|totes|adulting|amirite|fam bam|squad goals|lit af|swag|yolo|hashtag|fellow kids)\b/i;

// A tagged PARENT. A hard drop, and the reason is invariant 8 rather than
// taste: "Mom and Dad stay Mom and Dad" - those are address forms, not names,
// and `assignName` would hand a tagged parent a name out of the pool, which
// is the one thing the naming design says never happens. The model reached
// for "{{new:parent}}" in the very first pilot batch, so this is a measured
// failure mode, not a hypothetical one.
const PARENT_TAG = /\{\{\s*new\s*:\s*(?:parent|parents|mom|mum|mother|dad|father|stepdad|stepmom|stepfather|stepmother)\b[^}]*\}\}/i;

// A role tag that says nothing. "{{new:person}}" resolves to a bare name with
// no role behind it, which reads as placeholder text on a live card and gives
// the name pool no age or gender hint to work from.
const EMPTY_ROLE_TAG = /\{\{\s*new\s*:\s*(?:person|someone|somebody|acquaintance|individual|stranger|guy|girl|man|woman|dude|they)\b[^}]*\}\}/i;

// A gendered pronoun or noun in a card that tags somebody. The engine picks
// the name AFTER the card is written (shared/deck.js resolves tags at deal
// time), so a card that says "he" can be dealt with a woman's name in it.
// A warning rather than a drop: it is one word, and the edit form is right
// there. Only fires on cards that actually carry a tag - a card about your
// own mother saying "she" is fine, because Mom is not tag-assigned.
const GENDERED = /\b(?:he|him|his|she|her|hers|himself|herself|boyfriend|girlfriend|boyfriends|girlfriends)\b/i;

// Choice labels bland enough that a deck full of them feels tiny. Warned so a
// reviewer can see the deck drifting toward five verdicts, not rejected -
// sometimes "Walk away" genuinely is the label.
const GENERIC_LABEL = /^(?:hard pass|pass|say no|no thanks|ignore(?: it)?|do it|walk away|say yes|decline|accept|agree|refuse|leave it|nope|yes|no)$/i;

// Everything a reviewer reads on a demo card.
const cardText = (s) => [
  s.prompt, s.leftLabel, s.rightLabel,
  (s.leftEffects && s.leftEffects.risk && s.leftEffects.risk.description) || '',
  (s.rightEffects && s.rightEffects.risk && s.rightEffects.risk.description) || '',
].filter(Boolean).join(' \n ');

/**
 * Register violations that DISQUALIFY a candidate outright.
 * @returns {string[]} empty when the card is fine
 */
export function registerViolations(scenario) {
  const text = cardText(scenario);
  // Tags live in the effects too (a relationship's `name`), so the tag checks
  // read the whole record rather than only what a player sees.
  const whole = text + ' ' + JSON.stringify(scenario.leftEffects || {}) + ' ' + JSON.stringify(scenario.rightEffects || {});
  const out = [];
  const explicit = text.match(EXPLICIT);
  if (explicit) out.push(`explicit sexual content ("${explicit[0]}") - the register is innuendo, never the scene itself`);
  const underage = text.match(UNDERAGE);
  if (underage) out.push(`cast is not clearly adult ("${underage[0]}") - every character in the demo pool is 18 or over`);
  const parent = whole.match(PARENT_TAG);
  if (parent) out.push(`tagged a parent ("${parent[0]}") - Mom and Dad are address forms the engine never renames`);
  const empty = whole.match(EMPTY_ROLE_TAG);
  if (empty) out.push(`role tag says nothing ("${empty[0]}") - the role IS the identity, so it has to be a real one`);
  return out;
}

// Word counts a minor demo card is asked for (server/demo-prompt.js says
// 15-30). Warned outside a widened band rather than rejected, the same
// posture shared/scenario-format.js's narrativeWarnings takes toward the
// major-tier field budgets: the prompt asks, this measures, nothing rejects.
export const DEMO_PROMPT_WORDS = [15, 30];
const WORD_TOLERANCE = 0.35;

const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

/**
 * Advisory craft/register observations, attached to the draft record as
 * `validationWarnings` so the admin's "Approve all without warnings" /
 * "Reject all with warnings" bulk actions can act on them. Never a rejection.
 *
 * The main seed pipeline only ever attaches warnings to MAJOR cards, since
 * that is the only tier with per-field budgets. Every demo card is minor, so
 * without this a demo draft could not carry a warning at all and both bulk
 * actions would be inert on the one queue built for their volume.
 */
export function demoWarnings(scenario) {
  const out = [];
  const words = wordCount(scenario.prompt);
  const [lo, hi] = DEMO_PROMPT_WORDS;
  if (words < Math.round(lo * (1 - WORD_TOLERANCE))) out.push(`prompt is ${words} words, thin for a demo card (target ${lo}-${hi})`);
  if (words > Math.round(hi * (1 + WORD_TOLERANCE))) out.push(`prompt is ${words} words, long for a swipe (target ${lo}-${hi})`);

  const text = cardText(scenario);
  const stale = text.match(STALE_SLANG);
  if (stale) out.push(`dated or invented slang ("${stale[0]}") - the voice brief bans it by name`);
  if (/#\w/.test(text)) out.push('hashtag in card text - the voice brief bans them');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) out.push('emoji in card text - the voice brief bans them');

  // Only meaningful on a card that tags somebody: the engine has not picked
  // that person's name yet, so the card cannot know their gender.
  if (/\{\{\s*new\s*:/.test(text)) {
    const gendered = text.match(GENDERED);
    if (gendered) out.push(`gendered word ("${gendered[0]}") beside a name tag - the engine picks that name after the card is written`);
  }

  for (const label of [scenario.leftLabel, scenario.rightLabel]) {
    if (GENERIC_LABEL.test(String(label || '').trim())) {
      out.push(`generic choice label ("${label}") - labels should come out of this card's own situation`);
    }
  }

  out.push(...britishSpellingWarnings(text));
  return out;
}

/* --------------------------------------------------------- id + shape ---- */

function uniqueId(scenario, stage, usedIds) {
  // Name tags out first, same reason server/seed-generation.js does it: a
  // prompt that opens "{{new:roommate}} has labeled the oat milk" would
  // otherwise produce an id made of the markup rather than the card.
  const promptText = String(scenario.prompt || 'card').replace(NAME_TAG, ' ').trim() || 'card';
  const base = ('demo_' + stage.id + '_' + promptText)
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .split('_').slice(0, 7).join('_').slice(0, 46) || ('demo_' + stage.id + '_card');
  let id = base;
  let n = 2;
  while (usedIds.has(id)) id = `${base}_${n++}`;
  return id;
}

/**
 * Turn one validated scenario into a demo-pool record.
 *
 * Same schema shape as a data/scenarios-seed.json entry - `deck.js` reads it
 * with the identical code path, so it has to be - plus the `demo-generated`
 * provenance tag that says which pool it belongs to.
 *
 * `modes` is computed exactly the way server/seed-generation.js computes it,
 * and this is worth understanding rather than overriding. The obvious thing
 * would be to stamp every demo card `["mature"]`, since the demo is
 * mature-only. That would be a bug: `shared/deck.js`'s eligibility treats a
 * card without "safe" as a DARK-ARC card, gated behind the 1-3 arc budget a
 * mature life rolls at birth (shared/content.js), so tagging the whole pool
 * mature-only would throttle a thousand cards down to three and drop the demo
 * onto the fallback templates by swipe five. Generated under the mature tier
 * and tagged by what the card actually contains is the correct answer: the
 * genuinely dark ones carry ["mature"] and spend the arc budget as they
 * should, and the merely cheeky ones carry both and flow freely. The demo is
 * mature-only because `demoMode` forces contentMode to "mature", not because
 * of a string in this field.
 */
export function shapeDemoRecord(scenario, { stage, sampledAge, usedIds }) {
  const record = {
    id: uniqueId(scenario, stage, usedIds),
    source: DEMO_GENERATED,
    stages: [stage.id],
    life_stage: [...stage.range],
    modes: checkCompliance(scenario, { tier: 'safe', age: sampledAge }).ok ? ['safe', 'mature'] : ['mature'],
    weight: 'minor',
    prompt: scenario.prompt,
    leftLabel: scenario.leftLabel,
    rightLabel: scenario.rightLabel,
    leftEffects: scenario.leftEffects || {},
    rightEffects: scenario.rightEffects || {},
  };

  const warnings = demoWarnings(scenario);
  if (warnings.length) record.validationWarnings = warnings;
  return record;
}

/* ------------------------------------------------------- de-duplication */

// Near-duplicate detection by content-word overlap, the same shape
// server/extraction.js's duplicateWarnings uses on library patterns. A
// thousand cards from one prompt WILL contain repeats; catching them at
// generation is far cheaper than a reviewer reading the same card nine times.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'you', 'your', 'yours', 'it', 'its', 'is', 'are',
  'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'that', 'this',
  'they', 'them', 'their', 'has', 'have', 'had', 'do', 'does', 'did', 'not', 'no', 'if',
  'as', 'by', 'from', 'up', 'out', 'about', 'into', 'over', 'after', 'just', 'now', 'one',
  'has', 'who', 'what', 'when', 'which', 'would', 'will', 'can', 'could', 'been', 'says',
]);

const contentWords = (text) => new Set(
  String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w)),
);

/** Jaccard overlap of two prompts, 0..1. */
export function promptSimilarity(a, b) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

// Above this, two prompts are the same card wearing a different noun. A hard
// drop at generation time, since a lexical near-copy has nothing a reviewer
// could want.
export const DUPLICATE_THRESHOLD = 0.45;

/* ------------------------------------------------- near-duplicate topics */

// Word overlap catches a card written twice. It does NOT catch a SITUATION
// written twice, and that is the repeat a thousand-card pool actually
// produces. Measured on a pilot run: "your college friend's wedding is five
// hours away, three nights at $210" and "your college friend's wedding is a
// destination event in Scottsdale, $1,100 all in" are plainly the same card,
// and they score 0.23 on word overlap - far below anything that could be a
// drop threshold without also throwing away genuinely different cards.
//
// So this is a second, cheaper-than-embeddings pass that runs over the whole
// accepted set at the end rather than per batch, and it WARNS instead of
// dropping. Two cards that share two or more words rare in the corpus are
// almost always the same situation; a reviewer glancing at the pair decides
// in a second, which is exactly the judgement call that should not be a
// regex's to make. It also feeds the "Reject all with warnings" bulk action,
// which is the right tool for a queue this size.

// A word appearing in more than this share of the pool is a common word here
// and says nothing about topic, however rare it is in English.
const TOPIC_DF_CEILING = 0.02;
// How many rare words two prompts must share to count as the same situation.
const TOPIC_SHARED_MIN = 2;
// The one place this string is written, so `remarkNearDuplicates` below and
// every reader that filters on it cannot drift from what the writer emits.
export const NEAR_DUPLICATE_PREFIX = 'same situation as ';

/**
 * Flag same-situation repeats across a finished set of demo records, in
 * place, by appending to each one's `validationWarnings`.
 *
 * Only ever marks the LATER card of a pair, so the first writing of a situation
 * stays clean and the reviewer is being asked about the copy.
 *
 * @param {object[]} records
 * @returns {number} how many records gained a near-duplicate warning
 */
export function markNearDuplicates(records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length < 2) return 0;

  const wordSets = list.map((r) => contentWords(r.prompt));
  const df = new Map();
  for (const set of wordSets) for (const w of set) df.set(w, (df.get(w) || 0) + 1);
  // Floor of 2, not 1: a word SHARED by two cards appears in two documents by
  // definition, so a ceiling of 1 makes every pair unreachable and the pass
  // silently marks nothing. It did exactly that on the first pilot - 0 of 30
  // marked against two pairs a reader can see from across the room.
  const ceiling = Math.max(2, Math.floor(list.length * TOPIC_DF_CEILING));

  // Invert to a rare-word index so this stays linear-ish in the corpus rather
  // than comparing all million pairs of a thousand-card pool.
  const byRareWord = new Map();
  wordSets.forEach((set, i) => {
    for (const w of set) {
      if ((df.get(w) || 0) > ceiling) continue;
      if (!byRareWord.has(w)) byRareWord.set(w, []);
      byRareWord.get(w).push(i);
    }
  });

  // "i:j" -> the rare words those two share. The WORDS, not just how many:
  // naming them is what makes the warning actionable. A pair matched on
  // "collections/agency/envelope" is a real repeat and a reviewer can see it
  // instantly; a pair matched on "tuesday/thursday" is two unrelated cards
  // that happen to name the same weekdays, and a reviewer can dismiss that
  // just as fast. A bare count of 2 reads identically in both cases and makes
  // them go and diff the cards by hand. Measured on the first 300-card run:
  // of the pairs flagged on exactly two shared words, roughly one in five was
  // this kind of coincidence.
  const sharedWords = new Map();
  for (const [word, indices] of byRareWord) {
    if (indices.length < 2 || indices.length > 12) continue; // a 12-way "rare" word is not rare
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const key = indices[a] + ':' + indices[b];
        if (!sharedWords.has(key)) sharedWords.set(key, []);
        sharedWords.get(key).push(word);
      }
    }
  }

  let marked = 0;
  const alreadyMarked = new Set();
  for (const [key, words] of sharedWords) {
    if (words.length < TOPIC_SHARED_MIN) continue;
    const [i, j] = key.split(':').map(Number);
    const later = Math.max(i, j);
    const earlier = Math.min(i, j);
    if (alreadyMarked.has(later)) continue;
    alreadyMarked.add(later);
    const record = list[later];
    if (!record.validationWarnings) record.validationWarnings = [];
    record.validationWarnings.push(
      `${NEAR_DUPLICATE_PREFIX}"${String(list[earlier].id)}" - shares ${words.slice(0, 6).sort().join(', ')} - read both before approving`,
    );
    marked += 1;
  }
  return marked;
}

/**
 * Re-run the near-duplicate pass over a WHOLE corpus - typically the existing
 * draft queue plus a run's new candidates, merged.
 *
 * This exists because a top-up run is the normal case, not the exception. The
 * pass inside `generateDemoDrafts` can only see the cards that run produced,
 * so a second run of 700 against an existing 300 would never notice that its
 * new collections-agency card is the same situation as one already sitting in
 * the queue. The LEXICAL de-duplication does cross that boundary (the caller
 * passes `existingPrompts`), but same-situation-different-words is exactly the
 * repeat word overlap cannot catch, which is the whole reason this pass
 * exists.
 *
 * Strips only the near-duplicate warnings before re-marking, so every other
 * warning a card carries survives untouched, and marks against the merged
 * corpus in order - which means the earliest writing of a situation stays
 * clean however many runs it takes to accumulate its copies.
 *
 * Cheap and side-effect-free apart from the records themselves: no model call,
 * no file access, no change to any card's content.
 *
 * @param {object[]} records the merged corpus, oldest first
 * @returns {number} how many records carry a near-duplicate warning afterwards
 */
export function remarkNearDuplicates(records) {
  for (const c of Array.isArray(records) ? records : []) {
    if (!c.validationWarnings) continue;
    c.validationWarnings = c.validationWarnings.filter((w) => !w.startsWith(NEAR_DUPLICATE_PREFIX));
    if (!c.validationWarnings.length) delete c.validationWarnings;
  }
  return markNearDuplicates(records);
}

/* ------------------------------------------------------------- core ---- */

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1));

/**
 * Generate demo candidates for one age band.
 *
 * @param {object}   opts
 * @param {object}   opts.stage       one of DEMO_STAGES
 * @param {number}   opts.target      how many accepted candidates to aim for
 * @param {Set}      [opts.existingIds]
 * @param {string[]} [opts.existingPrompts]  for cross-run de-duplication
 * @param {number}   [opts.themeOffset]      where in DEMO_THEMES to start
 * @param {Function} [opts.onBatch]
 * @param {Function} [opts.shouldStop]
 * @returns {Promise<{accepted: object[], stats: object}>}
 */
export async function generateForStage({
  stage, target, existingIds = new Set(), existingPrompts = [],
  themeOffset = 0, onBatch = null, shouldStop = () => false,
}) {
  if (!hasKey()) {
    const err = new Error('No LLM provider is configured, so there is nothing to generate with.');
    err.status = 503;
    throw err;
  }

  const accepted = [];
  const usedIds = new Set(existingIds);
  const prompts = [...existingPrompts];
  const stats = { batches: 0, returned: 0, invalid: 0, nonMinor: 0, register: 0, duplicate: 0, warned: 0, errors: 0 };
  const registerDrops = [];

  // Generous but finite: a run that keeps failing should stop rather than
  // burn a provider budget forever. Two-and-a-bit batches' worth of headroom
  // over the ideal call count.
  const maxBatches = Math.ceil(target / BATCH_SIZE) * 3 + 4;
  let themeCursor = themeOffset;

  while (accepted.length < target && stats.batches < maxBatches && stats.errors < 6 && !shouldStop()) {
    stats.batches += 1;
    const wanted = Math.min(BATCH_SIZE, target - accepted.length + 2);
    const themes = [];
    for (let i = 0; i < wanted; i++) {
      themes.push(DEMO_THEMES[themeCursor % DEMO_THEMES.length]);
      themeCursor += 1;
    }
    // A short, rotating sample of what this stage has already produced. The
    // whole list would be thousands of tokens by the end of a stage and would
    // crowd out the instructions that matter.
    const avoid = prompts.slice(-40).sort(() => Math.random() - 0.5).slice(0, 6);

    const system = buildDemoSystemPrompt(wanted);
    const user = buildDemoUserPrompt({ stage, count: wanted, themes, avoid });

    let text;
    try {
      ({ text } = await complete({
        system, user, prefill: '[', maxTokens: 3000, temperature: 1, timeoutMs: 120000,
      }));
    } catch (err) {
      stats.errors += 1;
      if (onBatch) onBatch({ batch: stats.batches, stage: stage.id, error: err.message });
      continue;
    }

    const sampledAge = randInt(stage.range[0], Math.max(stage.range[0], stage.range[1] - 1));
    const parsed = extractJson(text);
    // The real validators, unchanged: structural shape from shared/schema.js,
    // mode compliance from shared/content.js, screened at the tier and age a
    // demo card is actually dealt at.
    const { scenarios } = validateBatch(parsed, { minValid: 0, tier: 'mature', age: sampledAge });
    stats.returned += Array.isArray(parsed) ? parsed.length : 0;
    stats.invalid += Math.max(0, (Array.isArray(parsed) ? parsed.length : 0) - scenarios.length);

    let acceptedThisBatch = 0;
    for (const scenario of scenarios) {
      if (accepted.length >= target) break;

      // Minor tier is not negotiable for this pool: a standard or major card
      // would carry setting/beat/dialogue and break the demo's rhythm, which
      // is the one thing the whole feature rests on.
      if (scenario.weight !== 'minor' && scenario.weight !== 'trivial') {
        stats.nonMinor += 1;
        continue;
      }

      const violations = registerViolations(scenario);
      if (violations.length) {
        stats.register += 1;
        if (registerDrops.length < 20) registerDrops.push({ prompt: scenario.prompt, violations });
        continue;
      }

      if (prompts.some((p) => promptSimilarity(p, scenario.prompt) >= DUPLICATE_THRESHOLD)) {
        stats.duplicate += 1;
        continue;
      }

      const record = shapeDemoRecord(scenario, { stage, sampledAge, usedIds });
      usedIds.add(record.id);
      prompts.push(record.prompt);
      if (record.validationWarnings) stats.warned += 1;
      accepted.push(record);
      acceptedThisBatch += 1;
    }

    if (onBatch) {
      onBatch({
        batch: stats.batches, stage: stage.id, produced: acceptedThisBatch,
        total: accepted.length, target,
      });
    }
  }

  return { accepted, stats, registerDrops };
}

/**
 * Generate the whole demo pool: every age band, split by STAGE_SHARE.
 *
 * @returns {Promise<{stage: string, target: number, accepted: object[], stats: object}[]>}
 */
export async function generateDemoDrafts({
  total = DEFAULT_TOTAL, existingIds = new Set(), existingPrompts = [],
  onStage = null, onBatch = null, shouldStop = () => false,
}) {
  if (!hasKey()) {
    const err = new Error('No LLM provider is configured, so there is nothing to generate with.');
    err.status = 503;
    throw err;
  }

  const results = [];
  const allIds = new Set(existingIds);
  // Prompts accumulate ACROSS stages, so the de-duplication catches the same
  // card written twice at two different ages - which the model does, since a
  // broken washing machine is a broken washing machine at 21 and at 31.
  const allPrompts = [...existingPrompts];
  let themeOffset = 0;

  for (const stage of DEMO_STAGES) {
    if (shouldStop()) break;
    const target = Math.round(total * (STAGE_SHARE[stage.id] ?? 1 / DEMO_STAGES.length));
    if (onStage) onStage({ stage: stage.id, label: stage.label, target });

    const { accepted, stats, registerDrops } = await generateForStage({
      stage, target, existingIds: allIds, existingPrompts: allPrompts,
      themeOffset, onBatch, shouldStop,
    });

    for (const r of accepted) {
      allIds.add(r.id);
      allPrompts.push(r.prompt);
    }
    // Offset the theme rotation per stage so the second band does not open on
    // the same theme the first one did.
    themeOffset += 7;
    results.push({ stage: stage.id, target, accepted, stats, registerDrops });
  }

  // One pass over everything at the end, ACROSS stages: the same situation
  // written once at 21 and once at 31 is the repeat this catches, and neither
  // per-batch nor per-stage state can see it. Warns, never drops - see
  // markNearDuplicates.
  const all = results.flatMap((r) => r.accepted);
  const marked = markNearDuplicates(all);
  for (const r of results) {
    r.stats.warned = r.accepted.filter((c) => c.validationWarnings && c.validationWarnings.length).length;
    r.stats.nearDuplicate = r.accepted.filter(
      (c) => (c.validationWarnings || []).some((w) => w.startsWith('same situation as')),
    ).length;
  }
  if (onStage) onStage({ stage: 'all', label: 'near-duplicate pass', marked });

  return results;
}
