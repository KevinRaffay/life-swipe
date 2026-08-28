// How hard a turn's consequences hit, so EventToast knows whether to show a
// glanceable toast or stop the player with a modal. Same minor/standard/major
// vocabulary as shared/scenario-format.js, but this is a presentation
// decision about *results*, not the card's own authored weight - a `minor`
// card can still roll a life-changing risk outcome.
//
// Tune the two knobs below; nothing else in this file should need to change.
export const SEVERITY = {
  // |health| or |happiness| delta this turn, out of the engine's own ±25
  // per-choice cap (BAL.CLAMP.statDelta in shared/balance.js), that counts
  // as a major swing rather than an ordinary one.
  statSwingThreshold: 15,

  // Flags whose first appearance this turn makes the consequence major.
  // Extend this as content introduces other flags worth stopping for.
  significantFlags: new Set([
    'has_kids', 'retired', 'injured',
    'married', 'engaged', 'divorced', 'widowed',
    'arrested', 'incarcerated', 'bankrupt', 'diagnosed', 'homeless',
    'recovery_attempt',
  ]),
};

/**
 * @param {{events?: Array<{type: string, text: string}>, newFlags?: string[], delta?: {health?: number, happiness?: number}}} turn
 * @returns {'major' | 'standard'}
 */
export function classifyConsequence({ events = [], newFlags = [], delta } = {}) {
  if (events.some((e) => e.type === 'resolved')) return 'major';
  if (newFlags.some((f) => SEVERITY.significantFlags.has(f))) return 'major';
  if (delta && (
    Math.abs(delta.health || 0) >= SEVERITY.statSwingThreshold ||
    Math.abs(delta.happiness || 0) >= SEVERITY.statSwingThreshold
  )) return 'major';
  return 'standard';
}
