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
  text = text.trim().slice(0, FIELD_LIMITS[field] || 300);
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
