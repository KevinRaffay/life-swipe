// The two authored identity choices shown at the start of every life, before
// the first deck.draw() card - and the offline fallback text for the
// grounding beat that follows them (server/prompt.js writes the generated
// version; this is what shows if that call fails or times out).
//
// These are NOT generated content: a small fixed pool of hand-authored
// phrasing variants, picked at random per life with no cross-life repetition
// tracking (the pool is small enough that it doesn't need it, unlike the seed
// deck's seen-window). They never go through Deck.draw, so they never touch
// seen_patterns/seen_seed_ids, and the choice itself never reaches an LLM
// call, so there is nothing here for the harvester to ever see.
//
// Still applied through applyChoice/normalizeEffects like any other card
// (invariant 1) - this module only builds the scenario shape, validated the
// same way a hand-authored seed is, and never writes state itself.

import { BAL } from './balance.js';
import { validateScenario } from './schema.js';

const FINANCIAL_TIER_VARIANTS = [
  { prompt: "Money's tight most months at home, or there's usually a little extra?", leftLabel: 'Tight most months', rightLabel: 'A little extra' },
  { prompt: 'Growing up, was it a stretch to cover the bills, or did your family have some breathing room?', leftLabel: 'A real stretch', rightLabel: 'Breathing room' },
  { prompt: 'At home, did every dollar get counted twice, or was money rarely the thing anyone worried about?', leftLabel: 'Counted twice', rightLabel: 'Rarely worried' },
  { prompt: 'Did you grow up watching the mailbox for bills, or was that never really your problem?', leftLabel: 'Watching the mail', rightLabel: 'Never your problem' },
];

const PERSONALITY_VARIANTS = [
  { prompt: "You'd rather have your nose in a book, or be out with friends?", leftLabel: 'Nose in a book', rightLabel: 'Out with friends' },
  { prompt: 'Given a free Saturday, are you home with a book, or already out the door?', leftLabel: 'Home with a book', rightLabel: 'Out the door' },
  { prompt: 'Are you the one who reads ahead of the assignment, or the one who already has plans tonight?', leftLabel: 'Reads ahead', rightLabel: 'Already has plans' },
  { prompt: 'Quiet and heads-down, or loud and out with everyone?', leftLabel: 'Quiet, heads-down', rightLabel: 'Loud, out with everyone' },
];

// left = modest/bookish, right = comfortable/social, held fixed across every
// phrasing variant so the wording can vary without the effects drifting.
const CARD_DEFS = {
  financialTier: {
    id: 'intro_financial_tier',
    variants: FINANCIAL_TIER_VARIANTS,
    leftEffects: {
      money: BAL.INTRO.financialTierModifiers.modest,
      flags: ['modest_upbringing'],
    },
    rightEffects: {
      money: BAL.INTRO.financialTierModifiers.comfortable,
      flags: ['comfortable_upbringing'],
    },
  },
  personality: {
    id: 'intro_personality',
    variants: PERSONALITY_VARIANTS,
    leftEffects: { flags: ['bookish'] },
    rightEffects: { flags: ['social'] },
  },
};

export const INTRO_CARD_ORDER = ['financialTier', 'personality'];

/**
 * Build one authored identity card, ready for applyChoice. `rng` is the run's
 * own seeded random (invariant 6: everything that consumes randomness goes
 * through nextRandom(state)), so a given seed picks the same phrasing on
 * replay. Routed through validateScenario like any hand-authored card, so it
 * comes out with the same derived `scenario` display text and shape as
 * everything else applyChoice sees.
 */
export function buildIdentityCard(kind, rng) {
  const def = CARD_DEFS[kind];
  if (!def) throw new Error(`unknown identity card: ${kind}`);
  const variant = def.variants[Math.floor(rng() * def.variants.length)] || def.variants[0];
  const { scenario } = validateScenario({
    id: def.id,
    weight: 'minor',
    prompt: variant.prompt,
    leftLabel: variant.leftLabel,
    rightLabel: variant.rightLabel,
    leftEffects: def.leftEffects,
    rightEffects: def.rightEffects,
    source: 'intro',
  });
  return scenario;
}

// Offline fallback for the grounding beat (server/prompt.js's generated
// version is preferred). One per financial-tier flag is enough - the
// personality flag is flavor for the generated version and can be omitted
// here without the beat reading as generic.
const FALLBACK_GROUNDING_BEATS = {
  modest_upbringing: {
    setting: 'A Tuesday after school, sixteen years old, the kitchen table under the one bulb that still works.',
    beat: 'You do homework around a stack of mail nobody has opened yet, same as most weeks.',
  },
  comfortable_upbringing: {
    setting: 'A Tuesday after school, sixteen years old, your own room with the door mostly closed.',
    beat: 'You do homework with the television on somewhere else in the house, because nobody up here is counting too closely.',
  },
};

export function fallbackGroundingBeat(financialFlag) {
  return FALLBACK_GROUNDING_BEATS[financialFlag] || FALLBACK_GROUNDING_BEATS.modest_upbringing;
}
