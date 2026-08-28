// The deck sits between the storyteller and the referee.
//
// Contract: `draw(state)` is SYNCHRONOUS and never fails. It hands back the
// best available card right now - an LLM card if one is buffered, otherwise a
// hand-authored seed, otherwise a procedural fallback - and then quietly kicks
// off a background fetch. Swiping never waits on the network.

import { stageOf, STAGES, contentTier, canDealDarkCard, ageOf } from './engine.js';
import { checkCompliance, isMatureScenario } from './content.js';
import { makeFallbackScenario } from './fallback.js';
import { validateBatch } from './schema.js';
import { nextRandom } from './rng.js';

// Must stay smaller than the smallest per-stage pool, or every candidate ends
// up "recent" and the deck is forced to repeat itself.
const RECENT_MEMORY = 10;

const stageIndex = (id) => STAGES.findIndex((s) => s.id === id);

// How many stages behind the player a card was written for.
// 0 = written for right now, 1 = written one stage ago, -1 = written ahead.
function stagesBehind(card, state) {
  if (!card.stages || !card.stages.length) return 0;
  const now = stageIndex(stageOf(state).id);
  const best = card.stages
    .map(stageIndex)
    .filter((i) => i !== -1)
    .reduce((min, i) => Math.min(min, Math.abs(now - i) === 0 ? 0 : now - i), Infinity);
  return best === Infinity ? 0 : best;
}

// A generated batch takes ~20s to write, and the early game can cross a stage
// boundary in fewer swipes than that. Requiring an exact stage match threw away
// every batch on arrival, so LLM cards get one stage of grace. Hand-authored
// seeds stay strict - they know where they belong.
const STAGE_GRACE = 1;

export class Deck {
  /**
   * @param {object}   opts
   * @param {Array}    opts.seedScenarios  hand-authored cards (scenarios-seed.json)
   * @param {Function} [opts.fetchBatch]   async (state) => raw scenario array
   * @param {number}   [opts.lookahead]    refill when buffer drops below this
   *   (a live batch takes ~20s, so keep this well above one swipe of runway)
   */
  constructor({ seedScenarios = [], fetchBatch = null, lookahead = 6, onLibrarySlot = null } = {}) {
    this.seeds = validateBatch(seedScenarios).scenarios.map((s) => ({ ...s, source: 'seed' }));
    this.fetchBatch = fetchBatch;
    // Returns a pattern to brief the storyteller with, or null for free generation.
    this.onLibrarySlot = onLibrarySlot;
    this.lookahead = lookahead;
    this.buffer = [];
    this.recentIds = [];
    this.usedSeedIds = new Set();
    this.inFlight = null;
    this.lastError = null;
    this.dealt = 0;
    this.stats = { seed: 0, llm: 0, fallback: 0, fetches: 0, failures: 0, pruned: 0 };
  }

  eligible(scenario, state) {
    if (this.recentIds.includes(scenario.id)) return false;

    // Content mode gate. A mature card needs three things at once: a mature
    // tier (which already resolves the under-18 rule), an unspent arc budget,
    // and a clean compliance check. Any one of them failing hides the card.
    if (isMatureScenario(scenario)) {
      if (contentTier(state) !== 'mature') return false;
      if (!canDealDarkCard(state)) return false;
    }
    const compliance = checkCompliance(scenario, {
      tier: contentTier(state),
      age: ageOf(state),
    });
    if (!compliance.ok) return false;
    const age = ageOf(state);
    if (Number.isFinite(scenario.minAge) && age < scenario.minAge) return false;
    if (Number.isFinite(scenario.maxAge) && age > scenario.maxAge) return false;

    const stage = stageOf(state).id;
    const strict = scenario.source === 'seed';
    if (scenario.stages && scenario.stages.length) {
      if (strict && !scenario.stages.includes(stage)) return false;
      if (!strict) {
        const behind = stagesBehind(scenario, state);
        if (behind < 0 || behind > STAGE_GRACE) return false;
      }
    }
    if (scenario.requiresFlags && !scenario.requiresFlags.every((f) => state.flags.includes(f))) return false;
    if (scenario.forbidsFlags && scenario.forbidsFlags.some((f) => state.flags.includes(f))) return false;
    return true;
  }

  // A buffered card whose stage has passed can never become eligible again -
  // age only moves one way. Left in place it makes the deck believe it is well
  // stocked, so refill never fires and the player silently drops to fallbacks
  // for the rest of the run.
  prune(state) {
    const before = this.buffer.length;
    this.buffer = this.buffer.filter((c) => {
      const behind = stagesBehind(c, state);
      return behind >= 0 && behind <= STAGE_GRACE;
    });
    this.stats.pruned += before - this.buffer.length;
  }

  // Cards that could still be dealt in this stage. Recency is deliberately
  // ignored here: a card blocked by the rolling window today is stock tomorrow.
  stocked(state) {
    return this.buffer.filter((c) =>
      (stagesBehind(c, state) >= 0 && stagesBehind(c, state) <= STAGE_GRACE) &&
      (!c.requiresFlags || c.requiresFlags.every((f) => state.flags.includes(f))) &&
      (!c.forbidsFlags || !c.forbidsFlags.some((f) => state.flags.includes(f)))
    ).length;
  }

  draw(state) {
    this.prune(state);
    let card = null;

    // 1. Anything the storyteller wrote for this moment.
    const idx = this.buffer.findIndex((c) => this.eligible(c, state));
    if (idx !== -1) {
      card = this.buffer.splice(idx, 1)[0];
      this.stats.llm++;
    }

    // 2. Hand-authored seeds - these carry the early-life arc and the Sam thread.
    //    Picked at random from everything eligible, not first-in-file: taking
    //    the first match made every run open with the same four cards, since
    //    the storyteller's first batch does not land for ~20 seconds.
    //    nextRandom draws from the run's own seeded RNG, so a given seed still
    //    replays exactly.
    if (!card) {
      const pool = this.seeds.filter((s) => !this.usedSeedIds.has(s.id) && this.eligible(s, state));
      if (pool.length) {
        // Some seeds are structural rather than flavour - the college fork sets
        // in_school, the first-job card sets a salary. Ordinary cards shuffle
        // freely, but a pending structural card outranks them, so the economy
        // still gets established no matter how the shuffle falls.
        const top = Math.max(...pool.map((c) => c.priority || 0));
        const tier = pool.filter((c) => (c.priority || 0) === top);
        const seed = tier[Math.floor(nextRandom(state) * tier.length)] || tier[0];
        this.usedSeedIds.add(seed.id);
        card = seed;
        this.stats.seed++;
      }
    }

    // 3. Never return nothing.
    if (!card) {
      card = makeFallbackScenario(state, { recentIds: this.recentIds, stageId: stageOf(state).id });
      this.stats.fallback++;
    }

    this.remember(card.id);
    this.maybeRefill(state);
    // uid is per-deal; id is per-scenario. The card stack keys off uid so a
    // repeated scenario still counts as a new card.
    return { ...card, uid: ++this.dealt };
  }

  remember(id) {
    this.recentIds.push(id);
    if (this.recentIds.length > RECENT_MEMORY) this.recentIds.shift();
  }

  ready() {
    return this.buffer.length;
  }

  // Fire-and-forget. Errors are swallowed on purpose: a failed fetch just means
  // the next draw comes from seeds or fallbacks, which is a fine game.
  maybeRefill(state) {
    if (!this.fetchBatch || this.inFlight) return;
    if (this.stocked(state) >= this.lookahead) return;

    this.stats.fetches++;
    this.inFlight = Promise.resolve()
      .then(() => this.fetchBatch(state, this.onLibrarySlot ? this.onLibrarySlot(state) : null))
      .then((raw) => {
        const { scenarios } = validateBatch(raw || [], {
          tier: contentTier(state),
          age: ageOf(state),
        });
        const stage = stageOf(state).id;
        for (const s of scenarios) {
          if (this.recentIds.includes(s.id)) continue;
          this.buffer.push({ ...s, stages: s.stages || [stage] });
        }
        this.lastError = scenarios.length ? null : 'empty batch';
        if (!scenarios.length) this.stats.failures++;
      })
      .catch((err) => {
        this.stats.failures++;
        this.lastError = err && err.message ? err.message : String(err);
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  // Await the current fetch, if any. Only used by tests and the start screen.
  async settle() {
    if (this.inFlight) await this.inFlight;
    return this.buffer.length;
  }
}

export default Deck;
