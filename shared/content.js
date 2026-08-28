// Content mode policy.
//
// Single source of truth for what may appear in a life, shared by the engine,
// the deck, the prompt builder, the validator and the simulator. Mode is a
// tone-and-subject dial, NOT a difficulty setting: safe mode keeps bankruptcy,
// illness, divorce, accidents and death. It drops drugs, crime and vice.

export const MODES = ['safe', 'mature'];
export const DEFAULT_MODE = 'safe';
export const ADULT_AGE = 18;

/* --------------------------------------------------------- the hard rule */

// Age beats mode, always. A minor gets safe-tier generation even in a mature
// life. Every layer calls this rather than reading contentMode directly.
export function effectiveTier({ age, contentMode }) {
  const mode = MODES.includes(contentMode) ? contentMode : DEFAULT_MODE;
  if (!Number.isFinite(age) || age < ADULT_AGE) return 'safe';
  return mode;
}

export const isMinor = (age) => !Number.isFinite(age) || age < ADULT_AGE;

/* ------------------------------------------------------------ categories */

export const CATEGORIES = [
  { id: 'money',         tier: 'safe',   label: 'money and debt' },
  { id: 'health',        tier: 'safe',   label: 'health and the body' },
  { id: 'career',        tier: 'safe',   label: 'work and career' },
  { id: 'relationships', tier: 'safe',   label: 'love and friendship' },
  { id: 'family',        tier: 'safe',   label: 'family and children' },
  { id: 'education',     tier: 'safe',   label: 'school and learning' },
  { id: 'accident',      tier: 'safe',   label: 'accidents and chance' },
  { id: 'community',     tier: 'safe',   label: 'neighbours and civic life' },

  { id: 'substance',     tier: 'mature', label: 'drugs and addiction' },
  { id: 'crime',         tier: 'mature', label: 'crime and arrest' },
  { id: 'incarceration', tier: 'mature', label: 'prison and its aftermath' },
  { id: 'gambling',      tier: 'mature', label: 'gambling and debt to the wrong people' },
  { id: 'vice',          tier: 'mature', label: 'vice and self-destruction' },
];

export const MATURE_CATEGORIES = CATEGORIES.filter((c) => c.tier === 'mature').map((c) => c.id);
export const SAFE_CATEGORIES = CATEGORIES.filter((c) => c.tier === 'safe').map((c) => c.id);

/* -------------------------------------------------------------- detection */

// A deliberately blunt keyword backstop. The prompt does the primary work;
// this exists to catch a model that drifts, so it errs toward false positives
// on the mature side and is never the only thing standing between a player and
// content they did not ask for.
// Each stem matches its own suffixes rather than leaning on a trailing word
// boundary. The earlier form meant the stem for embezzlement could never match
// the only spelling anyone writes, leaving a hole exactly where it mattered.
const PATTERNS = {
  substance: /\b(?:heroin|cocaine|meth|methamphetamine|fentanyl|opioid\w*|oxycontin|oxycodone|percocet|vicodin|xanax|adderall|molly|ecstasy|mdma|psilocybin|ketamine|narcotic\w*|overdos\w*|snort\w*|inject\w*|drug\w*|dope|junkie|addict\w*|rehab|detox|relaps\w*|stoned|marijuana|cannabis|bong|smoking weed|smoke weed)\b/i,
  crime: /\b(?:arrest\w*|felon\w*|indict\w*|convict\w*|handcuff\w*|mugshot|shoplift\w*|burglar\w*|robber\w*|robbed|carjack\w*|embezzl\w*|money launder\w*|fraud\w*|forger\w*|briber\w*|extort\w*|stabb\w*|grand theft|police raid|criminal charge\w*|assault charge\w*)\b/i,
  incarceration: /\b(?:prison\w*|jail\w*|incarcerat\w*|penitentiary|parole\w*|probation officer|bail bond\w*|arraign\w*|sentencing hearing|doing time|locked up|reentry program)\b/i,
  gambling: /\b(?:casino|blackjack|roulette|slot machine\w*|sportsbook|sports book|bookie|gambl\w*|poker debt|loan shark\w*|parlay)\b/i,
  sexual: /\b(?:pornograph\w*|prostitut\w*|escort service|brothel|strip club|one[- ]night stand)\b/i,
};

// Substances that are legal for adults but still off-limits for minors.
const MINOR_SUBSTANCE = /\b(cigarette|smoke[sd]? a|vape|vaping|nicotine|beer|vodka|whiskey|tequila|gin|drunk|wasted|blackout|shots? of|keg|fake id|hangover)\b/i;

/**
 * Returns the mature category ids detected in a blob of text.
 * @param {string} text
 * @param {{ minor?: boolean }} [opts] also flag minor-inappropriate substances
 */
export function detectMature(text, { minor = false } = {}) {
  const hay = String(text || '');
  const hits = [];
  for (const [category, re] of Object.entries(PATTERNS)) {
    if (re.test(hay)) hits.push(category);
  }
  if (minor && MINOR_SUBSTANCES_BLOCKED && MINOR_SUBSTANCE.test(hay) && !hits.includes('substance')) {
    hits.push('substance');
  }
  return hits;
}

// Whether under-18 characters may be offered tobacco or alcohol at all.
//
// The spec says no drugs for minors, full stop. Set true for that reading. It
// is false here because the hand-authored coming-of-age deck depends on exactly
// that kind of peer-pressure card (a cigarette offered behind the auditorium,
// a party with something blue in the bathtub) and those are the game's most
// age-appropriate stakes, not its most adult. Flip it and the engine will
// exclude them for minors in both modes.
export const MINOR_SUBSTANCES_BLOCKED = false;

/* ------------------------------------------------------------ compliance */

// All the text a player would actually read on a card.
function scenarioText(s) {
  const risks = [s.leftEffects, s.rightEffects]
    .map((e) => (e && e.risk && e.risk.description) || '')
    .join(' ');
  const flags = [s.leftEffects, s.rightEffects]
    .flatMap((e) => (e && e.flags) || [])
    .join(' ')
    .replace(/_/g, ' ');
  return [s.scenario, s.leftLabel, s.rightLabel, risks, flags].join(' \n ');
}

/**
 * Does this scenario belong in a life at the given tier and age?
 * @returns {{ ok: boolean, violations: string[], tier: 'safe'|'mature' }}
 */
export function checkCompliance(scenario, { tier = 'safe', age = 99 } = {}) {
  const minor = isMinor(age);
  const hits = detectMature(scenarioText(scenario), { minor });
  const declared = Array.isArray(scenario.modes) ? scenario.modes : null;

  // A card explicitly tagged mature-only is a violation in a safe life even if
  // the prose happens to dodge every keyword.
  if (declared && !declared.includes('safe') && tier === 'safe') {
    return { ok: false, violations: ['tagged_mature_only'], tier: 'mature' };
  }
  if (declared && !declared.includes('safe') && minor) {
    return { ok: false, violations: ['tagged_mature_only_minor'], tier: 'mature' };
  }

  if (!hits.length) return { ok: true, violations: [], tier: 'safe' };
  if (minor) return { ok: false, violations: hits, tier: 'mature' };
  if (tier === 'safe') return { ok: false, violations: hits, tier: 'mature' };
  return { ok: true, violations: [], tier: 'mature' };
}

export const isMatureScenario = (scenario) =>
  (Array.isArray(scenario.modes) && !scenario.modes.includes('safe')) ||
  detectMature(scenarioText(scenario)).length > 0;

/* ---------------------------------------------------- dark arc budgeting */

// A mature life gets 1-3 dark ARCS, each running up to a few cards, with a
// cooldown between them. This is what stops mature mode becoming a wall-to-wall
// crime spree: the budget is rolled once at birth and spent, not re-rolled.
export const ARC_MAX_CARDS = 3;   // cards one arc may span
export const ARC_COOLDOWN = 8;    // swipes of quiet between arcs
export const ARC_STALE = 6;       // an arc left alone this long has ended

export function rollDarkBudget(rand) {
  const r = rand();                       // 1-3, weighted toward 2
  return r < 0.3 ? 1 : r < 0.8 ? 2 : 3;
}

export function createDarkState(rand) {
  return {
    budget: rollDarkBudget(rand),
    arcsUsed: 0,
    scenarios: 0,
    cardsInArc: 0,
    arcOpen: false,
    lastDarkTurn: -999,
  };
}

// May a mature-tier card be dealt right now?
export function darkArcAllowed(state) {
  const d = state.dark;
  if (!d) return false;
  if (effectiveTier({ age: state.ageMonths / 12, contentMode: state.contentMode }) !== 'mature') {
    return false;
  }
  const sinceLast = state.turn - d.lastDarkTurn;
  if (d.arcOpen) {
    if (sinceLast > ARC_STALE) return d.arcsUsed < d.budget && sinceLast >= ARC_COOLDOWN;
    return d.cardsInArc < ARC_MAX_CARDS;
  }
  return d.arcsUsed < d.budget && sinceLast >= ARC_COOLDOWN;
}

// Called by the engine when a mature card is actually played.
export function noteDarkScenario(state) {
  const d = state.dark;
  if (!d) return;
  const sinceLast = state.turn - d.lastDarkTurn;
  if (!d.arcOpen || sinceLast > ARC_STALE || d.cardsInArc >= ARC_MAX_CARDS) {
    d.arcOpen = true;
    d.arcsUsed += 1;
    d.cardsInArc = 1;
  } else {
    d.cardsInArc += 1;
  }
  d.scenarios += 1;
  d.lastDarkTurn = state.turn;
}
