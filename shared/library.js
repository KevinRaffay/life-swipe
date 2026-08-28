// Situation library: curated, anonymised life-event SHAPES that periodically
// seed generation, so a life draws on authentic structures rather than pure
// model improvisation.
//
// A pattern never becomes a card by itself. It is a brief handed to the
// storyteller, which writes the actual scenario and PROPOSES effects; the
// engine still validates, clamps, rolls and owns all state. Nothing here
// changes that split.

import { nextRandom } from './rng.js';
import { effectiveTier } from './content.js';

// One library slot roughly every 4-6 scenarios. Tunable.
export const LIBRARY_INTERVAL = [4, 6];

export const RARITY_WEIGHT = { common: 3, uncommon: 2, rare: 1 };

export function createLibraryState(rand) {
  const [lo, hi] = LIBRARY_INTERVAL;
  return {
    nextAt: lo + Math.floor(rand() * (hi - lo + 1)),
    fired: [],      // pattern ids that actually reached the player this life
    offered: 0,     // slots requested
  };
}

/** Is the next batch due a library slot? */
export function librarySlotDue(state) {
  return Boolean(state.library) && state.turn >= state.library.nextAt;
}

export function scheduleNextSlot(state, rand) {
  const [lo, hi] = LIBRARY_INTERVAL;
  state.library.nextAt = state.turn + lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * Why each pattern was or was not usable. Returned in full so the simulator can
 * spot dead patterns rather than silently never firing them.
 */
export function filterPatterns(state, library, seen = []) {
  const age = state.ageMonths / 12;
  const tier = effectiveTier({ age, contentMode: state.contentMode });
  const flags = state.flags || [];
  const eligible = [];
  const rejected = [];

  for (const p of library) {
    const reasons = [];
    const [minAge, maxAge] = p.life_stage || [0, 999];
    if (age < minAge || age > maxAge) reasons.push('age');
    if (!Array.isArray(p.modes) || !p.modes.includes(tier)) reasons.push('mode');
    if (Array.isArray(p.requires) && !p.requires.every((f) => flags.includes(f))) reasons.push('requires');
    if (Array.isArray(p.excludes) && p.excludes.some((f) => flags.includes(f))) reasons.push('excludes');
    if (seen.includes(p.id)) reasons.push('seen');
    if (state.library && state.library.fired.includes(p.id)) reasons.push('fired_this_life');

    if (reasons.length) rejected.push({ id: p.id, reasons });
    else eligible.push(p);
  }
  return { eligible, rejected };
}

/**
 * Weighted pick among everything that survived filtering. Uses the run's own
 * RNG, so a seeded life selects the same patterns every replay.
 * @returns {object|null} null means "no candidate - use a free-generation slot"
 */
export function selectPattern(state, library, seen = []) {
  const { eligible } = filterPatterns(state, library, seen);
  if (!eligible.length) return null;

  const weights = eligible.map((p) => RARITY_WEIGHT[p.rarity] || 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = nextRandom(state) * total;
  for (let i = 0; i < eligible.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}

/** Does this pattern's guidance ask for a pending event or a branch point? */
export function patternWantsPending(pattern) {
  return /pending_event/i.test(String(pattern.typical_effects || ''));
}
export function patternWantsBranch(pattern) {
  return /branch/i.test(String(pattern.typical_effects || ''));
}

/** Recorded only once the card has actually been shown to the player. */
export function notePatternFired(state, patternId) {
  if (!state.library || !patternId) return;
  if (!state.library.fired.includes(patternId)) state.library.fired.push(patternId);
}
