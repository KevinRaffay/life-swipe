// Mining the LLM request log for content worth keeping.
//
// Live generation throws away everything it writes. A card is dealt once, the
// player swipes, and the only trace left is a line in
// server/logs/llm-requests.jsonl. Some of those cards are better than what is
// in the seed deck. This module finds them and routes them into the two draft
// queues that already exist, so a person can approve them into permanent
// content.
//
// THREE RULES, all load-bearing:
//
//   1. SERVER-KEY ONLY. A generation paid for by a player's own key (BYOK) is
//      their content, not the project's, and is never harvested. There is no
//      BYOK path in the codebase today, which is exactly why this is written
//      down now rather than later: `keySource` on a log entry must say
//      "server" explicitly. Null - every entry written before the field
//      existed, and any future path that forgets to declare itself - is
//      INELIGIBLE, not assumed. See server/llm.js.
//   2. NEVER MERGE. Both paths append to a draft file and stop, exactly like
//      server/extraction.js and server/seed-generation.js. Entering the live
//      library or the seed deck is always a person pressing Approve.
//   3. NOBODY'S NAME TRAVELS. A live card is written for one player, against
//      one cast, and the engine has already resolved "{{new:roommate}}" into a
//      real name by the time it is dealt. A harvested card must carry the tag
//      again, not the name - otherwise every future life meets the same Rowan.
//      `depersonalise` is the reverse of shared/names.js's resolution step.
//   4. GAMEPLAY CALLS ONLY. `entryEligibility` also checks `triggeredBy`
//      against the two values a real scenario-generation call can carry. Other
//      callLLM callers exist for content that isn't a scenario at all - the
//      intro flow's one-off establishing beat ("intro_generation") is a fixed
//      non-interactive line with no decision, not something a life repeats -
//      and are excluded by that check rather than by relying on nothing else
//      ever logging through the same wrapper.
//
// ON DEMAND ONLY. There is no scheduled job here and there should not be one:
// harvesting decides what the game's permanent content becomes, and a person
// initiates every run.
//
// What this module does NOT do: touch generation, the engine, effect
// resolution or the referee. It reads a log file and writes two draft files.

import { extractJson } from './provider.js';
import { queryEntries } from './log-store.js';
import { shapeSeedRecord } from './seed-generation.js';
import {
  extractPatterns, identityWarnings, idCollisions, duplicatesBy,
  validatePattern, DUPLICATE_THRESHOLD, MAX_SOURCE_CHARS,
} from './extraction.js';
import { validateScenario } from '../shared/schema.js';
import { displayText } from '../shared/scenario-format.js';
import { NAME_TAG, roleGroup } from '../shared/names.js';
import { HARVESTED } from '../shared/provenance.js';
import { BUCKETS } from '../scripts/coverage.js';

export const HARVEST_DEFAULTS = {
  // How many log entries one run reads, newest first. A run is bounded on
  // purpose: harvesting the whole log every time would re-propose the same
  // rejected candidates forever.
  limit: 200,
  // Craft-drift warnings tolerated on a single candidate card. Zero means
  // "clean": inside every major-tier word budget and carrying a concrete
  // number, which is what narrativeWarnings measures. Raise it to harvest
  // cards that are good but slightly out of budget.
  maxCraftWarnings: 0,
  // Word-overlap score above which a candidate is treated as a near-repeat of
  // something already in the deck or the batch. Same measurement and default
  // as extraction's duplicate check.
  duplicateThreshold: DUPLICATE_THRESHOLD,
  // Below this many eligible major cards, the library path does not run: the
  // extraction prompt is asked for 8-15 patterns, and squeezing that out of
  // one or two scenarios produces invention, not generalisation.
  minMajorForLibrary: 3,
  // A ceiling on one run's seed output, so a long log cannot dump hundreds of
  // rows into a queue a person then has to read.
  maxSeedCandidates: 40,
};

/* ------------------------------------------------------ prompt archaeology */

// The log records the assembled prompt text, not the state object it was built
// from - so the state has to be read back out of it. This is coupled to
// server/prompt.js's buildUserPrompt by shape, and deliberately forgiving: a
// prompt line that has moved on since an entry was written yields nothing
// rather than throwing, and a candidate whose cast could not be read is
// rejected rather than harvested half-anonymised (see `harvestSeeds`).

const AGE_RE = /^\s*age (\d+)\s*$/m;
const STAGE_RE = /^CURRENT LIFE STAGE: .*\(([a-z]+)\)\s*$/m;
const TIER_RE = /^\s*tier: (safe|mature)/m;
const PEOPLE_RE = /^\s*people: (.*)$/m;
const CHILDREN_RE = /^\s*children: (.*)$/m;
const FLAGS_RE = /^FULL FLAG LIST \(mine these for callbacks\):\n\s*(.*)$/m;
const SPENT_RE = /Tags already spent in this life: (.*?) - reuse the tag/s;

// "Rowan (best friend, closeness 80, flags: a/b)[OFF-SCREEN lately - ...]"
const PERSON_RE = /^(.*?)\s+\((.*?),\s+closeness\s+(-?\d+)(?:,\s+flags:\s+([^)]*))?\)/;
// "{{new:roommate}} = Priya"
const SPENT_PAIR_RE = /\{\{\s*new\s*:\s*([^}]+?)\s*\}\}\s*=\s*(.+)/;
// "Child 1, age 4"
const KID_RE = /^(.*?),\s+age\s+(\d+)\s*$/;

// How you address a parent, not a name. The naming invariant (CLAUDE.md #8)
// treats these as pure address forms, so they survive harvesting untouched -
// every life has a Mom and a Dad.
const ADDRESS_TERMS = new Set(['mom', 'mum', 'dad', 'mother', 'father']);

const firstNameOf = (full) => String(full || '').trim().split(/\s+/)[0];

/**
 * Read back what the storyteller was told, from the prompt text the log kept.
 *
 * @param {string} assembledPrompt
 * @returns {{ age: number|null, stage: string|null, tier: string|null,
 *             people: {name,role,flags}[], kids: {name,age}[],
 *             spentTags: {tag,name}[], flags: string[], parsed: boolean }}
 */
export function parseGenerationContext(assembledPrompt) {
  const text = String(assembledPrompt || '');
  const ageMatch = text.match(AGE_RE);
  const stageMatch = text.match(STAGE_RE);
  const tierMatch = text.match(TIER_RE);

  const people = [];
  const peopleLine = (text.match(PEOPLE_RE) || [])[1] || '';
  if (peopleLine && !peopleLine.startsWith('(nobody')) {
    for (const chunk of peopleLine.split('; ')) {
      const m = chunk.match(PERSON_RE);
      if (!m) continue;
      people.push({
        name: m[1].trim(),
        role: m[2].trim(),
        flags: m[4] ? m[4].split('/').map((f) => f.trim()).filter(Boolean) : [],
      });
    }
  }

  const kids = [];
  const kidLine = (text.match(CHILDREN_RE) || [])[1] || '';
  if (kidLine && kidLine.trim() !== 'none') {
    for (const chunk of kidLine.split('; ')) {
      const m = chunk.match(KID_RE);
      if (m) kids.push({ name: m[1].trim(), age: Number(m[2]) });
    }
  }

  const spentTags = [];
  const spentLine = (text.match(SPENT_RE) || [])[1] || '';
  for (const chunk of spentLine.split('; ')) {
    const m = chunk.match(SPENT_PAIR_RE);
    if (m) spentTags.push({ tag: m[1].trim(), name: m[2].trim() });
  }

  const flagLine = (text.match(FLAGS_RE) || [])[1] || '';
  const flags = flagLine && !flagLine.startsWith('(none')
    ? flagLine.split(',').map((f) => f.trim()).filter(Boolean)
    : [];

  return {
    age: ageMatch ? Number(ageMatch[1]) : null,
    stage: stageMatch ? stageMatch[1] : null,
    tier: tierMatch ? tierMatch[1] : null,
    people,
    kids,
    spentTags,
    flags,
    // Whether this looks like a storyteller prompt at all. A false here means
    // the entry is skipped: an unparsed cast cannot be de-personalised, and a
    // card that keeps somebody's name is the one outcome this must never have.
    parsed: Boolean(ageMatch && stageMatch && text.includes('STATE (owned by the engine')),
  };
}

/* ------------------------------------------------------- de-personalising */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The opening of a name tag. Named because "does this contain {{" reads as a
// syntax question and is actually an identity one.
const TAG_OPEN = '{{';

// The role phrase to write into a tag. "unspecified role" is what the prompt
// prints when a relationship has none; it is not something to hand to the name
// resolver, which reads the role for age and gender plausibility.
const tagRole = (role) => {
  const cleaned = String(role || '').toLowerCase().trim().replace(/[\s_]+/g, ' ');
  return (!cleaned || cleaned === 'unspecified role') ? 'acquaintance' : cleaned;
};

/**
 * Every "this name means this tag" pair for one life, longest name first so a
 * two-word name is replaced before either of its halves.
 *
 * Two sources, and the order matters. A tag the life has already spent is
 * authoritative - the prompt printed the exact mapping, so "Priya" goes back
 * to precisely "{{new:roommate}}" and resolves to one person again. Everyone
 * else in the cast (the starting best friend, anyone the seed deck named) is
 * reconstructed from their role, numbered when a life holds two of the same.
 */
export function nameTagMap({ people = [], kids = [], spentTags = [] } = {}) {
  const entries = [];
  const claimed = new Set();
  const usedRoles = new Map();

  const nextTag = (role) => {
    const n = (usedRoles.get(role) || 0) + 1;
    usedRoles.set(role, n);
    return n === 1 ? role : `${role}#${n}`;
  };

  for (const { tag, name } of spentTags) {
    const first = firstNameOf(name);
    if (!first || claimed.has(first.toLowerCase())) continue;
    claimed.add(first.toLowerCase());
    // Reserve the role so a reconstructed tag below cannot collide with it.
    usedRoles.set(tagRole(tag.split('#')[0]), 1);
    entries.push({ name: first, tag: `{{new:${tag}}}`, role: tagRole(tag.split('#')[0]) });
  }

  for (const person of people) {
    const first = firstNameOf(person.name);
    if (!first || ADDRESS_TERMS.has(first.toLowerCase())) continue;
    if (claimed.has(first.toLowerCase())) continue;
    claimed.add(first.toLowerCase());
    const role = tagRole(person.role);
    entries.push({ name: first, tag: `{{new:${nextTag(role)}}}`, role });
  }

  // Kids are never pool-named - the engine calls them "Child 1", "Child 2"
  // (shared/engine.js) - so there is no personal name here to strip. The
  // substitution exists so a harvested card does not literally read "Child 1",
  // and so the card can be gated on the flag that says a child exists.
  let kidIndex = 0;
  for (const kid of kids) {
    const name = String(kid.name || '').trim();
    if (!name || claimed.has(name.toLowerCase())) continue;
    claimed.add(name.toLowerCase());
    kidIndex += 1;
    entries.push({
      name,
      tag: kidIndex === 1 ? '{{new:child}}' : `{{new:child#${kidIndex}}}`,
      role: 'child',
      isKid: true,
    });
  }

  return entries.sort((a, b) => b.name.length - a.name.length);
}

const TEXT_FIELDS = ['setting', 'beat', 'dialogue', 'prompt'];

/**
 * Put the tags back. The reverse of shared/names.js's `resolveCardNames`.
 *
 * Word-boundary matching, so "Rowan's" becomes "{{new:best friend}}'s" and
 * reads correctly once the next life's engine resolves it. Runs over the same
 * fields the resolver ran over - the four narrative fields plus a
 * relationship's name inside either effects object - and re-derives the joined
 * `scenario` string afterwards, because invariant 5 says that field is derived
 * and roughly fifteen call sites (including the mature-content backstop) read
 * it.
 *
 * @returns {{ card, used: object[], residual: string[] }} `residual` is any
 *   cast first name still present afterwards - a card with one is rejected
 *   rather than shipped, because it means the substitution did not hold.
 */
export function depersonalise(scenario, tagMap) {
  const card = { ...scenario };
  const used = [];

  // Two substitutions, because the two places a name can sit want different
  // things. A narrative field gets the TAG, which shared/names.js swaps for a
  // fresh name at deal time. A choice label gets the ROLE IN PLAIN WORDS:
  // "Ask Nadia" becomes "Ask your spouse", not "Ask {{new:spouse}}".
  //
  // That started as a workaround - resolveCardNames did not walk the labels at
  // all, so a tag written into one reached the player as literal braces. It
  // does walk them now (shared/names.js's NAMED_FIELDS). The plain role stays
  // anyway: a label can name somebody the prose never mentions, and a tag
  // there would spend a whole named character on a button that only needs to
  // say which kind of person it means.
  const replaceEach = (text, render) => {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const entry of tagMap) {
      const next = out.replace(new RegExp('\\b' + escapeRe(entry.name) + '\\b', 'g'), render(entry));
      if (next === out) continue;
      out = next;
      if (!used.includes(entry)) used.push(entry);
    }
    return out;
  };
  const swap = (text) => replaceEach(text, (e) => e.tag);
  const swapPlain = (text) => replaceEach(text, (e) => `your ${e.role}`);

  for (const field of TEXT_FIELDS) {
    if (typeof card[field] === 'string') card[field] = swap(card[field]);
  }
  for (const field of ['leftLabel', 'rightLabel']) {
    if (typeof card[field] !== 'string') continue;
    // Same 40-character cap the validator applies, in case a one-word name
    // became a three-word role phrase.
    card[field] = swapPlain(card[field]).slice(0, 40);
  }
  for (const side of ['leftEffects', 'rightEffects']) {
    const eff = card[side];
    if (!eff || !eff.relationship || typeof eff.relationship.name !== 'string') continue;
    const name = swap(eff.relationship.name);
    if (name !== eff.relationship.name) {
      card[side] = { ...eff, relationship: { ...eff.relationship, name } };
    }
  }
  card.scenario = displayText(card).slice(0, 700);

  // Over everything a reader sees, labels included: a name left in a label
  // is exactly as wrong as one left in the prompt, and harder to notice.
  const after = cardText(card);
  const residual = tagMap
    .filter((e) => !e.isKid && new RegExp('\\b' + escapeRe(e.name) + '\\b').test(after))
    .map((e) => e.name);

  return { card, used, residual };
}

/** Everything a reader would see, including the labels and a relationship name. */
export function cardText(card) {
  const rel = ['leftEffects', 'rightEffects']
    .map((side) => (card[side] && card[side].relationship && card[side].relationship.name) || '')
    .join(' ');
  return [card.setting, card.beat, card.dialogue, card.prompt, card.leftLabel, card.rightLabel, rel]
    .filter(Boolean)
    .join(' ');
}

/** The same card with its tags rendered as plain prose, for reading by a model. */
export function untagged(card) {
  const plain = (text) => String(text || '').replace(NAME_TAG, (_m, _kind, body) => {
    const role = tagRole(String(body).split('#')[0]);
    return `your ${role}`;
  });
  return TEXT_FIELDS
    .map((field) => plain(card[field]))
    .filter(Boolean)
    .join(' ');
}

/* ------------------------------------------------------- generalisability */

// Flags the ENGINE reacts to, or that the prompt names as canonical
// (server/prompt.js's CANONICAL FLAGS and CAREER BACKGROUND FLAGS, plus
// `has_kids`, which shared/engine.js sets when a child arrives). These are
// ordinary life facts thousands of lives share. Everything else in a life's
// flag list is what the prompt calls "pure story memory" - invented, specific,
// and the thing a seed card must not lean on.
export const ENGINE_FLAGS = new Set([
  'in_school', 'student_debt', 'married', 'retired', 'lives_with_parents',
  'smoker', 'heavy_drinker', 'chronic_illness', 'has_kids', 'spouse_unemployed',
  'college_degree', 'trade_cert', 'white_collar_experience',
]);

// Flags a harvested card may be GATED on rather than rejected for. Both are
// maintained by the engine, so `requiresFlags` on them actually means
// something at deal time: a card that presupposes a spouse is dealt only to a
// life that has one.
const GATE_FOR_ROLE_GROUP = { spouse: 'married', child: 'has_kids' };

const FLAG_WORD_MIN = 4;
const LONE_FLAG_WORD_MIN = 7;

// Flag words that carry no signal on their own. Without this,
// "has_part_time_job" reduces to "part" + "time" and matches roughly any
// card that mentions either - firing the callback check on content that is
// perfectly generalisable. Found by running the check over the real log and
// reading what it caught, not by reasoning about it.
const FLAG_WORD_STOPWORDS = new Set([
  'have', 'has', 'had', 'part', 'time', 'times', 'job', 'jobs', 'work', 'life',
  'year', 'years', 'first', 'last', 'next', 'more', 'less', 'good', 'bad',
  'high', 'home', 'some', 'made', 'make', 'take', 'took', 'done', 'been',
  'very', 'from', 'with', 'that', 'this', 'they', 'into', 'over', 'your',
  'their', 'about', 'after', 'before', 'other', 'thing', 'things', 'stuff',
]);

/**
 * Does this card lean on a flag that only this life has?
 *
 * A proxy, not a rule - the same kind of judgement a library pattern's
 * requires/excludes encodes. The storyteller is asked for a callback roughly
 * one card in four ("the spouse flagged heavy_drinker at 24 becomes an
 * intervention at 38"), and a callback is precisely the card that stops making
 * sense to a player who did not live that. So: split each story-memory flag
 * into its words and look for all of them. Two-word flags need both
 * ("invested_startup" needs "invested" and "startup", so neither word alone
 * fires); a single-word flag has to be long enough to be distinctive on its
 * own.
 *
 * Run against the ORIGINAL text, before de-personalisation, so a flag named
 * after somebody - "priya_friction" - still matches the card that mentions
 * them.
 */
export function narrativeFlagCallbacks(text, flags = []) {
  const hay = String(text || '');
  const hits = [];
  for (const flag of flags) {
    if (ENGINE_FLAGS.has(flag)) continue;
    const words = flag.split('_')
      .filter((w) => w.length >= FLAG_WORD_MIN && !FLAG_WORD_STOPWORDS.has(w));
    const needed = words.length > 1 ? words : words.filter((w) => w.length >= LONE_FLAG_WORD_MIN);
    if (!needed.length) continue;
    if (needed.every((w) => new RegExp('\\b' + escapeRe(w), 'i').test(hay))) hits.push(flag);
  }
  return hits;
}

// An explicit back-reference to a choice this player already made. Kept
// narrow on purpose: a first draft that also caught bare "again" and "still"
// rejected "the section still has seats" and "the polo is still green",
// which are ordinary prose, not callbacks. The flag check above is the
// strong signal; this one only fires on a sentence that cannot mean
// anything else. Both lists were tuned by running them over the real log
// and reading what they caught.
// String.raw on every piece: a plain quoted string would hand RegExp a
// backspace where a word boundary was meant, and the check would then
// silently never fire.
const PRIOR_DECISION_PHRASES = [
  String.raw`you (?:already |previously )?(?:said no|said yes|passed on|agreed to|promised|chose to|decided to)`,
  String.raw`you (?:already |previously )?turned (?:it|them|that) down`,
  String.raw`since (?:then|last time)`,
  String.raw`(?:the )?last time you`,
  String.raw`as you promised`,
  String.raw`back when you`,
  String.raw`you did (?:this|that) (?:before|last)`,
];
const PRIOR_DECISION = new RegExp(
  String.raw`\b(?:` + PRIOR_DECISION_PHRASES.join('|') + String.raw`)\b`,
  'i',
);

/**
 * Why this card should not become a seed, or [] when it may.
 *
 * @param {object} card        the de-personalised card
 * @param {string} originalText the resolved text, before de-personalisation
 * @param {object} context     from parseGenerationContext
 * @param {string[]} residual  cast names the substitution failed to remove
 */
export function seedRejectionReasons(card, originalText, context, residual = []) {
  const reasons = [];
  if (residual.length) {
    reasons.push(`still names ${residual.join(', ')} after de-personalising`);
  }
  const callbacks = narrativeFlagCallbacks(originalText, context.flags);
  if (callbacks.length) {
    reasons.push(`callback to this life's own history (${callbacks.join(', ')})`);
  }
  if (PRIOR_DECISION.test(cardText(card))) {
    reasons.push('reads as a continuation of a decision this player already made');
  }
  return reasons;
}

/** Engine flags a card must be gated on, derived from whose tags it carries. */
export function gateFlagsFor(usedTags) {
  const gates = new Set();
  for (const entry of usedTags) {
    const gate = GATE_FOR_ROLE_GROUP[roleGroup(entry.role)];
    if (gate) gates.add(gate);
  }
  return [...gates];
}

/* ------------------------------------------------------ hardcoded names */

// The two address forms scripts/name-check.js exempts, spelled its way. Kept
// separate from ADDRESS_TERMS above, which is the looser set used for reading
// a cast list out of a prompt: this one has to match the gate exactly, or the
// warning stops predicting what that gate will do.
const NAME_CHECK_EXEMPT = new Set(['Mom', 'Dad']);

/**
 * A relationship effect naming somebody literally instead of by tag.
 *
 * This is the ONE identity problem a harvested seed card can still have, and
 * it is worth flagging because it is not cosmetic: `npm run names` fails the
 * build on exactly this condition, and it only looks at the seed deck - so a
 * card that carries it sails through review and breaks the check AFTER
 * approval, which is the worst place to find out.
 *
 * De-personalisation removes every name it can see, so this fires only when
 * the model invented somebody the prompt never listed. Rare by design (the
 * storyteller prompt forbids inventing names, and validateBatch drops cards
 * that rename a known person), which is why it is a warning rather than a
 * rejection: a person reads it and decides.
 */
export function hardcodedNameWarnings(card) {
  const out = [];
  for (const side of ['leftEffects', 'rightEffects']) {
    const rel = card[side] && card[side].relationship;
    if (!rel || typeof rel.name !== 'string' || !rel.name.trim()) continue;
    if (rel.name.includes(TAG_OPEN) || NAME_CHECK_EXEMPT.has(rel.name)) continue;
    out.push(`${side} names "${rel.name}" outright rather than with a tag - npm run names fails on this once the card is approved`);
  }
  return out;
}

/* ---------------------------------------------------------- eligibility */

const WARNING_INDEX_RE = /^scenario\[(\d+)\]:\s*/;

/**
 * Split a call's batch-level `validationWarnings` back onto the cards they
 * came from. validateBatch prefixes each one with its raw-array index, which
 * is what makes per-card craft filtering possible at all: one card over its
 * word budget does not disqualify the other four.
 */
export function warningsByIndex(validationWarnings) {
  const byIndex = new Map();
  for (const raw of validationWarnings || []) {
    const m = String(raw).match(WARNING_INDEX_RE);
    if (!m) continue;
    const i = Number(m[1]);
    if (!byIndex.has(i)) byIndex.set(i, []);
    byIndex.get(i).push(String(raw).replace(WARNING_INDEX_RE, ''));
  }
  return byIndex;
}

// The only two triggeredBy values a gameplay scenario-generation call can
// carry (server/index.js's /api/scenarios). Anything else - including
// "intro_generation", the one-off establishing-scene call the intro flow
// makes through the same callLLM wrapper (server/prompt.js's
// buildIntroPrompt) - is not a scenario a life could ever repeat, and is
// excluded here rather than by accident.
const HARVESTABLE_TRIGGERS = new Set(['batch_generation', 'validator_retry']);

/**
 * Is this whole log entry a harvest candidate?
 *
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function entryEligibility(entry) {
  // Rule 1. Note the shape of this test: it demands the string, it does not
  // accept the absence of one.
  if (entry.keySource !== 'server') {
    return { ok: false, reason: entry.keySource ? `key source ${entry.keySource}` : 'no key source recorded' };
  }
  if (entry.validationResult !== 'passed') {
    return { ok: false, reason: `outcome ${entry.validationResult || 'unknown'}` };
  }
  if (!HARVESTABLE_TRIGGERS.has(entry.triggeredBy)) {
    return { ok: false, reason: `triggered by ${entry.triggeredBy || 'unknown'}` };
  }
  if (!entry.rawResponse) return { ok: false, reason: 'no response text' };
  return { ok: true, reason: null };
}

const bucketForAge = (age) =>
  BUCKETS.find((b) => age >= b.range[0] && age < b.range[1]) || BUCKETS[BUCKETS.length - 1];

/* -------------------------------------------------------------- the scan */

// How many worked examples one rejection reason keeps. Enough to see what
// kind of card is being dropped, few enough that the answer stays readable.
const MAX_REJECTION_EXAMPLES = 3;

/**
 * Turn eligible log entries into de-personalised, per-card candidates. Shared
 * by both harvest paths, because both need exactly the same thing first: the
 * cards this batch actually shipped, with nobody's name on them.
 *
 * @returns {{ candidates: object[], stats: object,
 *             rejections: {reason: string, count: number, examples: string[]}[] }}
 */
export function scanEntries(entries, { maxCraftWarnings = HARVEST_DEFAULTS.maxCraftWarnings } = {}) {
  const candidates = [];
  const rejections = new Map();
  const stats = {
    entriesScanned: entries.length, entriesEligible: 0, cardsSeen: 0,
    rejectedIneligibleEntry: 0, rejectedCraft: 0, rejectedUnreadableContext: 0,
    rejectedNotGeneralisable: 0, rejectedInvalid: 0,
  };
  // Grouped as they arrive rather than listed. A run over a few hundred
  // entries rejects in bulk and repetitively - fifty identical "no key source
  // recorded" lines say exactly as much as one line and a count, and the
  // caller has to group them to render them anyway.
  const note = (reason, detail) => {
    if (!rejections.has(reason)) rejections.set(reason, { reason, count: 0, examples: [] });
    const bucket = rejections.get(reason);
    bucket.count += 1;
    if (detail && bucket.examples.length < MAX_REJECTION_EXAMPLES && !bucket.examples.includes(detail)) {
      bucket.examples.push(detail);
    }
  };

  for (const entry of entries) {
    const eligible = entryEligibility(entry);
    if (!eligible.ok) {
      stats.rejectedIneligibleEntry += 1;
      note('entry ineligible', eligible.reason);
      continue;
    }

    const context = parseGenerationContext(entry.assembledPrompt);
    if (!context.parsed) {
      stats.rejectedUnreadableContext += 1;
      note('prompt could not be read', entry.id);
      continue;
    }
    stats.entriesEligible += 1;

    const parsed = extractJson(entry.rawResponse);
    const raw = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.scenarios) ? parsed.scenarios : null);
    if (!raw) {
      stats.rejectedInvalid += 1;
      note('response was not a JSON array', entry.id);
      continue;
    }

    const craft = warningsByIndex(entry.validationWarnings);
    const tagMap = nameTagMap(context);

    raw.forEach((item, index) => {
      stats.cardsSeen += 1;
      // Re-validated rather than trusted: the log keeps the model's raw reply,
      // not the normalised card, so this is the same validator the player's
      // copy went through - cleaning, tier fields, clamped labels and all.
      const result = validateScenario(item, index);
      if (!result.ok) { stats.rejectedInvalid += 1; return; }

      const warnings = craft.get(index) || [];
      if (warnings.length > maxCraftWarnings) {
        stats.rejectedCraft += 1;
        note('craft warnings', warnings.join('; '));
        return;
      }

      const originalText = cardText(result.scenario);
      const { card, used, residual } = depersonalise(result.scenario, tagMap);
      const reasons = seedRejectionReasons(card, originalText, context, residual);
      if (reasons.length) {
        stats.rejectedNotGeneralisable += 1;
        note('not generalisable', reasons.join('; '));
        return;
      }

      candidates.push({
        card,
        usedTags: used,
        warnings,
        entryId: entry.id,
        timestamp: entry.timestamp,
        age: context.age,
        tier: context.tier || entry.contentMode || 'safe',
        stage: context.stage,
        librarySlotUsed: entry.librarySlotUsed || null,
      });
    });
  }

  return {
    candidates,
    stats,
    rejections: [...rejections.values()].sort((a, b) => b.count - a.count),
  };
}

/* ------------------------------------------------------ path 1: the deck */

/**
 * Seed-deck harvesting - the lighter touch. Take the card as generated, put
 * the name tags back, drop anything that leans on this life's own history,
 * and check it is not a near-repeat of something the deck already has.
 *
 * No model call: the content is already written. That is the whole difference
 * between this path and the library one.
 *
 * @returns {{ records: object[], duplicates: object[], stats: object }}
 */
export function harvestSeeds(candidates, {
  seeds = [], seedDrafts = [],
  duplicateThreshold = HARVEST_DEFAULTS.duplicateThreshold,
  max = HARVEST_DEFAULTS.maxSeedCandidates,
} = {}) {
  const usedIds = new Set([...seeds.map((s) => s.id), ...seedDrafts.map((s) => s.id)]);
  const stats = { proposed: 0, duplicates: 0, kept: 0 };
  const shaped = [];

  for (const candidate of candidates) {
    if (shaped.length >= max) break;
    stats.proposed += 1;
    const age = Number.isFinite(candidate.age) ? candidate.age : 30;
    const bucket = bucketForAge(age);
    // The same shaping bulk generation uses, so a harvested row and a
    // generated row are the same kind of thing in the same queue: id, stages,
    // life_stage, the mode widening, the weight, the narrative fields, the
    // labels and the effects.
    const record = shapeSeedRecord(candidate.card, {
      bucket,
      tier: candidate.tier === 'mature' ? 'mature' : 'safe',
      sampledAge: age,
      usedIds,
      source: HARVESTED,
    });
    usedIds.add(record.id);

    const gates = gateFlagsFor(candidate.usedTags);
    if (gates.length) record.requiresFlags = gates;

    // NOT extraction's anonymity sweep. That one is written for a library
    // pattern lifted out of somebody's biography, where a proper noun or a
    // date means leaked identity - "no names of people, companies, products
    // or places, no dates" is its rule 1. A seed card is under the opposite
    // instruction: the storyteller prompt's GROUNDING section demands "A
    // Tuesday in April, the garden centre car park", and the tone guide asks
    // for brand names outright. Pointed at this content the sweep flagged
    // Tuesday, September, Saturday, Civic, Kmart and Dad - nine warnings
    // across fifteen drafts, none of them real, which is how a reviewer
    // learns to skip the warnings list entirely.
    //
    // Measured before removing, and a narrower "capitalised word in a
    // person-naming position" replacement was measured too: it scored worse,
    // catching choice-label verbs and more brands, and still found no real
    // name in 201 candidates. So the generic sweep is gone and only the one
    // precise, zero-noise check remains. (harvestPatterns still runs the real
    // identityWarnings, where it is the right question.)
    const notes = [
      ...(candidate.warnings || []),
      ...hardcodedNameWarnings(record),
    ];
    if (notes.length) record.validationWarnings = notes;

    record.harvestedFrom = {
      logEntry: candidate.entryId,
      at: candidate.timestamp,
      age,
      librarySlot: candidate.librarySlotUsed,
    };
    shaped.push(record);
  }

  // Word overlap against the live deck, the queue already waiting for review,
  // and earlier candidates in this same run - which is where a harvest's own
  // near-repeats come from, since one player's batch of five often circles the
  // same situation twice.
  const duplicates = duplicatesBy(
    shaped, [...seeds, ...seedDrafts], (r) => displayText(r), duplicateThreshold,
  );
  const duplicateIds = new Set(duplicates.map((d) => d.id));
  const records = shaped.filter((r) => !duplicateIds.has(r.id));
  stats.duplicates = duplicates.length;
  stats.kept = records.length;

  return { records, duplicates, stats };
}

/* --------------------------------------------------- path 2: the library */

/**
 * Library-pattern harvesting - the heavier touch, and a different question.
 *
 * A seed card is kept for its wording. A library pattern is the opposite: the
 * wording is thrown away and only the SHAPE survives, so the storyteller can
 * write it fresh against somebody else's life. That generalisation prompt
 * already exists and is already the product (server/extraction.js), so this
 * does not write a second one - it hands the extractor the harvested
 * scenarios as its "source text", the same way the admin's paste box hands it
 * a memoir.
 *
 * Major-tier only. A major card is a full scene with stakes, a number and a
 * consequence; a minor card is one line, and generalising one line produces a
 * pattern that says nothing.
 *
 * The whole batch goes in as ONE document. The extractor is asked for 8-15
 * patterns, which is a sensible ask of fifteen scenes and a nonsense ask of
 * one - and pooling them is also what lets it notice the shape that shows up
 * three times.
 *
 * @returns {{ patterns, problems, collisions, duplicates, warnings, model, ms, skipped }}
 */
export async function harvestPatterns(candidates, {
  library = [], drafts = [],
  minMajor = HARVEST_DEFAULTS.minMajorForLibrary,
  duplicateThreshold = HARVEST_DEFAULTS.duplicateThreshold,
} = {}) {
  const majors = candidates.filter((c) => c.card.weight === 'major');
  if (majors.length < minMajor) {
    return {
      patterns: [], problems: [], collisions: [], duplicates: [], warnings: [],
      model: null, ms: 0,
      skipped: `only ${majors.length} eligible major-tier card(s); needs ${minMajor}`,
      majorsUsed: majors.length,
    };
  }

  // Tags out, plain prose in: "{{new:roommate}} has labelled the milk" becomes
  // "your roommate has labelled the milk". The extractor is being asked to
  // read a life, not to parse the game's markup - and this keeps the substitution
  // guarantee intact, since a name never enters the text in the first place.
  const source = majors
    .map((c, i) => `--- SCENARIO ${i + 1} (age ${c.age ?? 'unknown'}) ---\n${untagged(c.card)}`)
    .join('\n\n')
    .slice(0, MAX_SOURCE_CHARS);

  const result = await extractPatterns(source);

  const taken = new Set([...library.map((p) => p.id), ...drafts.map((p) => p.id)]);
  const stamped = [];
  for (const pattern of result.patterns) {
    const id = uniquePatternId(pattern, taken);
    taken.add(id);
    stamped.push({ ...pattern, id, source: HARVESTED });
  }

  return {
    patterns: stamped,
    problems: stamped.flatMap((p, i) => validatePattern(p, i)),
    collisions: idCollisions(result.patterns, library),
    duplicates: duplicatesBy(stamped, [...library, ...drafts], (p) => p.pattern, duplicateThreshold),
    warnings: stamped.map((p) => ({ id: p.id, warnings: identityWarnings(p) })).filter((w) => w.warnings.length),
    model: result.model,
    ms: result.ms,
    skipped: null,
    majorsUsed: majors.length,
  };
}

// Ids must be unique WITHIN the draft queue so the review screen can address
// one row unambiguously - the same rule and the same treatment /api/extract
// applies. A collision with the LIVE library is reported instead of renamed,
// because a person has to decide whether that is a duplicate idea or just a
// duplicate word.
function uniquePatternId(pattern, taken) {
  const base = String(pattern.id || pattern.pattern || 'harvested')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .split('_').slice(0, 5).join('_').slice(0, 40) || 'harvested';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  return `${base}_${Date.now()}`;
}

/* -------------------------------------------------------------- the run */

/**
 * One on-demand harvest. Reads the log, runs both paths, returns what each
 * proposes. WRITES NOTHING - the caller (server/admin/index.js) appends to the
 * two draft files, so this module keeps the same "never touches a content
 * file" property server/extraction.js and server/seed-generation.js have.
 *
 * @param {object} opts
 * @param {string} [opts.from] ISO date, inclusive
 * @param {string} [opts.to]   ISO date, inclusive to end of day
 * @param {number} [opts.limit] how many log entries to read, newest first
 * @param {boolean} [opts.harvestSeeds]    run path 1
 * @param {boolean} [opts.harvestPatterns] run path 2 (one LLM call)
 * @param {Function} [opts.onProgress] called with {type, ...} as the run moves
 */
export async function runHarvest({
  from = null, to = null, limit = HARVEST_DEFAULTS.limit,
  maxCraftWarnings = HARVEST_DEFAULTS.maxCraftWarnings,
  duplicateThreshold = HARVEST_DEFAULTS.duplicateThreshold,
  seeds = [], seedDrafts = [], library = [], drafts = [],
  wantSeeds = true, wantPatterns = true,
  onProgress = () => {},
} = {}) {
  const { entries, total } = queryEntries({ from, to, limit });
  onProgress({ type: 'scan', read: entries.length, matching: total });

  const { candidates, stats, rejections } = scanEntries(entries, { maxCraftWarnings });
  onProgress({
    type: 'eligible',
    entries: stats.entriesEligible,
    cards: candidates.length,
    seen: stats.cardsSeen,
  });

  const seedResult = wantSeeds
    ? harvestSeeds(candidates, { seeds, seedDrafts, duplicateThreshold })
    : { records: [], duplicates: [], stats: { proposed: 0, duplicates: 0, kept: 0 } };
  if (wantSeeds) {
    onProgress({ type: 'seeds', kept: seedResult.records.length, duplicates: seedResult.duplicates.length });
  }

  let patternResult = {
    patterns: [], problems: [], collisions: [], duplicates: [], warnings: [],
    model: null, ms: 0, skipped: 'not requested', majorsUsed: 0,
  };
  if (wantPatterns) {
    onProgress({ type: 'patterns-start', majors: candidates.filter((c) => c.card.weight === 'major').length });
    patternResult = await harvestPatterns(candidates, { library, drafts, duplicateThreshold });
    onProgress({ type: 'patterns', proposed: patternResult.patterns.length, skipped: patternResult.skipped });
  }

  return {
    scanned: entries.length,
    matching: total,
    stats,
    // Already grouped by reason, commonest first (see scanEntries): the
    // point of these is to explain the shape of the result, not to reproduce
    // the log line by line.
    rejections,
    seeds: seedResult,
    patterns: patternResult,
  };
}
