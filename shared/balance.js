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

    // The same measurement one level down: how much a name's own national
    // birth count decides WHICH name you get inside the chosen origin.
    //
    // Weighting the category alone left the second half of the flatness in
    // place - anglo's share spread evenly over 633 names while irish's spread
    // over 23, so an individual Irish name stayed likelier than an individual
    // anglo one and the most-drawn name in the whole pool was Fiona.
    //   0   = flat inside a category (the old behaviour)
    //   0.5 = the real ordering, damped                    <- shipped
    //   1   = raw births; the top few names crowd out the rest of the origin
    // Tuned separately from categoryPower because the contest is different:
    // there, region competes with frequency ACROSS origins and loses past
    // 0.35; here it competes INSIDE one, where the birth spread is far
    // narrower, so region survives a stronger setting.
    nameFrequencyPower: 0.5,
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

  // Demo mode: a short, mature-only, static life for a demo booth or a link
  // somebody clicks once. Every number here is read ONLY when
  // `state.demoMode` is true, so nothing in this block can move an ordinary
  // life by a cent. See CLAUDE.md's "Demo mode" section.
  DEMO: {
    // 18, not 16, and set through createState's `startAge` rather than by
    // fast-forwarding the clock afterwards. This SATISFIES the age invariant
    // rather than working around it: effectiveTier({age: 18, contentMode:
    // 'mature'}) is 'mature' on its own terms, so no demo card is ever a
    // mature card shown to a minor.
    startAge: 18,

    // The hard ceiling on a demo life, in swipes. Reached, the engine ends
    // the life gracefully through the same `finish` path bankruptcy and death
    // use (see applyChoice) - never an abrupt cutoff, and never a target: a
    // demo life that goes broke or dies at swipe 12 ends at swipe 12.
    //
    // 30 IS A MEASURED NUMBER, and it was measured twice.
    //
    // The first guess was 40, from a rough "a minor card is ~20 words, call
    // it 6 seconds". `npm run demo-check` against a pilot pool put the median
    // session at 5m33s - outside the 1-5 minute brief - because a real card
    // is longer than that guess, and at 3.6 words/second plus 2.4 seconds to
    // decide it costs ~8.8 seconds, not 6. That took it to 32.
    //
    // Then the actual 300-card pool arrived with a median card of 25 words
    // rather than the pilot's 23, and 32 swipes measured at 5m04s - four
    // seconds over. Hence 30, which lands at ~4m45s. Four seconds is well
    // inside the error bars of a reading-rate assumption, and the number was
    // trimmed anyway: the brief is the brief, and arguing with the harness
    // that is telling you the answer is how a constant goes stale.
    //
    // demo-check recomputes that estimate from the pool's real word counts on
    // every run and says so when the median leaves the window, so this stays
    // honest as the pool changes. The two reading-rate assumptions behind it
    // sit at the top of that script rather than here, because they are the
    // part most worth arguing with, and they are deliberately CONSERVATIVE -
    // 3.6 words/second is about 216wpm against a typical adult's ~240.
    maxSwipes: 30,

    // Months per swipe INSTEAD of BAL.TIME, for demo lives only.
    //
    // At the ordinary minor rate (1 month) a 32-swipe demo covers under three
    // years and ends at 20, which reads as a fragment rather than a life. At
    // 5 months it covers ~13 years and ends around 31 - college, first job,
    // first real money, the beginning of the rest of it - which is the arc a
    // demo is actually trying to show, and which is why the demo pool has
    // three age bands reaching to 36 rather than one.
    //
    // 5 rather than 4 because maxSwipes came DOWN on measurement (see above)
    // and the age reached has to be held where the pool's bands are: 30 x 5
    // months lands at 30.5, just inside the third band, where 30 x 4 would
    // land at 28 and make that band's cards unreachable entirely. The product
    // of these two constants is the real setting; either one alone is half an
    // answer, so re-check the age line demo-check prints after touching
    // either. The third band is lightly used by design - about one draw per
    // demo - which is why it is the smallest share in STAGE_SHARE.
    //
    // This does NOT make organic death likely, and nothing in this range
    // could: Gompertz mortality between 18 and 31 is a fraction of a percent
    // a year, and reaching a meaningful chance inside 32 swipes would need
    // ~1.5 years per swipe, which no minor card - "a moment or a week" - can
    // carry without the fiction collapsing. The forced cap ending is the
    // normal demo ending by design and is written for, in the obituary
    // screen's own `ending === 'demo'` branch. Bankruptcy remains a genuine
    // early exit and does fire.
    //
    // Same key names as BAL.TIME, and the engine's own clamps still apply on
    // top - `timeCostMonths` runs the result through CLAMP.timeMonths and the
    // stage cap exactly as it does for a real life.
    time: {
      minor: 5,
      standard: 9,
      major: 18,
      trivial: 5,
    },

    // Which name origins a demo life may draw from, as a hard allow-list
    // handed to `assignName`'s `categoryAllow`. Null or [] would mean "no
    // restriction", which is what every ordinary life passes.
    //
    // This is a DEMO-ONLY narrowing and it is deliberately the opposite of
    // what the main game wants. The pool exists because an authored list of
    // names converged on the same narrow band life after life, and the
    // category draw is weighted by real birth counts precisely so a player
    // meets the country rather than one origin of it. A demo is a different
    // job: thirty swipes seen once, often by somebody reading over a
    // stranger's shoulder at a booth, where an unfamiliar name is a beat
    // spent on "how do I say that" instead of on the joke.
    //
    // It costs nothing structurally - `categoryAllow` is applied inside
    // `assignName`'s eligibility filter, ahead of every random draw, so it
    // changes WHICH name a draw lands on and never how many randoms it
    // consumes (invariant 6, the same rule region and deactivation follow).
    // 632 active anglo names is far more than a 30-swipe life can spend, so
    // no degradation tier is reachable through this.
    nameCategories: ['anglo'],
  },
};

export default BAL;
