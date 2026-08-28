// Offline scenario supply.
//
// Two jobs: (1) make the game playable with no API key at all, and (2) be the
// safety net when an LLM batch fails validation twice. Templates are stage-
// tagged and lightly randomized so a full 40-80 swipe life never runs dry.

import { nextRandom } from './rng.js';

const T = (stages, weight, scenario, leftLabel, rightLabel, leftEffects, rightEffects) =>
  ({ stages, weight, scenario, leftLabel, rightLabel, leftEffects, rightEffects, source: 'fallback' });

export const TEMPLATES = [
  /* ------------------------------------------------------ early / general */
  T(['early', 'family'], 'minor',
    'Your manager asks, in a tone with a hook in it, whether you have capacity this week.',
    'Say yes', 'Say no',
    { happiness: -5, health: -2, flags: ['overworked'], career: { salary: null } },
    { happiness: 4, flags: ['boundaries'] }),

  T(['early', 'family'], 'standard',
    'A recruiter offers 22% more to do the same job for a company with a worse logo.',
    'Take the money', 'Stay put',
    { happiness: -2, flags: ['job_hopper'], career: { salary: null } },
    { happiness: 2, flags: ['loyal'] }),

  T(['early', 'family', 'late'], 'minor',
    'The check engine light has been on for five weeks. It has stopped feeling like a warning and started feeling like a roommate.',
    'Take it in', 'Ignore it',
    { money: -900, happiness: 2 },
    { happiness: -2, risk: { probability: 0.12, outcome: 'injury', description: 'The car stops in a lane where cars are not supposed to stop.' } }),

  T(['early', 'family'], 'standard',
    'An old friend needs $6,000 and says the words "just until spring."',
    'Lend it', 'Say you cannot',
    { money: -6000, happiness: 5, flags: ['generous'] },
    { happiness: -6, flags: ['kept_the_money'] }),

  T(['early', 'family', 'late'], 'minor',
    'Three drinks in on a Wednesday, which is either a phase or a pattern depending on how you count.',
    'Another round', 'Head home',
    { happiness: 6, health: -4, flags: ['heavy_drinker'] },
    { happiness: -1, health: 2 }),

  T(['early', 'family'], 'standard',
    'Your doctor uses the word "borderline" about a number you did not know you had.',
    'Change everything', 'Change nothing',
    { health: 11, happiness: -4, money: -1200, flags: ['exercises'] },
    { happiness: 2, health: -6, flags: ['chronic_illness'] }),

  /* ---------------------------------------------------- family / midlife */
  T(['family'], 'standard',
    'The school calls. It is not an emergency, they say, in the voice people use for emergencies.',
    'Leave work now', 'Finish the meeting',
    { happiness: 4, money: -400, flags: ['present_parent'] },
    { happiness: -7, flags: ['absent_parent'] }),

  T(['family', 'late'], 'major',
    'A promotion. More money, more travel, and a job description that is mostly other people being upset near you.',
    'Take the promotion', 'Decline it',
    { happiness: -6, health: -4, flags: ['management'], career: { salary: null }, timeCostMonths: 30 },
    { happiness: 5, flags: ['plateaued'], timeCostMonths: 30 }),

  T(['family', 'late'], 'standard',
    'Your parents are getting to the age where the phone ringing at odd hours means something.',
    'Fly out for a week', 'Send money instead',
    { money: -2200, happiness: 6, relationship: { name: 'Mom', qualityDelta: 15 } },
    { money: -4000, happiness: -5, relationship: { name: 'Mom', qualityDelta: -8 } }),

  T(['family', 'late'], 'standard',
    'A financial advisor with excellent teeth explains a product he calls "a vehicle."',
    'Invest', 'Walk out',
    { money: -18000, flags: ['speculator'], risk: { probability: 0.16, outcome: 'windfall', description: 'The vehicle, improbably, drives.' } },
    { happiness: 1, flags: ['cautious_investor'] }),

  T(['family'], 'major',
    'Everything is fine, which is the problem. Somebody suggests a sabbatical.',
    'Take a year off', 'Keep going',
    { money: -30000, happiness: 18, health: 6, flags: ['sabbatical'], timeCostMonths: 12 },
    { happiness: -4, health: -3, timeCostMonths: 24 }),

  T(['family', 'late'], 'major',
    'The marriage has become a logistics arrangement with a shared calendar.',
    'Go to counseling', 'Let it drift',
    // Whoever the spouse turned out to be. A fallback has no business assuming
    // it was Sam: "spouse" resolves to the person already in that role.
    { money: -3600, happiness: 8, relationship: { name: '{{new:spouse}}', role: 'spouse', qualityDelta: 18 } },
    { happiness: -9, relationship: { name: '{{new:spouse}}', role: 'spouse', qualityDelta: -20 }, flags: ['estranged_spouse'] }),

  /* ------------------------------------------------------------ late life */
  T(['late'], 'standard',
    'Layoffs. They call it a "realignment," and there is a slide about it.',
    'Take the severance', 'Fight to stay',
    { money: 40000, happiness: -6, flags: ['laid_off'], career: { title: 'Between things', salary: 0 } },
    { happiness: -10, health: -5, flags: ['survived_layoffs'] }),

  T(['late', 'retirement'], 'standard',
    'A cardiologist would like to talk to you about a word beginning with S.',
    'Have the procedure', 'Wait and see',
    { money: -14000, health: 14, happiness: -3 },
    { happiness: 2, health: -10, risk: { probability: 0.08, outcome: 'death', description: 'The thing the cardiologist was worried about happens on a Sunday, in the garage.' } }),

  T(['late'], 'major',
    'You could stop at 62 with less, or grind to 67 with more. There is a spreadsheet. The spreadsheet does not include how you feel on Mondays.',
    'Retire early', 'Work five more years',
    { retire: true, happiness: 14, health: 4, timeCostMonths: 24 },
    { happiness: -6, health: -6, timeCostMonths: 60 }),

  T(['late', 'retirement'], 'standard',
    'The house is too big now. The stairs have opinions about your knees.',
    'Downsize', 'Stay in the house',
    { money: 90000, happiness: -4, flags: ['downsized'] },
    { money: -8000, happiness: 5, risk: { probability: 0.1, outcome: 'injury', description: 'The stairs win.' } }),

  /* ----------------------------------------------------------- retirement */
  T(['retirement'], 'standard',
    'A cruise. Fourteen days. Your friends describe it as "surprisingly fine," which is how they describe everything now.',
    'Book the cruise', 'Stay home',
    { money: -7000, happiness: 10, health: -1 },
    { happiness: -3, money: 500 }),

  T(['retirement'], 'minor',
    'The grandchildren are here for the weekend and one of them has questions about your entire life.',
    'Tell them everything', 'Tell them the safe version',
    { happiness: 12, flags: ['told_the_truth'] },
    { happiness: 3 }),

  T(['retirement'], 'standard',
    'Your body proposes a new arrangement in which mornings are negotiable.',
    'See the specialist', 'Manage it yourself',
    { money: -6000, health: 10 },
    { health: -12, flags: ['chronic_illness'], happiness: -2 }),

  T(['retirement'], 'minor',
    'A friend from whichever life it was calls out of nowhere, still using your old nickname.',
    'Call back', 'Mean to call back',
    { happiness: 9, flags: ['still_connected'] },
    { happiness: -5 }),

  T(['retirement'], 'major',
    'A man on the phone is very excited about an investment opportunity and knows your first name.',
    'Hear him out', 'Hang up',
    { money: -35000, happiness: -8, flags: ['scammed'] },
    { happiness: 2 }),

  T(['retirement'], 'standard',
    'The doctor asks how far you can walk without stopping. You give a number. The doctor writes down a different number.',
    'Start walking daily', 'Accept the number',
    { health: 8, happiness: 4, flags: ['exercises'] },
    { health: -7, happiness: -2 }),

  /* --------------------------------------------------- stage-agnostic set */
  T(['highschool', 'college', 'early', 'family', 'late', 'retirement'], 'minor',
    'It is 11pm and a decision must be made about whether today is over.',
    'One more hour', 'Sleep',
    { happiness: 3, health: -2 },
    { health: 3, happiness: -1 }),

  T(['college', 'early', 'family', 'late'], 'minor',
    'Somebody is wrong on the internet and has used your name.',
    'Reply', 'Close the tab',
    { happiness: -6, flags: ['posts_online'] },
    { happiness: 3 }),

  T(['college', 'early', 'family', 'late', 'retirement'], 'minor',
    'A dog on the sidewalk has stopped and is looking directly at you, waiting.',
    'Pet the dog', 'Keep walking',
    { happiness: 6, health: 1 },
    { happiness: -2 }),

  T(['highschool', 'college'], 'minor',
    'A stranger at a bus stop asks what you want to be. You have four seconds and no idea.',
    'Tell the truth', 'Make something up',
    { happiness: 4, flags: ['honest'] },
    { happiness: 2, flags: ['performs'] }),

  T(['college', 'early'], 'standard',
    'Your credit card company has approved you for an amount of money that seems, frankly, like a dare.',
    'Take the limit', 'Cut up the card',
    { money: 3000, happiness: 5, flags: ['carries_balance'] },
    { happiness: -2, flags: ['debt_averse'] }),
];

// Picks a template that fits the current stage and flags, avoiding recent repeats.
export function makeFallbackScenario(state, { recentIds = [], stageId = 'early' } = {}) {
  const pool = TEMPLATES.filter((t) => t.stages.includes(stageId));
  const fresh = pool.filter((t) => !recentIds.includes(idFor(t)));
  // When everything is "recent" we still refuse to repeat the last few, so the
  // player never sees the same card twice in a row.
  const justSeen = recentIds.slice(-3);
  const degraded = (pool.length ? pool : TEMPLATES).filter((t) => !justSeen.includes(idFor(t)));
  const from = fresh.length ? fresh : (degraded.length ? degraded : TEMPLATES);
  const chosen = from[Math.floor(nextRandom(state) * from.length)] || from[0];

  const scenario = JSON.parse(JSON.stringify(chosen));
  scenario.id = idFor(chosen);

  // Templates leave `salary: null` where the number should track the player.
  for (const side of ['leftEffects', 'rightEffects']) {
    const career = scenario[side].career;
    if (career && career.salary === null) {
      career.salary = Math.round(Math.max(0, state.career.salary) * 1.08 + 1500);
    }
  }
  return scenario;
}

function idFor(t) {
  let h = 0;
  for (let i = 0; i < t.scenario.length; i++) h = (Math.imul(31, h) + t.scenario.charCodeAt(i)) | 0;
  return 'fb_' + Math.abs(h).toString(36);
}
