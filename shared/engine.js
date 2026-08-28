// The referee. Owns all state, clamps every number the storyteller proposes,
// rolls every die, and is the only thing allowed to decide that you died.
//
// The LLM never mutates state. It hands over a *proposal*; everything below
// treats that proposal as untrusted input.

import { BAL } from './balance.js';
import { seedFrom, nextRandom, chance, range, gauss } from './rng.js';
import { validateScenario, normalizeFlag } from './schema.js';
import {
  MODES, DEFAULT_MODE, effectiveTier, createDarkState, noteDarkScenario,
  isMatureScenario, darkArcAllowed,
} from './content.js';
import { createLibraryState, notePatternFired } from './library.js';
import { createNameLedger, hasNameTag, assignName, impliedBirthYear, castKey } from './names.js';

// The tag the seed deck uses for the friend the player starts life with.
const BEST_FRIEND_TAG = castKey('best friend');

export const STAGES = [
  { id: 'highschool', label: 'High School',         minAge: 16, maxAge: 18 },
  { id: 'college',    label: 'College / First Job', minAge: 18, maxAge: 22 },
  { id: 'early',      label: 'Early Career',        minAge: 22, maxAge: 30 },
  { id: 'family',     label: 'Family & Mid-Career', minAge: 30, maxAge: 50 },
  { id: 'late',       label: 'Late Career',         minAge: 50, maxAge: 65 },
  { id: 'retirement', label: 'Retirement',          minAge: 65, maxAge: 999 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

export const ageOf = (s) => s.ageMonths / 12;
export const stageFor = (age) => STAGES.find((st) => age < st.maxAge) || STAGES[STAGES.length - 1];
export const stageOf = (s) => stageFor(ageOf(s));
export const hasFlag = (s, f) => s.flags.includes(f);

/* ------------------------------------------------------------------ state */

// `region` tilts the starting friend's name the same way it tilts everyone
// else's. It is read here and NOT stored: it belongs to the session, not to
// the life, and a saved game should not carry the player's location around.
export function createState({
  seed = Date.now(), name = 'You', contentMode = DEFAULT_MODE, region = null,
} = {}) {
  const state = {
    seed: String(seed),
    rngState: seedFrom(seed),
    name,
    turn: 0,
    ageMonths: BAL.START.ageMonths,
    money: BAL.START.money,
    health: BAL.START.health,
    happiness: BAL.START.happiness,
    career: { title: 'High School Student', salary: 0 },
    education: 'High school (in progress)',
    pension: 0,
    // Mom and Dad are how you address a parent, not names, so they stay put.
    // The best friend gets a real name, assigned below once the RNG exists.
    relationships: {
      Mom: { role: 'mother', quality: 72, flags: [] },
      Dad: { role: 'father', quality: 64, flags: [] },
    },
    kids: [],
    // Role tag -> the name the engine gave that character, for this life only.
    // The name itself lives in `relationships` as it always has; this ledger
    // exists so a "{{new:roommate}}" written eight swipes from now resolves to
    // the same person, and so two characters cannot collide on one first name.
    names: createNameLedger(),
    flags: ['lives_with_parents'],
    // Which mode a flag was created under, so later systems can filter on it.
    flagMeta: {},
    contentMode: MODES.includes(contentMode) ? contentMode : DEFAULT_MODE,
    dark: null,
    library: null,
    // Consequences the storyteller has promised and the engine has agreed to
    // remember. Owned here, clamped here, never trusted from the model.
    pending: [],
    history: [],
    credits: 0,
    alive: true,
    ended: false,
    ending: null,
    causeOfDeath: null,
  };
  // Rolled once at birth from the run's own RNG and then spent - never
  // re-rolled, which is what keeps mature mode from becoming a crime spree.
  state.dark = createDarkState(() => nextRandom(state));
  state.library = createLibraryState(() => nextRandom(state));
  // The friend you already had at 16. Named here rather than hardcoded, so a
  // new life does not open on the same person every time - and recorded under
  // the cast tag the seed deck references, so the card that mentions them by
  // name three swipes from now means this same friend.
  const friend = assignName({
    role: 'best friend',
    birthYear: impliedBirthYear(ageOf(state), 'best friend'),
    taken: new Set(Object.keys(state.relationships).map((n) => n.toLowerCase())),
    rng: () => nextRandom(state),
    region,
  });
  if (friend) {
    state.relationships[friend.name] = { role: 'best friend', quality: 80, flags: [] };
    noteAssignedName(state, { key: BEST_FRIEND_TAG, name: friend.name, category: friend.category });
  }
  return state;
}

/**
 * Record a name the engine has just handed out. The deck resolves the tag and
 * calls this; the write itself stays in here, so "the engine owns state"
 * remains literally true rather than nearly true.
 */
export function noteAssignedName(s, { key, name, category } = {}) {
  if (!s || !key || !name) return;
  if (!s.names) s.names = createNameLedger();
  if (s.names.byTag[key]) return;
  s.names.byTag[key] = name;
  if (category) s.names.categories[category] = (s.names.categories[category] || 0) + 1;
}

// The tier actually in force right now. Age beats mode: a minor gets safe
// content even in a mature life, and this is the only function that decides it.
export const contentTier = (s) =>
  effectiveTier({ age: ageOf(s), contentMode: s.contentMode });

export const canDealDarkCard = (s) => darkArcAllowed(s);

const cloneState = (s) => JSON.parse(JSON.stringify(s));

/* -------------------------------------------------------------- economics */

export function activeKidCount(s) {
  const age = ageOf(s);
  return s.kids.filter((k) => age - k.bornAtAge < BAL.ECON.kidYears).length;
}

export function annualIncome(s) {
  const age = ageOf(s);
  const E = BAL.ECON;
  let income = 0;
  if (hasFlag(s, 'retired')) {
    income = s.pension + (age >= 62 ? E.socialSecurity : 0);
  } else {
    income = Math.max(0, s.career.salary);
    if (hasFlag(s, 'lives_with_parents') && age < 22) income += E.allowance;
    if (hasFlag(s, 'in_school')) income += E.studentIncome;
  }
  if (hasFlag(s, 'married') && !hasFlag(s, 'spouse_unemployed')) income += E.spouseIncome;
  return income;
}

export function annualExpenses(s) {
  const age = ageOf(s);
  const E = BAL.ECON;
  let cost;
  if (hasFlag(s, 'lives_with_parents') && age < 22) {
    cost = 900; // room, board and judgement provided free of charge
  } else if (hasFlag(s, 'in_school')) {
    cost = E.studentCost;
  } else {
    cost = E.baseCostOfLiving + Math.max(0, s.career.salary) * E.lifestyleCreep;
  }
  if (hasFlag(s, 'married')) cost += E.spouseCost;
  cost += activeKidCount(s) * E.kidCost;
  if (hasFlag(s, 'retired')) cost = Math.max(34000, cost * 0.8);
  if (hasFlag(s, 'chronic_illness')) cost += 9000;
  return cost;
}

// Marginal bands with payroll tax baked in. Nobody enjoys this part either.
const TAX_BANDS = [
  [15000, 0.08],
  [50000, 0.20],
  [100000, 0.28],
  [200000, 0.34],
  [Infinity, 0.40],
];

export function afterTax(gross) {
  let owed = 0;
  let last = 0;
  for (const [ceiling, rate] of TAX_BANDS) {
    if (gross <= last) break;
    owed += (Math.min(gross, ceiling) - last) * rate;
    last = ceiling;
  }
  return Math.max(0, gross - owed);
}

export const netWorthDelta = (s) => afterTax(annualIncome(s)) - annualExpenses(s);

// How far underwater you are allowed to go before the run ends.
export function creditLimit(s) {
  const C = BAL.CREDIT;
  return C.base + annualIncome(s) * C.incomeMult +
    (hasFlag(s, 'student_debt') || hasFlag(s, 'in_school') ? C.studentGrace : 0);
}

/* ------------------------------------------------- clamping LLM proposals */

// The most money a single choice is allowed to move, given who you are.
export function moneyCap(s) {
  const C = BAL.CLAMP;
  const byIncome = Math.max(annualIncome(s), s.career.salary) * C.moneyIncomeMult;
  const byWealth = Math.abs(s.money) * C.moneyWealthFrac;
  return clamp(Math.max(C.moneyFloor, byIncome, byWealth), C.moneyFloor, C.moneyCeiling);
}

export function normalizeEffects(rawEffects, s) {
  const C = BAL.CLAMP;
  const eff = rawEffects && typeof rawEffects === 'object' ? rawEffects : {};
  const cap = moneyCap(s);
  const out = {
    money: clamp(Number(eff.money) || 0, -cap, cap),
    health: clamp(Number(eff.health) || 0, -C.statDelta, C.statDelta),
    happiness: clamp(Number(eff.happiness) || 0, -C.statDelta, C.statDelta),
    flags: (Array.isArray(eff.flags) ? eff.flags : [])
      .map(normalizeFlag).filter(Boolean).slice(0, C.flagsPerChoice),
    clearFlags: (Array.isArray(eff.clearFlags) ? eff.clearFlags : [])
      .map(normalizeFlag).filter(Boolean).slice(0, C.flagsPerChoice),
  };

  if (eff.risk && typeof eff.risk === 'object') {
    const outcome = ['death', 'injury', 'windfall'].includes(eff.risk.outcome)
      ? eff.risk.outcome : 'injury';
    const ceiling = outcome === 'death' ? C.deathProbability : C.riskProbability;
    const p = clamp(Number(eff.risk.probability) || 0, 0, ceiling);
    if (p > 0) {
      out.risk = {
        probability: p,
        outcome,
        description: String(eff.risk.description || 'It goes badly.').slice(0, 220),
      };
    }
  }

  if (eff.career && typeof eff.career === 'object') {
    const career = {};
    if (typeof eff.career.title === 'string' && eff.career.title.trim()) {
      career.title = eff.career.title.trim().slice(0, 60);
    }
    if (Number.isFinite(eff.career.salary)) {
      const current = Math.max(0, s.career.salary);
      career.salary = clamp(
        clamp(eff.career.salary, current - C.salaryDelta, current + C.salaryDelta),
        0, C.salaryCeiling,
      );
    }
    if (Object.keys(career).length) out.career = career;
  }

  if (typeof eff.education === 'string' && eff.education.trim()) {
    out.education = eff.education.trim().slice(0, 60);
  }

  // An unresolved "{{new:roommate}}" reaching this point means something
  // upstream skipped resolution. Dropping the whole relationship effect is the
  // only safe answer: creating a person literally named "{{new:roommate}}"
  // would key the relationships map off braces for the rest of the life.
  if (eff.relationship && typeof eff.relationship === 'object'
      && eff.relationship.name && !hasNameTag(String(eff.relationship.name))) {
    const rel = { name: String(eff.relationship.name).slice(0, 30).trim() };
    if (typeof eff.relationship.role === 'string') rel.role = eff.relationship.role.slice(0, 30);
    if (Number.isFinite(eff.relationship.quality)) rel.quality = clamp(eff.relationship.quality, 0, 100);
    if (Number.isFinite(eff.relationship.qualityDelta)) {
      rel.qualityDelta = clamp(eff.relationship.qualityDelta, -40, 40);
    }
    if (Array.isArray(eff.relationship.flags)) {
      rel.flags = eff.relationship.flags.map(normalizeFlag).filter(Boolean).slice(0, 3);
    }
    if (eff.relationship.remove === true) rel.remove = true;
    out.relationship = rel;
  }

  if (eff.pendingEvent && typeof eff.pendingEvent === 'object') out.pendingEvent = eff.pendingEvent;
  if (typeof eff.resolves === 'string' && eff.resolves.trim()) out.resolves = eff.resolves.trim();
  if (eff.kid === true) out.kid = true;
  if (eff.retire === true) out.retire = true;
  if (Number.isFinite(eff.timeCostMonths)) out.timeCostMonths = eff.timeCostMonths;
  return out;
}

// Months advanced by a swipe. The storyteller may suggest; the engine decides.
export function timeCostMonths(scenario, effects, s) {
  const [lo, hi] = BAL.CLAMP.timeMonths;
  const cap = BAL.TIME.stageCapMonths[stageOf(s).id] ?? 48;
  const proposed = Number.isFinite(effects.timeCostMonths)
    ? effects.timeCostMonths
    : BAL.TIME[scenario.weight] ?? BAL.TIME.standard;
  return clamp(proposed, lo, Math.min(hi, cap));
}

/* -------------------------------------------------------------- mortality */

export function annualMortality(s) {
  const M = BAL.MORTALITY;
  const age = ageOf(s);
  const base = M.a * Math.exp(M.b * age) + M.accidentFloor;
  const healthFactor = clamp(
    1 + (M.healthPivot - s.health) / M.healthSpread,
    M.healthFactorRange[0], M.healthFactorRange[1],
  );
  let q = base * healthFactor;
  if (hasFlag(s, 'chronic_illness')) q *= 1.7;
  if (hasFlag(s, 'heavy_drinker') || hasFlag(s, 'smoker')) q *= 1.5;
  return clamp(q, 0, 0.95);
}

const NATURAL_CAUSES = [
  'a heart that had simply had enough',
  'complications from being sixty-something and stubborn',
  'a stroke, mid-sentence',
  'pneumonia, which nobody takes seriously until it is too late',
  'cancer, found late and described politely',
  'old age, the diagnosis of exclusion',
];
// Reached when health hits zero: the body gives out ahead of the actuarial table.
const FRAILTY_CAUSES = [
  'a body that had been sending memos for years',
  'organ failure, plural, in an order the chart calls unremarkable',
  'a fall, then a hospital, then a second thing, then a third',
  'the accumulated interest on every skipped appointment',
  'sepsis, which arrived quietly and left quickly',
];
const YOUNG_CAUSES = [
  'a car that ran the light',
  'an aneurysm, no warning given',
  'a freak accident involving a ladder',
  'an infection that moved faster than the paperwork',
];

/* ---------------------------------------------------------------- the act */

export function applyChoice(state, rawScenario, side) {
  const s = cloneState(state);
  if (s.ended) return { state: s, events: [], ended: true };

  const scenario = rawScenario.leftEffects ? rawScenario : validateScenario(rawScenario).scenario;
  const chosenLabel = side === 'left' ? scenario.leftLabel : scenario.rightLabel;
  const eff = normalizeEffects(side === 'left' ? scenario.leftEffects : scenario.rightEffects, s);
  const events = [];
  const before = { money: s.money, health: s.health, happiness: s.happiness, age: ageOf(s) };

  s.turn += 1;

  // 0. Account for mature content before anything else, so the arc budget is
  //    spent even if this card turns out to be the one that kills you.
  if (isMatureScenario(scenario)) noteDarkScenario(s);
  if (scenario.libraryId) notePatternFired(s, scenario.libraryId);

  // 1. Immediate proposed effects (already clamped).
  s.money += eff.money;
  s.health = clamp(s.health + eff.health, 0, 100);
  s.happiness = clamp(s.happiness + eff.happiness, 0, 100);

  for (const f of eff.flags) {
    if (!s.flags.includes(f) && s.flags.length < BAL.CLAMP.maxFlags) {
      s.flags.push(f);
      s.flagMeta[f] = { mode: s.contentMode, tier: contentTier(s), age: Math.floor(ageOf(s)), turn: s.turn };
    }
  }
  if (eff.clearFlags.length) s.flags = s.flags.filter((f) => !eff.clearFlags.includes(f));

  if (eff.career) {
    if (eff.career.title) s.career.title = eff.career.title;
    if (Number.isFinite(eff.career.salary)) s.career.salary = Math.round(eff.career.salary);
  }
  if (eff.education) s.education = eff.education;
  if (ageOf(s) >= 22 && hasFlag(s, 'lives_with_parents') && s.career.salary > 15000) {
    s.flags = s.flags.filter((f) => f !== 'lives_with_parents');
  }

  if (eff.relationship) {
    const { name } = eff.relationship;
    if (eff.relationship.remove) {
      delete s.relationships[name];
      events.push({ type: 'relationship', text: name + ' is no longer in your life.' });
    } else {
      const rel = s.relationships[name] ||
        { role: eff.relationship.role || 'acquaintance', quality: 55, flags: [] };
      if (eff.relationship.role) rel.role = eff.relationship.role;
      if (Number.isFinite(eff.relationship.quality)) rel.quality = eff.relationship.quality;
      if (Number.isFinite(eff.relationship.qualityDelta)) {
        rel.quality = clamp(rel.quality + eff.relationship.qualityDelta, 0, 100);
      }
      for (const f of eff.relationship.flags || []) if (!rel.flags.includes(f)) rel.flags.push(f);
      s.relationships[name] = rel;
    }
  }

  if (eff.pendingEvent) {
    const created = addPendingEvent(s, eff.pendingEvent, scenario.libraryId ? 'library:' + scenario.libraryId : 'llm');
    if (created) events.push({ type: 'pending', text: created.label });
  }
  if (eff.resolves && resolvePendingEvent(s, eff.resolves)) {
    events.push({ type: 'resolved', text: 'That thing you were waiting on has arrived.' });
  }

  if (eff.kid) {
    s.kids.push({ name: 'Child ' + (s.kids.length + 1), bornAtAge: round2(ageOf(s)) });
    if (!s.flags.includes('has_kids')) s.flags.push('has_kids');
    events.push({ type: 'kid', text: 'A child arrives. The math changes.' });
  }

  if (eff.retire && !hasFlag(s, 'retired')) {
    s.pension = Math.round(Math.max(0, s.career.salary) * BAL.ECON.pensionRate);
    s.career = { title: 'Retired', salary: 0 };
    s.flags.push('retired');
    events.push({ type: 'retire', text: 'You retire. The calendar goes blank, which is either peace or horror.' });
  }

  // 2. Risk roll. The engine rolls; the storyteller only ever suggested odds.
  if (eff.risk && chance(s, eff.risk.probability)) {
    events.push({ type: 'risk', outcome: eff.risk.outcome, text: eff.risk.description });
    if (eff.risk.outcome === 'death') {
      return finish(s, 'death', eff.risk.description, events, before, scenario, chosenLabel, 0);
    }
    if (eff.risk.outcome === 'injury') {
      s.health = clamp(s.health - range(s, 12, 34), 0, 100);
      s.happiness = clamp(s.happiness - range(s, 4, 14), 0, 100);
      s.money -= Math.min(moneyCap(s), range(s, 1200, 9000));
      if (!s.flags.includes('injured')) s.flags.push('injured');
    }
    if (eff.risk.outcome === 'windfall') {
      s.money += Math.min(moneyCap(s) * 2, range(s, 4000, 45000));
      s.happiness = clamp(s.happiness + range(s, 4, 12), 0, 100);
    }
  }

  // 3. Advance the clock, and let time do what time does.
  const months = timeCostMonths(scenario, eff, s);
  const dt = months / 12;
  s.ageMonths += months;
  const age = ageOf(s);
  const E = BAL.ECON;
  const D = BAL.DRIFT;

  // The referee fills gaps the storyteller left. Nobody drifts through their
  // twenties with no job, no income and no explanation.
  if (!hasFlag(s, 'retired')) {
    if (hasFlag(s, 'in_school') && (age >= 23 || s.career.salary > 15000)) {
      s.flags = s.flags.filter((f) => f !== 'in_school');
    }
    if (age >= 20 && s.career.salary <= 0 && !hasFlag(s, 'in_school')) {
      s.career = { title: 'Something with a lanyard', salary: E.defaultJobSalary };
      s.flags = s.flags.filter((f) => f !== 'laid_off');
      events.push({ type: 'career', text: 'You take a job. Not the job. A job.' });
    }
    if (age >= E.autoRetireAge) {
      s.pension = Math.round(Math.max(0, s.career.salary) * E.pensionRate);
      s.career = { title: 'Retired', salary: 0 };
      s.flags.push('retired');
      events.push({ type: 'retire', text: 'You stop working, largely because people stopped asking you to.' });
    }
  }

  if (s.money > 0) {
    const marketReturn = E.savingsReturn + gauss(s) * E.savingsVolatility;
    s.money *= Math.pow(1 + clamp(marketReturn, -0.35, 0.4), dt);
  } else if (s.money < 0) {
    s.money *= Math.pow(1 + E.debtInterest, dt);
  }
  s.money += netWorthDelta(s) * dt;
  if (!hasFlag(s, 'retired') && s.career.salary > 0) {
    s.career.salary = Math.round(s.career.salary * Math.pow(1 + E.raiseRate, dt));
  }

  expireStalePending(s);

  const decay = D.healthBase + Math.max(0, age - D.healthAgeOnset) * D.healthAgeRate;
  s.health = clamp(s.health - decay * dt, 0, 100);

  // Hedonic treadmill: happiness is pulled back toward baseline no matter what.
  s.happiness = clamp(
    s.happiness + (D.happinessSetpoint - s.happiness) * (1 - Math.pow(1 - D.happinessPull, dt)),
    0, 100,
  );

  if (s.money < 0) {
    s.happiness = clamp(s.happiness - D.brokeHappiness * dt, 0, 100);
    s.health = clamp(s.health - D.brokeHealth * dt, 0, 100);
  }
  for (const rel of Object.values(s.relationships)) {
    rel.quality = clamp(rel.quality - D.relationshipDecay * dt, 0, 100);
  }

  const C = BAL.CREDITS;
  s.credits += Math.max(0,
    dt * (C.perYearBase + s.happiness * C.happinessWeight + s.health * C.healthWeight) +
    (s.money > 0 ? (dt * s.money) / C.wealthDivisor : 0));

  // 4. Endings. Only the engine gets to call these.
  if (s.money < -creditLimit(s)) {
    return finish(s, 'bankrupt', 'The debt outran you.', events, before, scenario, chosenLabel, months);
  }
  if (s.health <= 0) {
    const cause = FRAILTY_CAUSES[Math.floor(nextRandom(s) * FRAILTY_CAUSES.length)];
    return finish(s, 'death', cause, events, before, scenario, chosenLabel, months);
  }
  const pDeath = 1 - Math.pow(1 - annualMortality(s), dt);
  if (chance(s, pDeath)) {
    const pool = age < 45 ? YOUNG_CAUSES : NATURAL_CAUSES;
    const cause = pool[Math.floor(nextRandom(s) * pool.length)];
    return finish(s, 'death', cause, events, before, scenario, chosenLabel, months);
  }
  if (age >= BAL.MAX_AGE) {
    return finish(s, 'death', 'You simply ran out of century.', events, before, scenario, chosenLabel, months);
  }

  record(s, scenario, chosenLabel, side, before, months, events);
  return { state: s, events, ended: false };
}

function finish(s, ending, cause, events, before, scenario, chosenLabel, months) {
  s.alive = false;
  s.ended = true;
  s.ending = ending;
  s.causeOfDeath = cause;
  s.credits += BAL.CREDITS.survivalBonus * Math.max(0, ageOf(s) - 16);
  if (ending !== 'bankrupt' && s.money > 0) s.credits += BAL.CREDITS.solvencyBonus;
  s.credits = Math.round(s.credits);
  record(s, scenario, chosenLabel, 'left', before, months, events);
  events.push({ type: 'end', ending, text: cause });
  return { state: s, events, ended: true };
}

function record(s, scenario, chosenLabel, side, before, months, events) {
  s.history.push({
    turn: s.turn,
    age: Math.floor(before.age),
    scenario: scenario.scenario,
    choice: chosenLabel,
    side,
    months: round2(months),
    delta: {
      money: Math.round(s.money - before.money),
      health: Math.round(s.health - before.health),
      happiness: Math.round(s.happiness - before.happiness),
    },
    events: events.filter((e) => e.type === 'risk' || e.type === 'end').map((e) => e.text),
  });
  if (s.history.length > 200) s.history.splice(0, s.history.length - 200);
}

/* ------------------------------------------------- context for the writer */

export function stateSummary(s) {
  const age = ageOf(s);
  const stage = stageOf(s);
  return {
    age: Math.floor(age),
    stage: stage.id,
    stageLabel: stage.label,
    money: Math.round(s.money),
    health: Math.round(s.health),
    happiness: Math.round(s.happiness),
    career: { title: s.career.title, salary: Math.round(s.career.salary) },
    education: s.education,
    relationships: Object.entries(s.relationships).map(([name, r]) => ({
      name, role: r.role, quality: Math.round(r.quality), flags: r.flags,
    })),
    kids: s.kids.map((k) => ({ name: k.name, age: Math.floor(age - k.bornAtAge) })),
    // Names the engine has already handed out, by role tag. Shown to the model
    // so a character it introduced two batches ago keeps the same name.
    assignedNames: { ...((s.names && s.names.byTag) || {}) },
    flags: s.flags,
    annualIncome: Math.round(annualIncome(s)),
    annualExpenses: Math.round(annualExpenses(s)),
    turn: s.turn,
    contentMode: s.contentMode,
    // The tier the server must generate at. Already age-resolved, so the
    // server never has to reason about the minor rule itself.
    tier: contentTier(s),
    darkArcAllowed: canDealDarkCard(s),
    darkArcs: s.dark ? { used: s.dark.arcsUsed, budget: s.dark.budget } : null,
    pending: pendingEvents(s).map((p) => ({
      id: p.id,
      label: p.label,
      dueInYears: Math.max(0, Math.round((p.dueAtAge - ageOf(s)) * 10) / 10),
      overdue: p.dueAtAge <= ageOf(s),
    })),
  };
}

export function recentDecisions(s, n = 10) {
  return s.history.slice(-n).map((h) => ({
    age: h.age,
    scenario: h.scenario,
    chose: h.choice,
    outcome: h.events.length ? h.events.join(' ') : undefined,
  }));
}

export function finalStats(s) {
  return {
    ending: s.ending,
    cause: s.causeOfDeath,
    age: Math.floor(ageOf(s)),
    money: Math.round(s.money),
    health: Math.round(s.health),
    happiness: Math.round(s.happiness),
    credits: Math.round(s.credits),
    turns: s.turn,
    career: s.career.title,
    education: s.education,
    kids: s.kids.length,
    flags: s.flags,
    relationships: Object.entries(s.relationships).map(([n, r]) => n + ' (' + r.role + ')'),
  };
}

/* --------------------------------------------------------- pending events */

// How much the storyteller is allowed to promise, and how far ahead.
export const PENDING = {
  max: 4,
  minMonths: 6,
  maxMonths: 96,
  expireAfterYears: 5,
  labelChars: 120,
};

/**
 * Record a consequence to come. The model proposes the shape; every number
 * here is clamped, and the engine decides when it is actually due.
 */
export function addPendingEvent(s, raw, source = 'llm') {
  if (!raw || typeof raw !== 'object') return null;
  const id = normalizeFlag(raw.id || raw.kind || 'consequence');
  if (!id) return null;
  if (s.pending.some((p) => p.id === id && !p.resolved)) return null;
  if (s.pending.filter((p) => !p.resolved).length >= PENDING.max) return null;

  const months = clamp(
    Number.isFinite(raw.dueInMonths) ? raw.dueInMonths : 24,
    PENDING.minMonths, PENDING.maxMonths,
  );
  const event = {
    id,
    label: String(raw.label || raw.description || 'Something is coming.').slice(0, PENDING.labelChars),
    kind: normalizeFlag(raw.kind || 'consequence') || 'consequence',
    createdAtAge: round2(ageOf(s)),
    dueAtAge: round2(ageOf(s) + months / 12),
    source,
    mode: s.contentMode,
    resolved: false,
  };
  s.pending.push(event);
  return event;
}

export const pendingEvents = (s) => (s.pending || []).filter((p) => !p.resolved);

export function duePendingEvents(s) {
  const age = ageOf(s);
  return pendingEvents(s).filter((p) => p.dueAtAge <= age);
}

export function resolvePendingEvent(s, id) {
  const flag = normalizeFlag(id);
  const found = (s.pending || []).find((p) => p.id === flag && !p.resolved);
  if (found) {
    found.resolved = true;
    found.resolvedAtAge = round2(ageOf(s));
  }
  return Boolean(found);
}

// Promises nobody kept eventually stop being promises.
function expireStalePending(s) {
  const age = ageOf(s);
  for (const p of s.pending || []) {
    if (!p.resolved && age - p.dueAtAge > PENDING.expireAfterYears) {
      p.resolved = true;
      p.expired = true;
    }
  }
}

export { expireStalePending, notePatternFired };
