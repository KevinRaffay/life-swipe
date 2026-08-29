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
import { SOURCES, isSource } from '../../shared/provenance.js';
import { CATEGORIES, RARITIES, validatePattern } from '../extraction.js';
import { GENDER_ASSOCS } from '../../shared/names.js';

export const PATTERN_CATEGORIES = [...CATEGORIES];
export const PATTERN_RARITIES = [...RARITIES];
export const MODES = ['safe', 'mature'];
export const CONTENT_SOURCES = [...SOURCES];
export const NAME_GENDER_ASSOCS = [...GENDER_ASSOCS];

const REGION_CODE_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

// Authoring provenance is optional - every record written before it existed
// has none, and shared/provenance.js reads that absence as 'hand-authored'.
// What is not optional is that a value, when present, is one of the four:
// a typo here would quietly split the harvested-share number in two.
const sourceProblems = (record) =>
  (record?.source === undefined || isSource(record.source))
    ? []
    : [`source "${record.source}" is not one of ${SOURCES.join(', ')}`];

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
  problems.push(...sourceProblems(pattern));
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
  problems.push(...sourceProblems(card));
  return { ok: result.ok && !problems.length, problems, normalised: result.scenario || null };
}

/**
 * Validate one name-pool entry for the admin form. Mirrors the structural
 * half of scripts/name-check.js's checks (that script is the authority on the
 * FILE as a whole - duplicates across the pool, category-share warnings - this
 * is the authority on one record in isolation, before it is written).
 * @param {object} entry
 * @param {Array} siblings  the rest of the pool, for the name-uniqueness check
 * @returns {string[]} human-readable problems, empty when valid
 */
export function validateNamePoolEntry(entry, siblings = []) {
  const problems = [];
  if (typeof entry?.name !== 'string' || !entry.name.trim()) problems.push('name must be a non-empty string');
  else if (siblings.some((s) => s.name.toLowerCase() === entry.name.toLowerCase())) {
    problems.push(`name "${entry.name}" is already used by another entry`);
  }
  if (typeof entry?.category !== 'string' || !entry.category.trim()) problems.push('category is required');
  if (!NAME_GENDER_ASSOCS.includes(entry?.gender_assoc)) {
    problems.push(`gender_assoc must be one of ${NAME_GENDER_ASSOCS.join(', ')}`);
  }
  if (!Number.isFinite(entry?.era_start) || entry.era_start < 1900 || entry.era_start > 2030) {
    problems.push('era_start must be a number between 1900 and 2030');
  }
  if (entry?.era_end !== undefined && entry.era_end !== null) {
    if (!Number.isFinite(entry.era_end) || entry.era_end <= entry.era_start) {
      problems.push('era_end must be a number after era_start');
    }
  }
  if (entry?.active !== undefined && typeof entry.active !== 'boolean') problems.push('active must be true or false');
  if (entry?.region_frequency !== undefined) {
    if (typeof entry.region_frequency !== 'object' || Array.isArray(entry.region_frequency) || entry.region_frequency === null) {
      problems.push('region_frequency must be an object of region code -> weight');
    } else {
      for (const [code, lq] of Object.entries(entry.region_frequency)) {
        if (!REGION_CODE_RE.test(code)) problems.push(`bad region code "${code}"`);
        if (!Number.isFinite(lq) || lq <= 0) problems.push(`region_frequency.${code} must be a positive number`);
      }
    }
  }
  return problems;
}

/**
 * Validate one entry being added to a name-pool-controls list (category,
 * region or gender_assoc deactivation). `reason` is required on all three -
 * this is a pool-wide action, and the whole point of the file is a visible
 * trail of why.
 * @param {{ value: string, reason: string }} input
 * @param {Array} siblings  the rest of that one list, for the duplicate check
 * @param {string} label    "category" | "region" | "gender_assoc", for messages
 */
export function validateGroupControlEntry({ value, reason }, siblings = [], label = 'value') {
  const problems = [];
  if (typeof value !== 'string' || !value.trim()) problems.push(`${label} is required`);
  else if (siblings.includes(value)) problems.push(`${value} is already deactivated`);
  if (typeof reason !== 'string' || !reason.trim()) problems.push('reason is required');
  return problems;
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
