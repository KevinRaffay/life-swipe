// Field-level validation for the two content types the admin edits.
//
// Patterns reuse the checks the extractor already applies (server/extraction.js)
// so a draft and a hand-written pattern are held to one standard. Seeds reuse
// the GAME's own validator - validateScenario from shared/schema.js - rather
// than a second opinion about what a card is, because a card the admin calls
// valid and the deck then drops would be worse than no check at all.
//
// Nothing here modifies the player-facing validator; it only calls it.

import { validateScenario } from '../../shared/schema.js';
import { CATEGORIES, RARITIES, validatePattern } from '../extraction.js';

export const PATTERN_CATEGORIES = [...CATEGORIES];
export const PATTERN_RARITIES = [...RARITIES];
export const MODES = ['safe', 'mature'];

const isFlagList = (v) => !v || (Array.isArray(v) && v.every((f) => typeof f === 'string' && /^[a-z0-9_]+$/.test(f)));

/**
 * Validate one library pattern for the admin form.
 * @param {object} pattern
 * @param {Array} siblings  the rest of the library, for the uniqueness check
 * @returns {string[]} human-readable problems, empty when valid
 */
export function validateLibraryPattern(pattern, siblings = []) {
  // The extractor's checks, restated without its "[index]" prefixes.
  const problems = validatePattern(pattern, 0).map((p) => p.replace(/^\[\d+\]\s*/, ''));

  if (typeof pattern?.id === 'string' && siblings.some((s) => s.id === pattern.id)) {
    problems.push(`id "${pattern.id}" is already used by another pattern`);
  }
  // Stated explicitly because the form surfaces them as distinct fields, and a
  // "modes must be a non-empty subset" message beats a bare "modes".
  if (Array.isArray(pattern?.modes) && pattern.modes.length
      && pattern.modes.some((m) => !MODES.includes(m))) {
    problems.push('modes must be a non-empty subset of ["safe","mature"]');
  }
  if (Array.isArray(pattern?.life_stage) && pattern.life_stage.length === 2
      && !(pattern.life_stage[1] > pattern.life_stage[0])) {
    problems.push('life_stage must be [min, max] with max greater than min');
  }
  if (!isFlagList(pattern?.requires)) problems.push('requires must be snake_case flag strings');
  if (!isFlagList(pattern?.excludes)) problems.push('excludes must be snake_case flag strings');
  return problems;
}

/**
 * Validate one seed scenario, through the real validator.
 * @returns {{ ok: boolean, problems: string[], normalised: object|null }}
 */
export function validateSeedScenario(card, siblings = []) {
  const result = validateScenario(card, 0);
  const problems = (result.errors || []).map((e) => e.replace(/^scenario\[\d+\]:?\s*/, ''));
  if (typeof card?.id === 'string' && siblings.some((s) => s.id === card.id)) {
    problems.push(`id "${card.id}" is already used by another scenario`);
  }
  return { ok: result.ok && !problems.length, problems, normalised: result.scenario || null };
}

/** A unique snake_case id derived from a title, for approving a draft. */
export function generateId(base, taken = []) {
  const root = String(base || 'pattern')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .split('_').slice(0, 5).join('_')
    .slice(0, 40) || 'pattern';
  const used = new Set(taken);
  if (!used.has(root)) return root;
  for (let n = 2; n < 500; n++) if (!used.has(`${root}_${n}`)) return `${root}_${n}`;
  return `${root}_${Date.now()}`;
}
