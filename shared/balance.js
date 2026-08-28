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
};

export default BAL;
