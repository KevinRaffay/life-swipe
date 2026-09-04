// Live preview: what does the storyteller actually write for this pattern?
//
// Every part of this is the REAL path - the same system prompt, the same user
// prompt, the same Anthropic client, the same validator the deck runs. Nothing
// here reimplements generation, and nothing here can reach a player: the sample
// state is built fresh in memory, is never persisted, and no file is written.
//
// The one thing preview does that normal play does not is show you the failures.
// /api/scenarios silently drops cards that fail validation, which is correct for
// a game and useless for authoring, so this returns the raw model text and a
// per-card pass/fail carrying the validator's own error strings.

import { complete, extractJson, hasKey, MODEL } from '../provider.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompt.js';
import { validateScenario } from '../../shared/schema.js';
import { effectiveTier } from '../../shared/content.js';
import {
  createState, stateSummary, normalizeEffects, contentTier, timeCostMonths,
} from '../../shared/engine.js';
import { resolveBatchEphemeral } from '../../shared/names.js';
import { BAL } from '../../shared/balance.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A believable game state from a handful of form fields.
 *
 * Built by calling the engine's own createState and then overriding, rather
 * than hand-assembling a summary object: a hand-made lookalike drifts from what
 * stateSummary actually produces, and then the preview stops predicting the
 * real thing, which is its only job.
 */
export function buildSampleState({
  age = 24, money = 5000, health = 80, happiness = 65,
  flags = [], contentMode = 'safe', career = null, education = null, seed = 'admin-preview',
} = {}) {
  const state = createState({ seed, contentMode: contentMode === 'mature' ? 'mature' : 'safe' });
  state.ageMonths = clamp(Number(age) || 24, 16, BAL.MAX_AGE) * 12;
  state.money = Number.isFinite(Number(money)) ? Number(money) : 0;
  state.health = clamp(Number(health) || 0, 0, 100);
  state.happiness = clamp(Number(happiness) || 0, 0, 100);
  if (Array.isArray(flags)) {
    state.flags = [...new Set(flags.map((f) => String(f).trim()).filter(Boolean))].slice(0, BAL.CLAMP.maxFlags);
  }
  if (career && typeof career === 'object') {
    if (career.title) state.career.title = String(career.title).slice(0, 60);
    if (Number.isFinite(Number(career.salary))) state.career.salary = Number(career.salary);
  }
  if (education) state.education = String(education).slice(0, 60);
  return state;
}

/** The in-game calendar year, which is derived from age and has no field of its own. */
export const yearFor = (age) => BAL.PRESENT_YEAR + (Number(age) || 16) - (BAL.START.ageMonths / 12);

/**
 * Generate from a library pattern, down the real path.
 * @returns {{ raw, cards, summary, tier, model, ms, prompts }}
 */
export async function previewPattern(pattern, sample = {}, { count = 3, region = null } = {}) {
  if (!hasKey()) {
    const err = new Error('ANTHROPIC_API_KEY is not set, so there is nothing to generate with.');
    err.status = 503;
    throw err;
  }
  const state = buildSampleState(sample);
  const summary = stateSummary(state);
  // Resolved from age and mode exactly as the game server does, so a preview of
  // a 16-year-old cannot show mature content just because the form asked for it.
  const tier = effectiveTier({ age: summary.age, contentMode: summary.contentMode });

  const system = buildSystemPrompt(tier);
  const user = buildUserPrompt({
    summary: { ...summary, tier },
    recent: [],
    count,
    librarySlot: pattern || null,
  });

  const t0 = Date.now();
  const { text } = await complete({ system, user, prefill: '[', maxTokens: 4000, temperature: 1 });
  const parsed = extractJson(text);

  // Per-card pass/fail, keeping the failures. This is the whole point.
  const items = Array.isArray(parsed) ? parsed : [];
  let cards = items.map((item, i) => {
    const result = validateScenario(item, i);
    return {
      index: i,
      ok: result.ok,
      errors: result.errors || [],
      scenario: result.scenario || null,
      rawCard: item,
    };
  });

  // Names resolve through the ephemeral path, so a preview never consumes a
  // name from, or writes to, any real player's ledger.
  const valid = cards.filter((c) => c.ok).map((c) => c.scenario);
  if (valid.length) {
    const { scenarios: named } = resolveBatchEphemeral(valid, {
      relationships: Object.fromEntries(
        summary.relationships.map((r) => [r.name, { role: r.role }]),
      ),
      kids: summary.kids,
      age: summary.age,
      region,
      seedInput: { preview: pattern ? pattern.id : 'free', age: summary.age },
    });
    let n = 0;
    cards = cards.map((c) => (c.ok ? { ...c, scenario: named[n++] } : c));
  }

  return {
    raw: text,
    cards,
    summary,
    tier,
    model: MODEL,
    ms: Date.now() - t0,
    prompts: { system, user },
  };
}

/**
 * A seed is already a written card, so there is nothing to generate. What is
 * worth seeing is whether it still validates and what the engine would do to
 * its numbers against this state - which is where authored cards usually
 * surprise you, because the clamps depend on age, income and net worth.
 */
export function previewSeed(card, sample = {}) {
  const state = buildSampleState(sample);
  const result = validateScenario(card, 0);
  const scenario = result.scenario || null;

  const sides = {};
  if (scenario) {
    for (const side of ['leftEffects', 'rightEffects']) {
      const proposed = scenario[side] || {};
      const clamped = normalizeEffects(proposed, state);
      sides[side] = {
        proposed,
        clamped,
        // Named explicitly: these are the numbers the referee would actually
        // apply, not the ones the card asked for.
        changed: Object.keys(clamped).filter((k) =>
          JSON.stringify(clamped[k]) !== JSON.stringify(proposed[k])),
        months: timeCostMonths(scenario, clamped, state),
      };
    }
  }

  return {
    ok: result.ok,
    errors: result.errors || [],
    scenario,
    sides,
    summary: stateSummary(state),
    tier: contentTier(state),
  };
}
