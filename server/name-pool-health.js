// Pool-health measurements shared by the CLI (`npm run names`) and the
// admin's Name Pool health panel - one measurement, read two ways, the same
// relationship server/extraction.js has to its CLI and admin callers.
//
// Advisory only: nothing here blocks an admin save, and scripts/name-check.js
// decides for itself which of these numbers it is willing to treat as a hard
// failure for `npm run names` - today, none of them are, because every one
// can only fire after deliberate pool-wide deactivation, never from the
// pool's own shipped content.

import { eraOk, genderOk, isNameEligible } from '../shared/names.js';
import { BAL } from '../shared/balance.js';

const MAX_CATEGORY_SHARE = 0.08;

// The category every SSA-sourced name lands in when scripts/name-categories.json
// has nothing more specific to say - see scripts/build-name-pool.js's
// FALLBACK_CATEGORY, which this must agree with.
//
// It is EXEMPT from the share cap, and that is not a fudge. The cap exists to
// catch one origin accidentally swamping the pool. Since the pool is generated
// from real birth records, the default bucket legitimately holds most of it
// (~64%), because most of the SSA top-N really is mainstream American naming
// stock. Flagging that every single run would be a permanent false warning,
// and this project has already learned what those cost: the harvester's
// anonymity sweep flagged Tuesday, Kmart and Dad until nobody read it. The cap
// stays sharp for every other category, where it still means something.
const FALLBACK_CATEGORY = 'anglo';

// A birth-year sweep wide enough to cover every role this game ever names -
// the oldest grandparent of a 16-year-old down to a newborn late in a long
// mature life - at a resolution fine enough to catch a gap a decade-only
// sweep could straddle.
const ERA_SWEEP_START = 1900;
const ERA_SWEEP_END = BAL.PRESENT_YEAR + 5;
const ERA_SWEEP_STEP = 5;

/**
 * @param {object} args
 * @param {Array} args.pool       the parsed name-pool.json array
 * @param {object} args.controls  the parsed name-pool-controls.json object
 */
export function computeNamePoolHealth({ pool, controls }) {
  const safeControls = controls || {};
  const total = pool.length;

  const seenNames = new Map();
  const duplicateNames = [];
  const categoryCounts = new Map();
  for (const entry of pool) {
    const key = String(entry.name || '').toLowerCase();
    if (key) {
      if (seenNames.has(key)) duplicateNames.push(entry.name);
      else seenNames.set(key, true);
    }
    categoryCounts.set(entry.category, (categoryCounts.get(entry.category) || 0) + 1);
  }

  const deactivatedCategories = (safeControls.deactivatedCategories || []).map((c) => c.category);
  const deactivatedRegions = (safeControls.deactivatedRegions || []).map((r) => r.region);
  const deactivatedGenderAssocs = (safeControls.deactivatedGenderAssocs || []).map((g) => g.genderAssoc);
  const deactivatedCategorySet = new Set(deactivatedCategories);

  const categorySpread = [...categoryCounts.entries()]
    .map(([category, count]) => ({
      category,
      count,
      share: count / total,
      overrepresented: category !== FALLBACK_CATEGORY && count / total > MAX_CATEGORY_SHARE,
      deactivated: deactivatedCategorySet.has(category),
    }))
    .sort((a, b) => b.count - a.count);

  const inactive = pool.filter((e) => e.active === false).length;
  const eligible = pool.filter((e) => isNameEligible(e, safeControls)).length;

  // Era coverage: any 20-year window across the sweep with zero authored
  // names at all. Deliberately independent of deactivation - this is a
  // question about the pool's own authored span, not about today's controls.
  const eraCoverageGaps = [];
  for (let year = ERA_SWEEP_START; year <= ERA_SWEEP_END; year += 20) {
    const hi = year + 19;
    const covering = pool.filter((e) => e.era_start <= hi && (!Number.isFinite(e.era_end) || e.era_end >= year));
    if (!covering.length) eraCoverageGaps.push(`${year}-${hi}`);
  }

  // Would a plausible era+gender combination ever reach the engine's last
  // resort (reusing a name already in play)? Region is deliberately NOT part
  // of this sweep: shared/names.js's regionalWeight only ever weights among
  // already-eligible candidates, so a region - deactivated or not - can never
  // by itself change which era+gender combinations are empty. Sweeping every
  // region here would just repeat the same result 50 times over.
  const zeroCandidateWarnings = [];
  for (let year = ERA_SWEEP_START; year <= ERA_SWEEP_END; year += ERA_SWEEP_STEP) {
    for (const want of [null, 'f', 'm']) {
      const matches = pool.filter((e) => isNameEligible(e, safeControls) && eraOk(e, year) && genderOk(e, want));
      if (!matches.length) zeroCandidateWarnings.push({ year, want: want || 'any' });
    }
  }

  return {
    total,
    active: total - inactive,
    inactive,
    eligible,
    duplicateNames,
    categoriesTotal: categoryCounts.size,
    categorySpread,
    deactivatedCategories,
    deactivatedRegions,
    deactivatedGenderAssocs,
    eraCoverageGaps,
    zeroCandidateWarnings,
  };
}
