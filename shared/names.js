// Who the new person is, decided by the engine.
//
// The storyteller used to invent names freely, which cost us two things: it
// drifted (the spouse named on one card was renamed three cards later, and
// since `state.relationships` is keyed by name that quietly created a SECOND
// spouse), and it converged on the same narrow band of names life after life.
//
// So naming joins everything else that matters: the model proposes a role tag,
// the referee decides who that is. The model writes "{{new:roommate}}"; this
// module picks a name from a curated pool, filtered for era plausibility and
// sampled so no single cultural origin can dominate one life, and then the
// name never changes again.
//
// Nothing here imports engine.js - the engine's tag guard imports THIS file,
// and a cycle between the two would be a genuinely miserable bug. Anything
// this module needs from live state arrives as a parameter.

import { BAL } from './balance.js';
// A relative path with an import attribute rather than a bundler alias: this
// module runs in the browser, in the server and in the simulator, and only one
// of those three knows what "@names" means.
import NAME_POOL from '../server/name-pool.json' with { type: 'json' };
import { seedFrom, nextRandom } from './rng.js';

export { NAME_POOL };

/* -------------------------------------------------------------- the tag */

// Two forms, both resolved the same way - what differs is who writes them.
//
//   {{new:roommate}}     the STORYTELLER introducing someone new. The role is
//                        all the identity there is, so "{{new:roommate#2}}" is
//                        how a life gets a second roommate on purpose.
//   {{cast:sam}}         an AUTHORED recurring character, in the seed deck.
//                        The id is the identity and it does not move, which
//                        matters because Sam is a roommate at 19, a partner at
//                        21 and a spouse at 27 - one person, three roles. A
//                        role-derived key would make them three people.
//                        The id doubles as the age/gender hint, so an id that
//                        is not role-shaped ("sam", "dev") names a peer of
//                        unfixed gender - which is what every authored cast
//                        member happens to be. Give a cast member a parent or
//                        a boss and the id needs the role word in it.
export const NAME_TAG = /\{\{\s*(new|cast)\s*:\s*([A-Za-z0-9 _#'-]{1,48}?)\s*\}\}/g;

/** Cheap pre-check, so the common case (no tags at all) costs one indexOf. */
export const hasNameTag = (text) => typeof text === 'string' && text.includes('{{');

/** Ledger keys for authored cast are namespaced, so they cannot collide. */
export const castKey = (id) => 'cast:' + String(id || '').toLowerCase().trim().replace(/[\s_]+/g, ' ');

/**
 * Split a tag into the ledger key and the role to name against.
 *   ('new',  'Roommate #2') -> { key: 'roommate#2',    role: 'roommate' }
 *   ('cast', 'best friend') -> { key: 'cast:best friend', role: 'best friend' }
 */
export function parseTag(raw, kind = 'new') {
  const body = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, ' ')
    .slice(0, 48);
  const cleaned = body.replace(/\s*#\s*/, '#');
  const role = cleaned.split('#')[0].trim() || 'someone';
  return kind === 'cast'
    ? { key: castKey(cleaned) , role }
    : { key: cleaned || 'someone', role };
}

/* ------------------------------------------------------------ role hints */

// How much OLDER than the player this role usually is, and whether the role
// fixes a gender. Longest key wins, so "grandson" is not read as "son".
// Anything unlisted is treated as a peer of unfixed gender, which is the right
// default for the roles the storyteller reaches for most: friend, roommate,
// coworker, rival, neighbour.
export const ROLE_HINTS = {
  'granddaughter': { ageOffset: -50, gender: 'f' },
  'grandson':      { ageOffset: -50, gender: 'm' },
  'grandmother':   { ageOffset: 55,  gender: 'f' },
  'grandfather':   { ageOffset: 55,  gender: 'm' },
  'grandparent':   { ageOffset: 55 },
  'grandma':       { ageOffset: 55,  gender: 'f' },
  'grandpa':       { ageOffset: 55,  gender: 'm' },
  'stepmother':    { ageOffset: 28,  gender: 'f' },
  'stepfather':    { ageOffset: 28,  gender: 'm' },
  'stepdaughter':  { ageOffset: -26, gender: 'f' },
  'stepson':       { ageOffset: -26, gender: 'm' },
  'mother':        { ageOffset: 28,  gender: 'f' },
  'father':        { ageOffset: 28,  gender: 'm' },
  'mom':           { ageOffset: 28,  gender: 'f' },
  'dad':           { ageOffset: 28,  gender: 'm' },
  'parent':        { ageOffset: 28 },
  'aunt':          { ageOffset: 25,  gender: 'f' },
  'uncle':         { ageOffset: 25,  gender: 'm' },
  'niece':         { ageOffset: -22, gender: 'f' },
  'nephew':        { ageOffset: -22, gender: 'm' },
  'daughter':      { ageOffset: -26, gender: 'f' },
  'son':           { ageOffset: -26, gender: 'm' },
  'child':         { ageOffset: -26 },
  'kid':           { ageOffset: -26 },
  'baby':          { ageOffset: -26 },
  'sister':        { ageOffset: 0,   gender: 'f' },
  'brother':       { ageOffset: 0,   gender: 'm' },
  'sibling':       { ageOffset: 0 },
  'wife':          { ageOffset: 0,   gender: 'f' },
  'husband':       { ageOffset: 0,   gender: 'm' },
  'girlfriend':    { ageOffset: 0,   gender: 'f' },
  'boyfriend':     { ageOffset: 0,   gender: 'm' },
  'professor':     { ageOffset: 22 },
  'teacher':       { ageOffset: 18 },
  'mentor':        { ageOffset: 18 },
  'landlord':      { ageOffset: 15 },
  'boss':          { ageOffset: 12 },
  'manager':       { ageOffset: 12 },
  'supervisor':    { ageOffset: 12 },
  'therapist':     { ageOffset: 12 },
  'doctor':        { ageOffset: 10 },
  'lawyer':        { ageOffset: 10 },
  'intern':        { ageOffset: -8 },
  'student':       { ageOffset: -6 },
};

const HINT_KEYS = Object.keys(ROLE_HINTS).sort((a, b) => b.length - a.length);

/** The hint for a role phrase - "college roommate" and "roommate" agree. */
export function hintFor(role) {
  const hay = String(role || '').toLowerCase();
  for (const key of HINT_KEYS) {
    if (new RegExp('(^|[^a-z])' + key + '([^a-z]|$)').test(hay)) return ROLE_HINTS[key];
  }
  return { ageOffset: 0 };
}

/* ------------------------------------------------------------ era window */

const START_AGE = BAL.START.ageMonths / 12;

/** The calendar year this life has reached. Anchored, never clock-read. */
export const currentYear = (age) => BAL.PRESENT_YEAR + (Number(age) || START_AGE) - START_AGE;

/**
 * Roughly when someone in this role was born, so the pool can be filtered for
 * plausibility. A newborn arriving in 2041 does not get a name that stopped
 * being given in 1978.
 */
export function impliedBirthYear(age, role) {
  const hint = hintFor(role);
  const playerAge = Number.isFinite(age) ? age : START_AGE;
  // Negative offsets mean younger; nobody is born before they exist.
  const theirAge = Math.max(0, playerAge + hint.ageOffset);
  return Math.round(currentYear(playerAge) - theirAge);
}

/* -------------------------------------------------------------- sampling */

const firstName = (full) => String(full || '').trim().split(/\s+/)[0].toLowerCase();

/** Every name this life has already spent, compared on the first name only. */
export function takenNames({ relationships = {}, kids = [], ledger = null } = {}) {
  const taken = new Set();
  const add = (n) => { const f = firstName(n); if (f) taken.add(f); };
  for (const key of Object.keys(relationships || {})) add(key);
  for (const kid of kids || []) add(typeof kid === 'string' ? kid : kid && kid.name);
  if (ledger && ledger.byTag) for (const n of Object.values(ledger.byTag)) add(n);
  return taken;
}

const eraOk = (entry, year) =>
  entry.era_start <= year && (!Number.isFinite(entry.era_end) || entry.era_end >= year);

const genderOk = (entry, want) =>
  !want || entry.gender_assoc === want || entry.gender_assoc === 'neutral';

/**
 * How much the player's region favours this name, as a multiplier on the draw.
 *
 * `region_frequency` holds a location quotient measured from SSA birth records
 * (see scripts/build-region-weights.js): 1 means "as common here as
 * nationally", 9 means nine times as common, 0.3 means a third as common.
 * Three things return exactly 1, the do-nothing value:
 *   - no region on the session (geolocation off, failed, or overridden to none)
 *   - a region the data cannot speak to (anywhere outside the US, and Florida,
 *     which is missing from the published archive)
 *   - a name with no entry for that region, which means no signal, NOT absence
 * The exponent damps the quotient and the ceiling caps it, so even the most
 * regionally concentrated name in the pool stays a tendency, not a certainty.
 */
export function regionalWeight(entry, region, {
  power = BAL.NAMES.regionPower,
  ceiling = BAL.NAMES.regionCeiling,
} = {}) {
  if (!region || !power) return 1;
  const table = entry && entry.region_frequency;
  if (!table) return 1;
  const lq = table[region];
  if (!Number.isFinite(lq) || lq <= 0) return 1;
  return Math.min(ceiling, Math.pow(lq, power));
}

/**
 * Pick a name.
 *
 * Category first, then a name inside it - NOT a uniform draw over the whole
 * pool. A uniform draw would hand out names in proportion to how many of each
 * origin the pool happens to contain, so the biggest categories would win
 * every life. Weighting by 1/(1+used)^1.5 makes an origin this life has
 * already used markedly less likely to come up again, which is what "diverse"
 * has to mean at the scale of a single playthrough.
 *
 * REGION is the second dimension, and it is a weight, never a filter. A name
 * carries a location quotient per region ("2.4x more common in Massachusetts
 * than nationally"); a name with nothing to say about a region, or a player
 * with no region at all, scores exactly 1 and is left alone. Nothing is ever
 * excluded for being regionally unusual - people move, and a pool that only
 * offered a Minnesotan Minnesotan names would be a worse lie than the one
 * this feature set out to fix.
 *
 * Degrades in a fixed order and never throws: draw() cannot fail (invariant 4).
 */
export function assignName({
  pool = NAME_POOL,
  role = 'someone',
  birthYear = BAL.PRESENT_YEAR,
  taken = new Set(),
  categoryUse = {},
  rng = Math.random,
  region = null,
} = {}) {
  const want = hintFor(role).gender;
  const free = (e) => !taken.has(firstName(e.name));

  const passes = [
    (e) => free(e) && eraOk(e, birthYear) && genderOk(e, want),
    (e) => free(e) && eraOk(e, birthYear),
    (e) => free(e) && genderOk(e, want),
    (e) => free(e),
  ];

  let candidates = [];
  for (const pass of passes) {
    candidates = pool.filter(pass);
    if (candidates.length) break;
  }
  // 187 names against a life that names a few dozen people at most, so this is
  // unreachable in practice - but a nameless card must never reach the player.
  if (!candidates.length) return null;

  const byCategory = new Map();
  for (const entry of candidates) {
    const list = byCategory.get(entry.category);
    if (list) list.push(entry);
    else byCategory.set(entry.category, [entry]);
  }

  // Region enters as a multiplier on both halves of the draw. It has to touch
  // the CATEGORY choice, not just the pick within one: categories hold three
  // to six names each, so weighting only inside them would move almost
  // nothing, and "more Somali names in Minnesota" is a statement about which
  // origins come up, not about which Somali name you get.
  const regionOf = (entry) => regionalWeight(entry, region);

  const categories = [...byCategory.keys()];
  const weights = categories.map((c) => {
    const members = byCategory.get(c);
    const diversity = 1 / Math.pow(1 + (categoryUse[c] || 0), 1.5);
    const affinity = members.reduce((sum, e) => sum + regionOf(e), 0) / members.length;
    return diversity * affinity;
  });
  const total = weights.reduce((a, b) => a + b, 0);

  let roll = rng() * total;
  let chosen = categories[categories.length - 1];
  for (let i = 0; i < categories.length; i++) {
    roll -= weights[i];
    if (roll <= 0) { chosen = categories[i]; break; }
  }

  // ...and again inside the chosen category, so Minnesota's Somali name is
  // more often the one Minnesota actually registers.
  const bucket = byCategory.get(chosen);
  const inner = bucket.map(regionOf);
  const innerTotal = inner.reduce((a, b) => a + b, 0);
  let pick = rng() * innerTotal;
  let entry = bucket[bucket.length - 1];
  for (let i = 0; i < bucket.length; i++) {
    pick -= inner[i];
    if (pick <= 0) { entry = bucket[i]; break; }
  }
  return { name: entry.name, category: entry.category, entry };
}

/* ------------------------------------------------------------ role groups */

// Role words that mean the same person, so "wife" and "spouse" are not two
// people. Used by both the resolver and the drift check.
const ROLE_GROUPS = {
  spouse:    ['spouse', 'husband', 'wife', 'partner', 'fiance', 'fiancee', 'fiancé', 'fiancée'],
  mother:    ['mother', 'mom', 'mum', 'mommy'],
  father:    ['father', 'dad', 'daddy'],
  sibling:   ['sibling', 'brother', 'sister'],
  child:     ['child', 'kid', 'son', 'daughter'],
  friend:    ['friend', 'best friend', 'close friend', 'old friend'],
  roommate:  ['roommate', 'housemate', 'flatmate'],
  boss:      ['boss', 'manager', 'supervisor'],
  coworker:  ['coworker', 'co-worker', 'colleague'],
  neighbour: ['neighbour', 'neighbor'],
  ex:        ['ex', 'ex-wife', 'ex-husband', 'ex-partner', 'ex-spouse'],
};

const GROUP_OF = new Map();
for (const [group, words] of Object.entries(ROLE_GROUPS)) {
  for (const word of words) GROUP_OF.set(word, group);
}

/** Canonical id for a role phrase, or the cleaned phrase when it is its own. */
export function roleGroup(role) {
  const hay = String(role || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (GROUP_OF.has(hay)) return GROUP_OF.get(hay);
  // "college roommate", "her ex-husband" - find the role word inside the phrase.
  for (const [word, group] of GROUP_OF) {
    if (new RegExp('(^|[^a-z])' + word.replace(/[-]/g, '\-') + '([^a-z]|$)').test(hay)) return group;
  }
  return hay;
}

// Roles a life holds ONE of at a time. A tag for one of these, when somebody
// already fills it, resolves to that person rather than conjuring a twin -
// that being the exact failure this feature exists to stop. Everything else
// (friend, coworker, classmate, rival, ex) is plural by nature and gets a
// fresh name every time, which is why the default is "assign new".
const SINGULAR_ROLES = new Set([
  'spouse', 'mother', 'father', 'boss', 'roommate', 'landlord', 'therapist',
  'grandmother', 'grandfather',
]);

/* ---------------------------------------------------------------- ledger */

// Tag -> name for one life, plus the tally of origins already spent, which is
// what the diversity weighting reads. Names already in use are derived from
// the relationships map rather than duplicated here - one source of truth.
export const createNameLedger = () => ({ byTag: {}, categories: {} });

/* ------------------------------------------------------------- resolving */

// Every field a name can appear in - which is not the same list as "the
// narrative fields". The two CHOICE LABELS are on it because a card is
// allowed to name somebody on a button ("Marry {{cast:sam}}"), and for a
// long time they were left off: the prompt read "Your roommate Zsofia has
// opinions" while the button underneath it still said
// "Be friends with {{cast:sam}}". Two seed cards shipped that way.
//
// Labels are NOT re-capped after resolution. validateScenario caps them at 40
// characters, and it runs before this does - so the tag was already counted
// against that budget. The longest name in the pool is 10 characters and the
// shortest possible tag is 9 ("{{new:x}}"), so resolving can grow a label by
// about a character per tag and no more. Slicing here to win that character
// back would cut somebody's name in half, which is a worse thing to put on a
// button than a slightly long label.
export const NAMED_FIELDS = ['setting', 'beat', 'dialogue', 'prompt', 'scenario', 'leftLabel', 'rightLabel'];

/**
 * Replace every "{{new:role}}" in a card with a real name.
 *
 * Over every field a name can sit in (NAMED_FIELDS, including the two choice
 * labels) plus a relationship's name inside either effects object.
 *
 * Deliberately does NOT write to the ledger it is given: it returns what it
 * assigned and lets the engine record it, so "only the engine writes state"
 * stays literally true. Within one card the assignments are still consistent,
 * because a local overlay sits in front of the ledger while resolving.
 *
 * @param {object} card
 * @param {object} opts
 * @param {object} opts.ledger        the life's tag -> name ledger (read only)
 * @param {object} opts.relationships the live relationships map
 * @param {Array}  opts.kids          so a character cannot be named after a kid
 * @param {number} opts.age           the player's age, for era plausibility
 * @param {Function} opts.rng         () => [0,1), the run's own RNG
 * @param {string}   [opts.region]    the player's region code, or null for none
 * @returns {{ card: object, assigned: Array }}
 */
export function resolveCardNames(card, {
  ledger = createNameLedger(),
  relationships = {},
  kids = [],
  age = START_AGE,
  rng = Math.random,
  pool = NAME_POOL,
  region = null,
} = {}) {
  const assigned = [];
  const pending = {};
  const taken = takenNames({ relationships, kids, ledger });
  const categoryUse = { ...(ledger.categories || {}) };

  const resolve = (raw, kind) => {
    const { key, role } = parseTag(raw, kind);
    const known = pending[key] || (ledger.byTag || {})[key];
    if (known) return known;

    // Somebody already fills this role and only one person can - use them.
    // Authored cast are exempt: their id IS their identity, so a card that
    // says {{cast:sam}} means Sam even when a spouse already exists.
    if (kind !== 'cast' && !key.includes('#') && SINGULAR_ROLES.has(roleGroup(role))) {
      const group = roleGroup(role);
      for (const [name, rel] of Object.entries(relationships || {})) {
        if (rel && roleGroup(rel.role) === group) {
          pending[key] = name;
          return name;
        }
      }
    }

    const picked = assignName({
      pool,
      role,
      birthYear: impliedBirthYear(age, role),
      taken,
      categoryUse,
      rng,
      region,
    });
    // A pool with nothing left to give is not a reason to show the player a
    // card with braces in it; fall back to the role itself, capitalised.
    const name = picked ? picked.name : role.replace(/(^|\s)([a-z])/g, (m, s, c) => s + c.toUpperCase());
    if (picked) categoryUse[picked.category] = (categoryUse[picked.category] || 0) + 1;
    taken.add(firstName(name));
    pending[key] = name;
    assigned.push({ key, role, name, category: picked ? picked.category : null });
    return name;
  };

  const swap = (text) => (hasNameTag(text)
    ? String(text).replace(NAME_TAG, (_m, kind, body) => resolve(body, kind.toLowerCase()))
    : text);

  const out = { ...card };
  for (const field of NAMED_FIELDS) {
    if (typeof out[field] === 'string') out[field] = swap(out[field]);
  }
  for (const side of ['leftEffects', 'rightEffects']) {
    const eff = out[side];
    if (!eff || !eff.relationship || typeof eff.relationship.name !== 'string') continue;
    const name = swap(eff.relationship.name);
    if (name !== eff.relationship.name) {
      out[side] = { ...eff, relationship: { ...eff.relationship, name } };
    }
  }
  return { card: out, assigned };
}

/**
 * A ledger and RNG for naming OUTSIDE a real player context - the admin live
 * preview, where there is sample state and no player to write to. Seeded from
 * the request so one preview is reproducible, and thrown away afterwards.
 */
export function ephemeralNameContext(seedInput) {
  const holder = { rngState: seedFrom(JSON.stringify(seedInput ?? 'preview')) };
  return { ledger: createNameLedger(), rng: () => nextRandom(holder) };
}

/**
 * Resolve a whole batch with an EPHEMERAL ledger, for a caller with no player.
 *
 * The ledger is created, spent and dropped inside this function, so a preview
 * cannot consume a name or a category from anybody's real life, and nothing it
 * assigns is persisted anywhere. Names stay consistent across the batch,
 * which is the only thing a preview actually needs.
 */
export function resolveBatchEphemeral(scenarios, {
  relationships = {},
  kids = [],
  age = START_AGE,
  seedInput = 'preview',
  pool = NAME_POOL,
  region = null,
} = {}) {
  const { ledger, rng } = ephemeralNameContext(seedInput);
  const out = (scenarios || []).map((scenario) => {
    const { card, assigned } = resolveCardNames(scenario, { ledger, relationships, kids, age, rng, pool, region });
    for (const entry of assigned) {
      ledger.byTag[entry.key] = entry.name;
      if (entry.category) ledger.categories[entry.category] = (ledger.categories[entry.category] || 0) + 1;
    }
    return card;
  });
  return { scenarios: out, assignedNames: { ...ledger.byTag } };
}

/* ------------------------------------------------------------ drift check */

/** Accepts either the state map or the summary array. */
export function relationshipList(relationships) {
  if (Array.isArray(relationships)) {
    return relationships
      .filter((r) => r && typeof r.name === 'string')
      .map((r) => ({ name: r.name, role: r.role || '' }));
  }
  return Object.entries(relationships || {})
    .filter(([name, rel]) => typeof name === 'string' && rel)
    .map(([name, rel]) => ({ name, role: rel.role || '' }));
}

const cardText = (s) =>
  [s.setting, s.beat, s.dialogue, s.prompt, s.scenario].filter(Boolean).join(' ');

// "your roommate Dana", "your roommate, Dana", "Dana, your roommate".
const AFTER = (word) => new RegExp('\b(?:your|their|his|her)\s+' + word + '[,:]?\s+([A-Z][a-z]{1,19})\b');
const BEFORE = (word) => new RegExp('\b([A-Z][a-z]{1,19}),\s+(?:your|their|his|her)\s+' + word + '\b');

/**
 * Best-effort: has the storyteller renamed somebody the engine already named?
 *
 * Two signals, both cheap and both deliberately conservative. This is a
 * backstop, not a parser - the prompt does the primary work, and this catches
 * the drift that gets through.
 *
 * @returns {string[]} human-readable violations, empty when clean
 */
export function checkNameDrift(scenario, relationships) {
  const people = relationshipList(relationships);
  if (!people.length || !scenario) return [];

  const violations = [];
  const known = new Set(people.map((p) => firstName(p.name)));

  // 1. The strong signal: an effect claims a role somebody already fills,
  //    under a different name. This one is unambiguous.
  for (const side of ['leftEffects', 'rightEffects']) {
    const rel = scenario[side] && scenario[side].relationship;
    if (!rel || typeof rel.name !== 'string' || typeof rel.role !== 'string' || !rel.role) continue;
    if (hasNameTag(rel.name)) continue;
    const group = roleGroup(rel.role);
    for (const person of people) {
      if (roleGroup(person.role) !== group) continue;
      if (firstName(person.name) !== firstName(rel.name)) {
        violations.push(`${rel.role} is ${person.name}, but the card calls them ${rel.name}`);
      }
    }
  }

  // 2. The weaker signal: prose introducing a filled role under a new name.
  const text = cardText(scenario);
  if (text) {
    for (const person of people) {
      const group = roleGroup(person.role);
      const words = ROLE_GROUPS[group] || [person.role];
      for (const word of words) {
        if (!word || word.length < 3) continue;
        const escaped = word.replace(/[-]/g, '\-').replace(/\s+/g, '\s+');
        for (const re of [AFTER(escaped), BEFORE(escaped)]) {
          const hit = re.exec(text);
          if (!hit) continue;
          const found = firstName(hit[1]);
          if (found === firstName(person.name) || known.has(found)) continue;
          violations.push(`${person.role} is ${person.name}, but the card writes "${word} ${hit[1]}"`);
        }
      }
    }
  }

  return [...new Set(violations)].slice(0, 4);
}

/* --------------------------------------------------- reintroduction check */

// Does the card give this off-screen person a role reminder, rather than a
// bare name? Two cheap positive signals, deliberately generous: a soft check
// should stay quiet when in doubt, so anything that plausibly reads as a
// reminder suppresses the warning.
//   1. the role word appears anywhere in the card ("...from your study group")
//   2. an appositive or lead-in sits against the name ("Dmitri, the guy...",
//      "your old roommate Dmitri")
function hasRoleReminder(text, name, role) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The role word itself, in any of its synonyms, anywhere in the card.
  const group = roleGroup(role);
  const words = (ROLE_GROUPS[group] || [role]).filter((w) => w && w.length >= 3);
  for (const word of words) {
    const w = word.replace(/[-]/g, '\\-').replace(/\s+/g, '\\s+');
    if (new RegExp('(^|[^a-z])' + w + '([^a-z]|$)', 'i').test(text)) return true;
  }
  // "Dmitri, the guy from your study group" - a comma appositive by the name.
  if (new RegExp('\\b' + esc + '\\b\\s*,\\s*(the|a|an|your|their|his|her|my|one of|from|who)\\b', 'i').test(text)) {
    return true;
  }
  // "your old roommate Dmitri" - a possessive/article lead-in just before it.
  if (new RegExp('\\b(?:your|their|his|her|my|the|a|an|old|former)\\b[^.?!]{0,24}?\\b' + esc + '\\b', 'i').test(text)) {
    return true;
  }
  return false;
}

// Mom and Dad are the address form, not names, and never need reintroducing;
// neither do the parent role-words a bare name could collide with.
const SELF_EVIDENT = new Set(['mom', 'mum', 'mommy', 'dad', 'daddy', 'mother', 'father']);

/**
 * Best-effort: does a card bring back an existing relationship who has NOT
 * appeared in the recent-history window the model was shown, and do it with a
 * bare name and no role reminder? "Dmitri has been leaving space at lunch"
 * lands on nobody if the player last saw Dmitri twenty cards ago; "Dmitri, the
 * guy from your study group" does not.
 *
 * Advisory only, exactly like checkNameDrift: the prompt does the primary work
 * (it marks which people are off-screen and asks for the reminder) and this
 * measures how well that holds. String matching, so it never blocks a card.
 *
 * @param {object} scenario            a validated scenario
 * @param {Array|object} relationships state map or summary array, carrying role
 * @param {string} recentText          the recent-history window text
 * @returns {string[]} human-readable warnings, empty when clean
 */
export function checkReintroductions(scenario, relationships, recentText = '') {
  const people = relationshipList(relationships);
  if (!people.length || !scenario) return [];
  const text = cardText(scenario);
  if (!text) return [];
  const recent = String(recentText || '');

  const warnings = [];
  for (const person of people) {
    const first = firstName(person.name);
    if (!first || hasNameTag(person.name) || SELF_EVIDENT.has(first)) continue;
    // firstName lower-cases; match case-insensitively against the raw name.
    const nameRe = new RegExp('\\b' + first.replace(/[^a-z0-9]/gi, '') + '\\b', 'i');
    if (!nameRe.test(text)) continue;   // this card does not name them
    if (nameRe.test(recent)) continue;  // they were just on screen; no reminder needed
    if (hasRoleReminder(text, person.name, person.role)) continue; // reintroduced properly
    warnings.push(`"${person.name}" is named but was not in the recent window and gets no role reminder`);
  }
  return [...new Set(warnings)].slice(0, 4);
}
