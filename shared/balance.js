// Every tunable number in one place. `npm run simulate` is the way to check
// whether a change here made lives too long, too rich, or too lethal.

export const BAL = {
  START: {
    ageMonths: 16 * 12,
    money: 420,
    health: 88,
    happiness: 68,
  },

  MAX_AGE: 106,

  // The calendar year a life is assumed to BEGIN in, at age 16. Used only to
  // work out roughly when a new character was born, so the name pool can be
  // filtered for era plausibility. It is a constant rather than a clock read
  // because invariant 6 says a given seed replays identically - forever, not
  // just this year. Bumping it shifts which names read as plausible by a few
  // years and moves nothing else.
  PRESENT_YEAR: 2026,

  NAMES: {
    // How hard the player's region tilts name selection. The pool stores a
    // location quotient - 25 means "twenty-five times more common in this
    // state than nationally" - and applying that raw would hand a Minnesota
    // player the same four names forever. The exponent damps it: at 0.5 a 25x
    // name is 5x likelier, a 3x name is 1.7x likelier, and a name with no
    // regional data sits at exactly 1.0 and is untouched.
    //   0   = regional weighting off, era-only selection
    //   0.5 = noticeable but not deterministic          <- shipped
    //   1   = raw location quotient, far too strong
    regionPower: 0.5,
    // No single name may end up more than this much likelier than a
    // neutral one, however extreme its regional signal.
    regionCeiling: 6,

    // How hard REAL NATIONAL FREQUENCY tilts which origin a character gets.
    //
    // The category draw used to be flat: 49 origins, ~1/49 each, so a player
    // was exactly as likely to meet a Maori-named character as an anglo one.
    // region_frequency could not fix that, because a location quotient is a
    // RATIO to the national rate - it says where a name is used and divides
    // out how much. name-pool.json now carries national_births per name, and
    // a category's weight is the sum of that over its live candidates.
    //   0    = flat, every origin equally likely (the old behaviour)
    //   0.35 = the real ordering, damped                   <- shipped
    //   0.5  = anglo 23%, but US-CA stops lifting its own origins
    //   1    = raw birth counts; anglo 57%, regional weighting dead
    //
    // 0.35 is not a taste setting, it is the CEILING. Measured, at 400 lives:
    //
    //   power  anglo   same-origin repeat   origins seen   npm run names
    //   0.35   14.9%     8.6%                49/49         passes
    //   0.5    23.1%    16.3%                47/49         FAILS
    //   1      56.7%    47.8%                25/49         FAILS
    //
    // Both failures are the same one: `US-CA did not lift its own origins`.
    // Region affinity is a multiplier capped at regionCeiling (6), and anglo
    // outweighs vietnamese/persian/armenian by ~460x in births, so past ~0.35
    // no regional signal can survive the frequency term and California draws
    // its own origins 0.0% of the time. Raising this trades away regional
    // weighting entirely; it does not merely turn it down.
    categoryPower: 0.35,
    // Births credited to a name the archive cannot report - SSA suppresses
    // counts under 5 per state-year, so Aroha and Somchai come back as 0.
    // Zero would make the weight a FILTER: those origins could never be drawn
    // again, which is the one thing region weighting was built never to do.
    // This keeps them legal but genuinely rare, which is what they are.
    categoryBirthsFloor: 500,
  },

  // You are not 'broke' the moment you are in the red - you are broke when the
  // debt exceeds what anyone would plausibly lend you. Student loans get their
  // own grace, because being 60k down at 22 is normal, not a game over.
  CREDIT: {
    base: 20000,
    incomeMult: 1.5,
    studentGrace: 90000,
  },

  // How far the engine will let the storyteller push a single choice.
  CLAMP: {
    statDelta: 25,          // |health| / |happiness| change per choice
    moneyFloor: 2500,       // always allow at least this much movement
    moneyIncomeMult: 2.5,   // ...or 2.5x annual income
    moneyWealthFrac: 0.6,   // ...or 60% of current net worth
    moneyCeiling: 3_000_000,
    flagsPerChoice: 3,
    maxFlags: 60,
    riskProbability: 0.25,  // any risk
    deathProbability: 0.08, // the LLM can never propose an execution
    salaryDelta: 180_000,
    salaryCeiling: 900_000,
    timeMonths: [0.25, 60],
  },

  // Default months advanced per swipe, by declared weight.
  TIME: {
    minor: 1,      // a moment or a week   (was "trivial")
    standard: 9,   // months               (was "minor")
    major: 30,     // a life decision
    trivial: 1,    // alias for older content and model output

    stageCapMonths: {
      highschool: 12,
      college: 18,
      early: 42,
      family: 48,
      late: 48,
      retirement: 60,
    },
  },

  // Gompertz mortality, calibrated to roughly match a US life table:
  // q(20) ~ 0.03%, q(60) ~ 1%, q(80) ~ 5.5%, q(100) ~ 30%.
  MORTALITY: {
    a: 6.1e-5,
    b: 0.085,
    accidentFloor: 0.0007,
    healthPivot: 60,
    healthSpread: 40,
    healthFactorRange: [0.4, 3.0],
  },

  ECON: {
    allowance: 1400,          // teen income while living at home
    studentIncome: 5200,      // work-study, summers, parental guilt
    studentCost: 9000,        // dorm and ramen, the rest is on the loans
    defaultJobSalary: 38000,  // engine-assigned if you reach 22 jobless
    autoRetireAge: 70,
    parentSubsidy: true,
    baseCostOfLiving: 22000,
    lifestyleCreep: 0.42,      // people spend most of what they earn
    spouseIncome: 26000,
    spouseCost: 19000,
    kidCost: 11000,
    kidYears: 20,
    socialSecurity: 21000,
    pensionRate: 0.15,
    savingsReturn: 0.03,
    savingsVolatility: 0.06,
    debtInterest: 0.09,
    raiseRate: 0.012,
  },

  DRIFT: {
    healthBase: 0.2,
    healthAgeOnset: 35,
    healthAgeRate: 0.05,
    happinessSetpoint: 55,
    happinessPull: 0.12,
    brokeHappiness: 6,
    brokeHealth: 2,
    relationshipDecay: 1.2,
  },

  CREDITS: {
    perYearBase: 50,
    happinessWeight: 0.6,
    healthWeight: 0.4,
    wealthDivisor: 5000,
    solvencyBonus: 2500,
    survivalBonus: 40,
  },

  // The two authored identity choices at the start of every life
  // (shared/intro.js). A starting-money nudge, not a fresh balance pass - both
  // stay well under moneyCap(s) at age 16 (~$3,500), so they clamp the same as
  // any other card's proposed effect would.
  INTRO: {
    financialTierModifiers: {
      modest: -350,
      comfortable: 700,
    },
  },
};

export default BAL;
