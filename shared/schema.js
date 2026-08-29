// Structural validation for anything claiming to be a scenario.
// Runs on the server (before an LLM batch is handed to the client) and again
// on the client (before a card is drawn). Hand-rolled on purpose: no ajv, no
// surprises about which dialect of JSON Schema we are speaking today.
//
// This layer only checks SHAPE. Clamping values to sane ranges is the engine's
// job (engine.js -> normalizeEffects), because that depends on live game state.

import { checkCompliance, MODES } from './content.js';
import { TIERS, normalizeNarrative, displayText, narrativeWarnings, britishSpellingWarnings } from './scenario-format.js';
import { checkNameDrift, checkReintroductions } from './names.js';

const WEIGHTS = new Set([...TIERS, 'trivial']);
const OUTCOMES = new Set(['death', 'injury', 'windfall']);

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function normalizeFlag(raw) {
  if (!isStr(raw)) return null;
  const flag = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return flag.length >= 2 ? flag : null;
}

function validateRisk(risk, path, errors) {
  if (risk === undefined || risk === null) return undefined;
  if (typeof risk !== 'object' || Array.isArray(risk)) {
    errors.push(`${path}: risk must be an object`);
    return undefined;
  }
  if (!isNum(risk.probability)) {
    errors.push(`${path}.risk: probability must be a number`);
    return undefined;
  }
  if (!OUTCOMES.has(risk.outcome)) {
    errors.push(`${path}.risk: outcome must be one of ${[...OUTCOMES].join('|')}`);
    return undefined;
  }
  return {
    probability: risk.probability,
    outcome: risk.outcome,
    description: isStr(risk.description) ? risk.description.slice(0, 220) : 'It goes badly.',
  };
}

function validateEffects(eff, path, errors) {
  if (eff === undefined || eff === null) return {};
  if (typeof eff !== 'object' || Array.isArray(eff)) {
    errors.push(`${path}: effects must be an object`);
    return null;
  }
  const out = {};
  for (const key of ['money', 'health', 'happiness']) {
    if (eff[key] === undefined || eff[key] === null) continue;
    if (!isNum(eff[key])) {
      errors.push(`${path}.${key}: must be a number`);
      return null;
    }
    out[key] = eff[key];
  }

  if (eff.flags !== undefined && eff.flags !== null) {
    if (!Array.isArray(eff.flags)) {
      errors.push(`${path}.flags: must be an array of strings`);
      return null;
    }
    const flags = eff.flags.map(normalizeFlag).filter(Boolean);
    if (flags.length) out.flags = flags;
  }

  if (eff.clearFlags !== undefined && Array.isArray(eff.clearFlags)) {
    const flags = eff.clearFlags.map(normalizeFlag).filter(Boolean);
    if (flags.length) out.clearFlags = flags;
  }

  const risk = validateRisk(eff.risk, path, errors);
  if (risk) out.risk = risk;
  if (eff.risk && !risk) return null;

  // Optional structured state changes. Absent = the storyteller had no opinion.
  if (eff.career && typeof eff.career === 'object') {
    const career = {};
    if (isStr(eff.career.title)) career.title = eff.career.title.slice(0, 60);
    if (isNum(eff.career.salary)) career.salary = eff.career.salary;
    if (Object.keys(career).length) out.career = career;
  }
  if (isStr(eff.education)) out.education = eff.education.slice(0, 60);

  if (eff.relationship && typeof eff.relationship === 'object' && isStr(eff.relationship.name)) {
    const rel = { name: eff.relationship.name.slice(0, 30).trim() };
    if (isStr(eff.relationship.role)) rel.role = eff.relationship.role.slice(0, 30);
    if (isNum(eff.relationship.quality)) rel.quality = eff.relationship.quality;
    if (isNum(eff.relationship.qualityDelta)) rel.qualityDelta = eff.relationship.qualityDelta;
    if (Array.isArray(eff.relationship.flags)) {
      const f = eff.relationship.flags.map(normalizeFlag).filter(Boolean);
      if (f.length) rel.flags = f;
    }
    if (eff.relationship.remove === true) rel.remove = true;
    out.relationship = rel;
  }

  if (eff.pendingEvent && typeof eff.pendingEvent === 'object' && (eff.pendingEvent.id || eff.pendingEvent.kind)) {
    out.pendingEvent = {
      id: String(eff.pendingEvent.id || eff.pendingEvent.kind).slice(0, 40),
      kind: eff.pendingEvent.kind ? String(eff.pendingEvent.kind).slice(0, 40) : undefined,
      label: eff.pendingEvent.label ? String(eff.pendingEvent.label).slice(0, 160) : undefined,
      dueInMonths: Number.isFinite(eff.pendingEvent.dueInMonths) ? eff.pendingEvent.dueInMonths : undefined,
    };
  }
  if (isStr(eff.resolves)) out.resolves = eff.resolves.slice(0, 40);

  if (eff.kid === true || eff.childBorn === true) out.kid = true;
  if (eff.retire === true) out.retire = true;
  if (isNum(eff.timeCostMonths)) out.timeCostMonths = eff.timeCostMonths;

  return out;
}

// Returns { ok, scenario, errors }
export function validateScenario(raw, index = 0) {
  const errors = [];
  const path = `scenario[${index}]`;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [`${path}: not an object`] };
  }
  // Either shape is accepted: the tiered fields, or the older single block.
  if (!isStr(raw.prompt) && !isStr(raw.scenario)) {
    errors.push(`${path}: requires a prompt (or a legacy scenario string)`);
  }
  if (!isStr(raw.leftLabel)) errors.push(`${path}.leftLabel: required non-empty string`);
  if (!isStr(raw.rightLabel)) errors.push(`${path}.rightLabel: required non-empty string`);
  if (isStr(raw.leftLabel) && isStr(raw.rightLabel) &&
      raw.leftLabel.trim().toLowerCase() === raw.rightLabel.trim().toLowerCase()) {
    errors.push(`${path}: leftLabel and rightLabel are identical`);
  }

  const leftEffects = validateEffects(raw.leftEffects, `${path}.leftEffects`, errors);
  const rightEffects = validateEffects(raw.rightEffects, `${path}.rightEffects`, errors);
  if (errors.length) return { ok: false, errors };

  const weight = WEIGHTS.has(raw.weight) ? raw.weight : 'standard';
  const narrative = normalizeNarrative(raw, weight === 'trivial' ? 'minor' : weight);
  if (!narrative.prompt) {
    return { ok: false, errors: [`${path}: prompt is empty after cleaning`] };
  }

  return {
    ok: true,
    errors: [],
    scenario: {
      id: isStr(raw.id) ? raw.id.slice(0, 60) : `gen_${index}_${Math.abs(hash(narrative.prompt))}`,
      ...narrative,
      // Derived, never authored: one flat string for history, obituaries and
      // the content backstop, so nothing downstream needs to know about tiers.
      scenario: displayText(narrative).slice(0, 700),
      leftLabel: raw.leftLabel.trim().slice(0, 40),
      rightLabel: raw.rightLabel.trim().slice(0, 40),
      weight,
      libraryId: isStr(raw.library_id) ? raw.library_id.slice(0, 60) : undefined,
      life_stage: Array.isArray(raw.life_stage) && raw.life_stage.length === 2
        && raw.life_stage.every((n) => Number.isFinite(n))
        ? [raw.life_stage[0], raw.life_stage[1]]
        : undefined,
      modes: Array.isArray(raw.modes) && raw.modes.some((m) => MODES.includes(m))
        ? raw.modes.filter((m) => MODES.includes(m))
        : ['safe', 'mature'],
      priority: Number.isFinite(raw.priority) ? raw.priority : 0,
      minAge: Number.isFinite(raw.minAge) ? raw.minAge : undefined,
      maxAge: Number.isFinite(raw.maxAge) ? raw.maxAge : undefined,
      stages: Array.isArray(raw.stages) ? raw.stages.filter(isStr) : undefined,
      requiresFlags: Array.isArray(raw.requiresFlags)
        ? raw.requiresFlags.map(normalizeFlag).filter(Boolean)
        : undefined,
      forbidsFlags: Array.isArray(raw.forbidsFlags)
        ? raw.forbidsFlags.map(normalizeFlag).filter(Boolean)
        : undefined,
      leftEffects,
      rightEffects,
      source: raw.source || 'llm',
    },
  };
}

// Validates a whole batch. Partial credit: good cards survive bad neighbours,
// but a batch that is mostly garbage is rejected so the caller can retry.
/**
 * Validates a whole batch. Partial credit: good cards survive bad neighbours,
 * but a batch that is mostly garbage is rejected so the caller can retry.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.minValid]  reject the batch below this many survivors
 * @param {string}  [opts.tier]      'safe' | 'mature' - screen content against it
 * @param {number}  [opts.age]       character age, for the under-18 rule
 * @param {object|Array} [opts.relationships]  the live cast, for the name-drift
 *   check. Either the state map or the summary array.
 * @param {Array|string} [opts.recent]  the recent-history window the model was
 *   shown, for the off-screen reintroduction check. An array of past decisions
 *   (with `scenario`/`chose`) or a pre-joined string; both are log-only advisory.
 */
export function validateBatch(raw, { minValid = 1, tier = null, age = 99, relationships = null, recent = null } = {}) {
  // A relationship "shown up in the recent window" if its name appears in the
  // history the model was given. Joined once here; the check is a string scan.
  const recentText = Array.isArray(recent)
    ? recent.map((d) => (d ? [d.scenario, d.chose].filter(Boolean).join(' ') : '')).join(' \n ')
    : (typeof recent === 'string' ? recent : '');
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, scenarios: [], errors: ['batch: not valid JSON'], warnings: [] };
    }
  }
  // Tolerate { scenarios: [...] } as well as a bare array.
  if (raw && !Array.isArray(raw) && Array.isArray(raw.scenarios)) raw = raw.scenarios;
  if (!Array.isArray(raw)) return { ok: false, scenarios: [], errors: ['batch: expected a JSON array'], warnings: [] };

  const scenarios = [];
  const errors = [];
  const warnings = []; // advisory craft observations; never affect ok/errors
  let rejectedForMode = 0;
  let rejectedForNameDrift = 0;
  raw.forEach((item, i) => {
    const res = validateScenario(item, i);
    if (!res.ok) {
      errors.push(...res.errors);
      return;
    }
    // Mode backstop. The prompt does the primary work; this catches drift, and
    // it runs on the server AND again on the client before a card is dealt.
    if (tier) {
      const compliance = checkCompliance(res.scenario, { tier, age });
      if (!compliance.ok) {
        rejectedForMode += 1;
        errors.push(`scenario[${i}]: content violates ${tier} tier (${compliance.violations.join(', ')})`);
        return;
      }
    }
    // Name-drift backstop. The engine, not the storyteller, owns who anyone
    // is; a card that renames somebody already in the cast would fork them
    // into a second relationship with its own closeness score, because the
    // map is keyed by name. Same treatment as a mode violation: drop the one
    // card, keep its neighbours, let the caller retry if too few survive.
    if (relationships) {
      const drift = checkNameDrift(res.scenario, relationships);
      if (drift.length) {
        rejectedForNameDrift += 1;
        errors.push(`scenario[${i}]: name drift (${drift.join('; ')})`);
        return;
      }
    }
    // Craft drift on a surviving major card is logged, never rejected: the
    // per-field budgets live in the prompt, and this measures how well they
    // hold rather than punishing a playable card for missing them.
    if (res.scenario.weight === 'major') {
      for (const w of narrativeWarnings(res.scenario)) warnings.push(`scenario[${i}]: ${w}`);
    }
    // Spelling-convention drift, log-only across every tier: the house style
    // is American English throughout, and this is a style signal, not a
    // validity check, same as the major-tier craft warnings above.
    const spellingText = [displayText(res.scenario), res.scenario.leftLabel, res.scenario.rightLabel]
      .filter(Boolean).join(' ');
    for (const w of britishSpellingWarnings(spellingText)) warnings.push(`scenario[${i}]: ${w}`);
    // Off-screen reintroduction, across ALL tiers: a named relationship that
    // dropped out of the recent-history window and comes back on a bare name,
    // with no role reminder to place them. Log-only, like the drift above.
    if (relationships) {
      for (const w of checkReintroductions(res.scenario, relationships, recentText)) {
        warnings.push(`scenario[${i}]: ${w}`);
      }
    }
    scenarios.push(res.scenario);
  });

  return { ok: scenarios.length >= minValid, scenarios, errors, warnings, rejectedForMode, rejectedForNameDrift };
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}
