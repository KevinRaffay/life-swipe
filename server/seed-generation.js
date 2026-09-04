// Bulk, offline authoring of seed-deck CANDIDATES for coverage-thin buckets.
//
// This calls the exact same storyteller prompt (server/prompt.js) and the
// exact same validators (shared/schema.js, shared/content.js) that
// /api/scenarios uses for live play - directly, not through that endpoint,
// and never for a real player. What is different from live generation is the
// STATE it generates against: there is no player, so a plausible generic
// snapshot for the bucket's age range stands in, and unlike a real life's
// state it carries no "already named" cast beyond Mom and Dad, because a seed
// card is reused across many different lives and can never hardcode a name
// one throwaway sample state happened to draw (see buildGenericSampleState).
//
// Shared by scripts/generate-seed-scenarios.js (CLI, big batch runs) and the
// admin module's "Generate seeds" tab (server/admin/index.js's
// /api/generate-seeds) - the same relationship server/extraction.js has to
// scripts/extract-patterns.js and the admin's /api/extract.
//
// What this module does NOT do, ever: write to data/scenarios-seed.json, or
// touch the live generation path. It only produces DRAFTS; a person decides
// what enters the seed deck (server/admin/index.js's seed-draft approve
// route, or a human editing scenarios-seed.draft.json by hand).

import { complete, extractJson, hasKey } from './provider.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { validateBatch } from '../shared/schema.js';
import { checkCompliance, effectiveTier } from '../shared/content.js';
import { narrativeWarnings } from '../shared/scenario-format.js';
import { NAME_TAG } from '../shared/names.js';
import { createState, stateSummary } from '../shared/engine.js';
import { filterPatterns, RARITY_WEIGHT } from '../shared/library.js';
import { GENERATED } from '../shared/provenance.js';
import { BUCKETS, coverage } from '../scripts/coverage.js';

export { BUCKETS };

// Roughly double the bare coverage target (scripts/coverage.js's TARGET_FIRST
// / TARGET_OTHER), so a review pass that rejects some candidates still leaves
// the bucket covered.
export const DEFAULT_TARGET_FIRST = 15;
export const DEFAULT_TARGET_OTHER = 8;

/* ------------------------------------------------------- sample state ---- */

// A plausible age-appropriate snapshot per bucket. There is no played history
// behind these numbers - they only exist to give the storyteller prompt's
// STATE block something realistic to write against, the way a form field
// does for the admin preview (server/admin/preview.js's buildSampleState).
const BUCKET_PROFILES = {
  highschool: { money: [50, 600], health: [70, 95], happiness: [55, 85], career: { title: 'High School Student', salary: 0 }, education: 'High school (in progress)', flags: ['lives_with_parents', 'in_school'] },
  college: { money: [200, 4000], health: [65, 90], happiness: [50, 80], career: { title: 'Part-Time Barista', salary: 9000 }, education: 'Some college', flags: ['in_school'] },
  early: { money: [1000, 25000], health: [65, 90], happiness: [50, 80], career: { title: 'Marketing Coordinator', salary: 42000 }, education: "Bachelor's degree", flags: [] },
  family: { money: [5000, 90000], health: [55, 85], happiness: [45, 75], career: { title: 'Operations Manager', salary: 68000 }, education: "Bachelor's degree", flags: ['married'] },
  late: { money: [10000, 180000], health: [45, 80], happiness: [45, 75], career: { title: 'Senior Analyst', salary: 82000 }, education: "Bachelor's degree", flags: ['married'] },
  retirement: { money: [5000, 220000], health: [35, 75], happiness: [40, 80], career: { title: 'Retired', salary: 0 }, education: "Bachelor's degree", flags: ['retired'] },
};

// A card set only for career-plausibility (server/prompt.js's CAREER
// PLAUSIBILITY block); rolled in about half the time for adult buckets so
// roughly as many generated cards can plausibly reach for a white-collar
// beat as a played life would have earned by that age.
const CAREER_BACKGROUND_POOL = ['college_degree', 'trade_cert', 'white_collar_experience'];

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1));
const randPick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function sampleAge(bucket) {
  const [lo, hiRaw] = bucket.range;
  // The retirement bucket's upper bound (110) is a mortality ceiling, not a
  // realistic sampling range for "what does a typical card-worthy age look
  // like" - cap it well short of that.
  const hi = bucket.id === 'retirement' ? Math.min(hiRaw, 92) : hiRaw;
  const upper = Math.max(Math.ceil(lo), Math.ceil(hi) - 1);
  return randInt(Math.ceil(lo), upper);
}

/**
 * A believable, ownerless game state for one bucket/mode - built from the
 * real engine (createState + overrides) so the prompt sees exactly the shape
 * stateSummary() actually produces, the same guarantee preview.js's
 * buildSampleState gives the admin preview.
 *
 * The one deliberate departure from that helper: createState always assigns
 * the starting "best friend" a real name from the pool. That is correct for
 * one specific life; it is wrong here, because this state is a template
 * reused across many different lives and a card that hardcodes "Priya" would
 * be wrong the moment it is dealt to a life whose friend is named anything
 * else. So the cast is trimmed back to Mom and Dad - the one pair CLAUDE.md's
 * naming invariant already treats as pure address forms, never pool-assigned
 * - and the name ledger is cleared with it. Anyone else the model wants has
 * to be a fresh "{{new:role}}" tag, exactly as it would be for a brand-new
 * player.
 */
export function buildGenericSampleState(bucket, mode, { age = null } = {}) {
  const profile = BUCKET_PROFILES[bucket.id] || BUCKET_PROFILES.early;
  const sampledAge = Number.isFinite(age) ? age : sampleAge(bucket);
  const state = createState({
    seed: `seedgen-${bucket.id}-${mode}-${sampledAge}-${Math.random().toString(36).slice(2)}`,
    contentMode: mode,
  });
  state.ageMonths = sampledAge * 12;
  state.money = randInt(...profile.money);
  state.health = randInt(...profile.health);
  state.happiness = randInt(...profile.happiness);
  state.career = { ...profile.career };
  state.education = profile.education;

  const flags = new Set(profile.flags);
  if (bucket.id !== 'highschool' && Math.random() < 0.5) flags.add(randPick(CAREER_BACKGROUND_POOL));
  state.flags = [...flags];

  state.relationships = Object.fromEntries(
    Object.entries(state.relationships).filter(([, r]) => r.role === 'mother' || r.role === 'father'),
  );
  state.names = { byTag: {}, categories: {} };

  return state;
}

/* --------------------------------------------------------- weight mix ---- */

// "Majority minor, some standard, few major" (CLAUDE.md: "Most cards should
// be minor - that is what keeps the swipe rhythm"), unlike one live batch's
// own ~2/2/1 instruction to the model, which is a per-batch narrative mix,
// not the corpus-wide split a seed deck should end up with.
export function tierQuotas(targetRaw) {
  const target = Math.max(1, Math.round(targetRaw));
  const major = target >= 5 ? Math.max(1, Math.round(target * 0.1)) : (target >= 3 ? 1 : 0);
  let minor = Math.max(0, Math.round((target - major) * 0.65));
  let standard = target - minor - major;
  if (standard < 0) { minor += standard; standard = 0; }
  return { minor, standard, major };
}

/* ------------------------------------------------------- library slot ---- */

// Reuses the game's own eligibility rules (shared/library.js) rather than
// re-deriving them: a pattern is eligible for this sample exactly when it
// would be eligible for a real player in the same state.
function pickLibrarySlot(library, sampledAge, tier, flags, patternUse) {
  const state = { ageMonths: sampledAge * 12, contentMode: tier, flags };
  const { eligible } = filterPatterns(state, library || [], []);
  if (!eligible.length) return null;
  // Soft de-duplication within one run: a pattern used already this run is
  // still eligible, just less likely to be picked again.
  const weights = eligible.map((p) => (RARITY_WEIGHT[p.rarity] || 1) / (1 + (patternUse.get(p.id) || 0)));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < eligible.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}

/* --------------------------------------------------------- id + shape ---- */

function uniqueId(scenario, bucket, usedIds) {
  // Name tags out first. A prompt that opens "{{new:roommate}} has labelled
  // the milk" would otherwise produce the id "college_new_roommate_has" -
  // the markup, not the card. Harvested candidates lead with a tag far more
  // often than generated ones, since a live card is written around a cast
  // the player already has.
  const promptText = String(scenario.prompt || 'card').replace(NAME_TAG, ' ').trim() || 'card';
  const base = (bucket.id + '_' + promptText)
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .split('_').slice(0, 6).join('_').slice(0, 40) || (bucket.id + '_card');
  let id = base;
  let n = 2;
  while (usedIds.has(id)) id = `${base}_${n++}`;
  return id;
}

/**
 * Turn one validated scenario into a seed-deck-shaped record, matching the
 * fields hand-authored entries in data/scenarios-seed.json carry.
 *
 * Exported because the content harvester (server/harvest.js) shapes its
 * candidates identically - a harvested row and a generated row land in the
 * same queue and are approved by the same route, so they had better be the
 * same kind of object. `source` is the one thing that differs, and it is a
 * parameter for exactly that reason.
 */
export function shapeSeedRecord(scenario, { bucket, tier, sampledAge, usedIds, source = GENERATED }) {
  const id = uniqueId(scenario, bucket, usedIds);
  // Content generated under the safe tier is always fine in a mature life too
  // (mature is a superset); content generated under the mature tier only
  // widens to both if it happens not to trip the mature-content backstop.
  const modes = tier === 'safe'
    ? ['safe', 'mature']
    : (checkCompliance(scenario, { tier: 'safe', age: sampledAge }).ok ? ['safe', 'mature'] : ['mature']);
  const weight = scenario.weight === 'trivial' ? 'minor' : scenario.weight;

  const record = {
    id,
    stages: [bucket.id],
    life_stage: [...bucket.range],
    modes,
    weight,
    source,
  };
  for (const field of ['setting', 'beat', 'dialogue', 'prompt']) {
    if (scenario[field]) record[field] = scenario[field];
  }
  record.leftLabel = scenario.leftLabel;
  record.rightLabel = scenario.rightLabel;
  record.leftEffects = scenario.leftEffects || {};
  record.rightEffects = scenario.rightEffects || {};

  // Same craft-drift measurement live generation logs via validationWarnings
  // (server/llm.js -> finalizeLog), attached to the draft itself since there
  // is no per-call log record for an offline authoring run.
  const warnings = weight === 'major' ? narrativeWarnings(scenario) : [];
  if (warnings.length) record.validationWarnings = warnings;

  return record;
}

/* ------------------------------------------------------------- core ------ */

/**
 * Generate up to `target` accepted candidates for one bucket at one mode.
 * @returns {{ accepted: object[], batches: number, requested: number }}
 */
export async function generateForBucketMode({
  bucket, mode, target, library = [], existingIds = new Set(), onBatch = null, shouldStop = () => false,
}) {
  if (!hasKey()) {
    const err = new Error('ANTHROPIC_API_KEY is not set, so there is nothing to generate with.');
    err.status = 503;
    throw err;
  }

  const quotas = tierQuotas(target);
  const counts = { minor: 0, standard: 0, major: 0 };
  const accepted = [];
  const overflow = [];
  const usedIds = new Set(existingIds);
  const patternUse = new Map();
  const cap = Math.max(6, Math.ceil(target / 5) * 4);
  let batches = 0;
  let errors = 0;

  while (accepted.length < target && batches < cap && errors < 4 && !shouldStop()) {
    batches++;
    const sampledAge = sampleAge(bucket);
    const state = buildGenericSampleState(bucket, mode, { age: sampledAge });
    const summary = stateSummary(state);
    // Age beats mode (shared/content.js's effectiveTier), already resolved by
    // stateSummary/contentTier - a highschool sample generates as 'safe' no
    // matter which mode row asked for it.
    const tier = summary.tier;

    const slot = pickLibrarySlot(library, sampledAge, tier, summary.flags, patternUse);
    const system = buildSystemPrompt(tier);
    const user = buildUserPrompt({ summary, recent: [], count: 5, librarySlot: slot });

    let text;
    try {
      ({ text } = await complete({ system, user, prefill: '[', maxTokens: 4000, temperature: 1, timeoutMs: 60000 }));
    } catch (err) {
      errors++;
      if (onBatch) onBatch({ batch: batches, error: err.message });
      continue;
    }

    const parsed = extractJson(text);
    const { scenarios } = validateBatch(parsed, { minValid: 0, tier, age: sampledAge });
    if (slot) patternUse.set(slot.id, (patternUse.get(slot.id) || 0) + 1);

    for (const scenario of scenarios) {
      const record = shapeSeedRecord(scenario, { bucket, tier, sampledAge, usedIds });
      usedIds.add(record.id);
      const tierName = record.weight;
      if (counts[tierName] < quotas[tierName] && accepted.length < target) {
        accepted.push(record);
        counts[tierName]++;
      } else {
        overflow.push(record);
      }
    }
    if (onBatch) onBatch({ batch: batches, tier, slot: slot ? slot.id : null, produced: scenarios.length });
  }

  // Backfill from overflow, ignoring the mix quota, so a run that is short on
  // one tier still lands as close to `target` as the model actually gave us.
  for (const record of overflow) {
    if (accepted.length >= target) break;
    accepted.push(record);
  }

  return { accepted: accepted.slice(0, target), batches, requested: target };
}

/**
 * The (bucket, mode) pairs npm run coverage would flag as short - or, with
 * `force`, every pair matching `mode` regardless of whether it is short. A
 * bucket sitting exactly at target is technically "covered" but often still
 * thin in practice (the bare minimum is 4 cards), so an author may want more
 * even when the coverage script itself has nothing to complain about.
 */
export function shortBucketModePairs(seeds, { mode = 'both', force = false } = {}) {
  const wantModes = mode === 'both' ? ['safe', 'mature'] : [mode];
  return coverage(seeds).filter((r) => (force || r.short) && wantModes.includes(r.mode));
}

/**
 * Generate drafts for every thin bucket/mode pair matching `mode` - or, with
 * `force`, for every pair matching `mode` regardless of current coverage.
 * @returns {{ bucket, mode, target, batches, accepted }[]}
 */
export async function generateSeedDrafts({
  seeds, library = [], mode = 'both', target = null, force = false,
  existingIds = new Set(), onBucket = null, onBatch = null, shouldStop = () => false,
}) {
  if (!hasKey()) {
    const err = new Error('ANTHROPIC_API_KEY is not set, so there is nothing to generate with.');
    err.status = 503;
    throw err;
  }

  const pairs = shortBucketModePairs(seeds, { mode, force });
  const allIds = new Set([...existingIds, ...seeds.map((s) => s.id)]);
  const results = [];
  const seenJobs = new Set();

  for (const row of pairs) {
    if (shouldStop()) break;
    const bucket = BUCKETS.find((b) => b.id === row.bucket);
    // Age beats mode: a highschool life is always safe-tier regardless of
    // which mode row is short, so a safe/mature pair for this one bucket
    // would otherwise generate the identical job twice.
    const resolvedMode = bucket.id === 'highschool' ? 'safe' : row.mode;
    const jobKey = bucket.id + '/' + resolvedMode;
    if (seenJobs.has(jobKey)) continue;
    seenJobs.add(jobKey);

    const bucketTarget = target || (bucket.first ? DEFAULT_TARGET_FIRST : DEFAULT_TARGET_OTHER);
    if (onBucket) {
      onBucket({
        bucket: bucket.id, mode: resolvedMode, target: bucketTarget, current: row.count,
        note: resolvedMode !== row.mode ? 'age beats mode: generating safe-tier content, which counts toward both modes' : null,
      });
    }

    const { accepted, batches } = await generateForBucketMode({
      bucket, mode: resolvedMode, target: bucketTarget, library, existingIds: allIds, onBatch, shouldStop,
    });
    for (const r of accepted) allIds.add(r.id);
    results.push({ bucket: bucket.id, mode: resolvedMode, target: bucketTarget, batches, accepted });
  }

  return results;
}
