// Scenario narrative format: weight tiers and the fields each tier may carry.
//
// This is presentation structure only. Nothing here touches effects, state or
// the referee - a card's shape and a card's consequences are separate concerns.

export const TIERS = ['minor', 'standard', 'major'];

// Which narrative fields each tier is allowed. Anything outside a tier's set is
// dropped rather than rejected: the validator is a backstop, and a card with
// one field too many is still a playable card.
export const TIER_FIELDS = {
  minor: ['prompt'],
  standard: ['setting', 'prompt'],
  major: ['setting', 'beat', 'dialogue', 'prompt'],
};

export const FIELD_LIMITS = { setting: 160, beat: 200, dialogue: 200, prompt: 400 };

// A major card gets 60-90 words. Enforced in the generation prompt; measured
// here so drift is visible rather than assumed.
export const MAJOR_WORDS = [60, 90];

// Per-field word targets for a major card, same contract as MAJOR_WORDS:
// the prompt asks for them, narrativeWarnings measures them, nothing rejects
// on them. Warnings fire only outside the targets widened by WORD_TOLERANCE.
export const MAJOR_FIELD_WORDS = {
  setting: [15, 20],
  beat: [15, 20],
  dialogue: [12, 18],
  prompt: [18, 25],
};
export const WORD_TOLERANCE = 0.3;

// "Has a concrete number" means digits anywhere, or a spelled-out quantity
// word. "one" and ordinals are deliberately absent - "the one", "no one" and
// "first date" would make the missing-number warning near-impossible to fire.
const NUMBER_WORD = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|half)\b/i;

export function hasConcreteNumber(text) {
  return /\d/.test(text) || NUMBER_WORD.test(text);
}

const SLUGLINE = /^\s*(INT\.|EXT\.|INT\/EXT|FADE (IN|OUT)|CUT TO|ANGLE ON|CLOSE ON)[\s.:-]*/i;
const CAPS_NAME = /\b[A-Z]{2,}(?:\s+[A-Z]{2,})*\s*:\s*/;

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

// Where a sentence ends: terminal punctuation, any closing quote or bracket
// riding on it, and then whitespace or the end of the string.
const SENTENCE_END = /[.!?]["'’”)\]]*(?=\s|$)/g;

// Words that end in a period without ending a sentence. Short list on
// purpose - it only has to cover what this game's register actually writes,
// and a miss degrades to a word-boundary cut rather than to anything wrong.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'inc', 'no',
  'approx', 'dept', 'est', 'min', 'max', 'oz', 'lb', 'ft', 'hr', 'a.m', 'p.m',
]);

// How much of the budget a sentence-boundary cut must keep to be worth it.
// Below this, ending on the last full sentence throws away more than it
// saves, and a marked word-boundary cut reads better than half a card.
const MIN_SENTENCE_KEEP = 0.6;

/**
 * Cut over-long narrative text without leaving a broken word.
 *
 * The old behaviour was a bare slice at the limit, which produced "The super
 * is not answering. Someone n" on a live card. Roughly one generated card in
 * twelve overruns a field, and two thirds of those landed mid-word, so this
 * was not a rare edge.
 *
 * Preference order:
 *   1. End on the last COMPLETE SENTENCE inside the budget. A setting that
 *      stops at a full stop reads as written rather than as damaged, and this
 *      is what the overrunning cards actually want - they are one good
 *      sentence plus the start of another.
 *   2. Failing that (one long sentence, or a boundary so early that obeying
 *      it would gut the text), stop at a word boundary and end with an
 *      ellipsis, so the elision is visible instead of looking like a typo.
 *
 * The result never exceeds `limit`, ellipsis included.
 */
export function truncateNarrative(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;

  const head = text.slice(0, limit);

  let lastEnd = -1;
  SENTENCE_END.lastIndex = 0;
  let match;
  while ((match = SENTENCE_END.exec(head)) !== null) {
    // "...flagged AP Chemistry" must not end a sentence at "AP.", and
    // "Dr. Okonkwo" must not end one at "Dr.".
    const before = head.slice(0, match.index);
    const word = (before.match(/(\S+)$/) || ['', ''])[1].toLowerCase();
    const isInitial = /^[a-z]$/.test(word);
    if (ABBREVIATIONS.has(word) || isInitial) continue;
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd >= limit * MIN_SENTENCE_KEEP) return head.slice(0, lastEnd).trim();

  // Leave room for the ellipsis so the cap is still honoured.
  const room = head.slice(0, limit - 1);
  const lastSpace = room.lastIndexOf(' ');
  const body = lastSpace > limit * MIN_SENTENCE_KEEP ? room.slice(0, lastSpace) : room;
  // A trailing comma or dash before an ellipsis reads as a mistake.
  return body.trimEnd().replace(/[,;:–—-]+$/, '').trimEnd() + '…';
}
/** Strip screenplay habits the house style does not use. */
export function cleanNarrative(value, field) {
  if (!isStr(value)) return undefined;
  let text = value.trim().replace(/\s+/g, ' ');
  text = text.replace(SLUGLINE, '');
  text = text.replace(CAPS_NAME, (m) => m.charAt(0) + m.slice(1).toLowerCase());
  if (field === 'dialogue') {
    // One exchange only: at most two spoken lines.
    const parts = text.split(/(?<=[."'!?])\s+(?=[A-Z"'])/);
    text = parts.slice(0, 2).join(' ');
  }
  text = truncateNarrative(text.trim(), FIELD_LIMITS[field] || 300);
  return text || undefined;
}

/**
 * Normalise a raw scenario's narrative fields to its weight tier.
 * Accepts the older single-field shape, where the whole card was `scenario`.
 */
export function normalizeNarrative(raw, weight) {
  const tier = TIERS.includes(weight) ? weight : 'standard';
  const allowed = TIER_FIELDS[tier];
  const out = {};

  // Backwards compatibility: a card written before the split put everything in
  // `scenario`. Treat that as the prompt.
  const promptSource = isStr(raw.prompt) ? raw.prompt : raw.scenario;

  for (const field of allowed) {
    const value = field === 'prompt' ? promptSource : raw[field];
    const cleaned = cleanNarrative(value, field);
    if (cleaned) out[field] = cleaned;
  }
  return out;
}

/** The single block of text anything that wants one line should use. */
export function displayText(s) {
  return [s.setting, s.beat, s.dialogue, s.prompt].filter(Boolean).join(' ');
}

export function wordCount(s) {
  return displayText(s).split(/\s+/).filter(Boolean).length;
}

/** Non-fatal observations, for content tooling rather than the game loop. */
export function narrativeWarnings(s) {
  const warnings = [];
  const tier = TIERS.includes(s.weight) ? s.weight : 'standard';
  for (const field of TIER_FIELDS[tier]) {
    if (field === 'prompt' && !s.prompt) warnings.push('missing prompt');
    if (field !== 'prompt' && !s[field]) warnings.push('missing ' + field);
  }
  if (tier === 'major') {
    const n = wordCount(s);
    if (n < MAJOR_WORDS[0]) warnings.push('major is ' + n + ' words, under ' + MAJOR_WORDS[0]);
    if (n > MAJOR_WORDS[1]) warnings.push('major is ' + n + ' words, over ' + MAJOR_WORDS[1]);
    for (const [field, [lo, hi]] of Object.entries(MAJOR_FIELD_WORDS)) {
      if (!isStr(s[field])) continue; // absence is already reported above
      const words = s[field].split(/\s+/).filter(Boolean).length;
      const min = Math.floor(lo * (1 - WORD_TOLERANCE));
      const max = Math.ceil(hi * (1 + WORD_TOLERANCE));
      if (words < min || words > max) {
        warnings.push('major ' + field + ' is ' + words + ' words, target ' + lo + '-' + hi);
      }
    }
    if (!hasConcreteNumber(displayText(s))) {
      warnings.push('major has no concrete number');
    }
  }
  return warnings;
}
