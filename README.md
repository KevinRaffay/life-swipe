# Life Swipe

A darkly comic life simulator played entirely through binary swipe decisions.
You start at 16. You swipe left or right. The run ends when you die or go broke.

Reigns, crossed with an actuarial table.

---

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:8787**.

`npm start` builds the client and serves it from the same Express process that
proxies the API. The game is fully playable with no API key at all — it ships
with 26 hand-authored scenarios and 27 procedural templates.

### Adding your API key

The key lives on the server and is never sent to the browser.

```bash
cp .env.example .env
```

Then edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Or export it into the environment instead:

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here   # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
```

Restart the server. The title screen will say `Storyteller: claude-sonnet-4-6`
instead of `Storyteller offline`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | *(none)* | Enables LLM scenarios and obituaries. Without it the game runs on seed content. |
| `PORT` | `8787` | Server port. |
| `LIFESWIPE_MODEL` | `claude-sonnet-4-6` | Model used for both scenarios and obituaries. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Override for a gateway or a mock. |

### Other commands

```bash
npm run dev       # Vite dev server on :5173 + API on :8787, both hot-reloading
npm run serve     # serve an existing build without rebuilding
npm run simulate  # play 100 random lives headlessly and print balance stats
```

---

## The architecture, and why it is split this way

The single most important property of this codebase is that **the LLM is a
writer, not a referee.**

```
   ┌──────────────┐   proposed effects (JSON)   ┌──────────────┐
   │  STORYTELLER │ ──────────────────────────► │    ENGINE    │
   │ claude-sonnet│                             │  plain JS,   │
   │    -4-6      │ ◄────────────────────────── │ deterministic│
   └──────────────┘   state summary + flags     └──────────────┘
      writes fiction                              owns all state
      suggests numbers                            clamps all numbers
      never decides                               rolls all dice
                                                  decides who dies
```

The model writes scenario text and **proposes** effects. It has no authority
over anything. Every number it returns passes through two gates:

1. **`shared/schema.js`** — structural validation. Is this the right shape?
   Runs on the server before a batch is accepted, and again on the client
   before a card is dealt.
2. **`shared/engine.js` → `normalizeEffects()`** — value clamping against live
   game state. A proposed `-$99,999,999` becomes at most a few thousand dollars
   for a sixteen-year-old. A proposed 90% chance of death becomes 8%, the hard
   ceiling, and then **the engine rolls it** — the model never gets to narrate
   an outcome as settled.

If the model returns garbage, the request is retried exactly once with a
stricter instruction. If that also fails, the client falls back to seed content
and the player never finds out anything went wrong.

### Why swiping never waits on the network

`shared/deck.js` buffers scenarios. `deck.draw(state)` is **synchronous and
cannot fail** — it returns the best card available right now and *then* kicks off
a background fetch for more. The priority order is:

1. a buffered LLM card that fits the current stage and flags,
2. an unused hand-authored seed,
3. a procedural fallback template.

A dead API, a slow API, or no API key at all are all just "the buffer is empty",
which the deck already knows how to handle.

---

## Project layout

```
shared/          # runs in BOTH the browser and Node - the engine is the same code
  engine.js      #   state, economics, mortality, clamping, the act of choosing
  balance.js     #   every tunable number, in one file
  schema.js      #   structural validation of anything claiming to be a scenario
  deck.js        #   buffering, eligibility, background refill
  fallback.js    #   27 procedural templates for offline play
  rng.js         #   seeded, serializable PRNG (a run can be replayed exactly)
server/
  index.js       #   Express: serves dist/, proxies Anthropic
  anthropic.js   #   Messages API client (no SDK dependency)
  prompt.js      #   system + user prompts, including delayed-consequence rules
client/src/      # React, plain CSS, no UI framework
  App.jsx        #   wiring: engine + deck + phases
  components/CardStack.jsx   # the swipe gesture
data/
  scenarios-seed.json        # 26 hand-authored early-life scenarios
scripts/
  simulate.js    # headless balance harness
```

---

## Game state

The engine owns all of it. Nothing else may write to it.

| Field | Notes |
| --- | --- |
| `ageMonths` | Time advances a variable amount per swipe: weeks for trivial choices, years for major ones. |
| `money` | Compounds. Savings earn a noisy real return; debt accrues at 9%. |
| `health`, `happiness` | 0–100. Health decays faster after 35. Happiness is pulled back to a setpoint of 55 — the hedonic treadmill is modelled deliberately. |
| `relationships` | `name → { role, quality, flags }`. Flags on people are what make the spouse's drinking a *thing that comes back*. |
| `career`, `education`, `pension` | |
| `flags` | The durable life record: `married_sam`, `sam_heavy_drinker`, `invested_startup`. Passed to the model in full on every call. |
| `history` | Running decision log; the last ~10 go to the model as context. |
| `credits` | Score. Paid out per year survived, scaled by health, happiness and solvency. |

### Death and bankruptcy

Mortality is Gompertz, calibrated against a US life table (~0.03%/yr at 20,
~1% at 60, ~5.5% at 80, ~30% at 100), then modified by health and by flags like
`smoker` or `chronic_illness`. The engine rolls it after every swipe against the
elapsed time.

You go broke when your debt exceeds what anyone would plausibly lend you —
`$20k + 1.5× income`, plus a `$90k` grace for student loans, because being deep
in the red at 22 with a degree is normal, not a game over.

---

## Delayed consequences

This is the thing that makes the game feel like a life rather than a slot
machine, and it is implemented in three places:

- Every call sends the **full flag list**, plus per-person flags.
- The system prompt instructs that roughly **one card in four should be a
  callback** to a flag planted earlier, with worked examples: the spouse flagged
  `heavy_drinker` at 24 becomes an intervention or a divorce arc at 38;
  `cut_corners` in high school becomes a background check at 34.
- The seed content plants the hooks in the first place. Sam is introduced as a
  college roommate with a `heavy_drinker` flag long before marrying Sam is on
  the table.

---

## Balance checking

```bash
npm run simulate            # 100 lives
npm run simulate -- 1000    # 1000 lives
npm run simulate -- 500 42  # 500 lives from base seed 42
```

It plays random lives headlessly with no API in the loop and prints lifespan
percentiles, swipes per life, the money distribution, credits, and a ranked
table of causes of death.

Current numbers for **random** play (a thoughtful player does noticeably
better):

```
LIFESPAN     mean 60.3   median 63   p10 39   p90 77
SWIPES       mean 53.2   median 55   p10 25   p90 76      target 40-80
MONEY        p25 $116k   p50 $651k   p90 $2.2M   broke endings 14%
```

Every knob the sim responds to lives in `shared/balance.js`. Change one number,
re-run, see what it did.

---

## The UI

- Single column, `max-width: 480px`, centred on desktop.
- Drag the card: it translates, tilts, and the choice label for the side you are
  leaning toward fades in. Release past ~88px (or flick) to commit.
- Pointer events throughout, so finger, mouse and pen are one code path.
  `touch-action: none` on the card means the browser never steals the horizontal
  drag for scrolling, and the gesture locks to an axis so a vertical scroll does
  not smear the card sideways.
- Also playable by **tapping the choice buttons** or with the **left/right arrow
  keys**.
- Death or bankruptcy opens the obituary: an LLM-written recap (or a locally
  written one if there is no key), final stats, credits, share-as-text, and
  *Live again*.

---

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Whether the storyteller is enabled, and which model. |
| `POST /api/scenarios` | `{ summary, recent, count }` → validated scenario batch. Always 200; `source` is `llm`, `fallback`, or `none`. |
| `POST /api/obituary` | `{ stats, history }` → `{ headline, obituary, epitaph }`, or a fallback marker. |
| `GET /api/seed-scenarios` | The hand-authored deck. |
| `GET /api/health` | Liveness. |

A failure in the scenario endpoint is never surfaced as an error to the client:
it returns 200 with an empty list and a reason, and the deck carries on.

---

## Adding your own scenarios

Add objects to `data/scenarios-seed.json`. The shape is the same one the model
is asked to produce, plus three optional targeting fields:

```json
{
  "id": "ec_boat",
  "stages": ["family", "late"],
  "requiresFlags": ["married"],
  "forbidsFlags": ["bought_boat"],
  "weight": "major",
  "scenario": "There is a boat. It is not a good boat.",
  "leftLabel": "Buy the boat",
  "rightLabel": "Be reasonable",
  "leftEffects": { "money": -34000, "happiness": 16, "flags": ["bought_boat"] },
  "rightEffects": { "happiness": -3 }
}
```

`weight` sets the default time cost (`trivial` ≈ 1 month, `minor` ≈ 9,
`major` ≈ 30); `timeCostMonths` overrides it. The engine clamps everything
regardless of what you write here, so you cannot break the game from this file —
only make it less funny.

### The canonical flag vocabulary

Most flags are pure story memory and the model invents them freely — that is the
point of them. But a handful drive real mechanics in the engine, so the system
prompt names them explicitly:

| Flag | Effect in the engine |
| --- | --- |
| `in_school` | Lowers living costs, adds work-study income, extends the credit limit. |
| `student_debt` | Adds a $90k grace to the bankruptcy threshold. |
| `married` | Adds household income and household costs. |
| `retired` | Switches income to pension plus social security. |
| `lives_with_parents` | Someone else is paying, until it is cleared. |
| `smoker`, `heavy_drinker`, `chronic_illness` | Raise mortality. |

This matters more than it looks. Before the vocabulary was documented, the model
would write a perfectly good "enrol at community college" card, tag it
`community_college_accounting`, and the engine — which had never heard of that
flag — would keep charging full adult living costs against a student income and
bankrupt the player in their early twenties.

### Two prompt rules that exist because of live play

- **Never narrate the machinery.** The model will, unprompted, write sentences
  like *"the priya_friction flag has been sitting quietly since her Austin
  move."* Flags are the writer's private notes; the player is supposed to see a
  life, not a state machine.
- **The player has no gender.** Left to itself the obituary will pick one
  ("He meant to get to it"), which is a coin flip about a person the game never
  described. Second person throughout, `they` if a pronoun is unavoidable.

### A note on pacing

The 40–80 swipe target holds for average play. A player who consistently takes
the health-preserving option — keeps every scan, treats the blood pressure,
takes the procedure — can stretch a life past 200 swipes, because in this engine
health is the only thing that really kills you. That is arguably correct
behaviour rather than a bug, but it means "one life" is a much longer sitting for
a careful player than a reckless one.

### Seed ordering: variety vs. the spine

`Deck.draw()` picks randomly from every eligible seed, using the run's own
seeded RNG — so openings vary between runs but a given seed still replays
exactly. This matters more than it sounds: the storyteller's first batch takes
~20s to arrive, so the first several cards of *every* run come from the seed
deck. Selecting the first match in file order made every game open with the same
four cards.

Straight randomisation, though, quietly broke the economy — deaths before 40
went from 12% to 21% and broke endings from 14% to 26%, because the file order
had been acting as an uncredited curriculum: college fork, then major, then
first job. A run that shuffled past those never established schooling or a
salary.

Hence `priority`. Ordinary cards shuffle freely; a pending structural card
outranks them:

| Seed | priority | why |
| --- | --- | --- |
| `col_choice` | 3 | sets `in_school`, `student_debt`, education |
| `col_major` | 2 | sets the degree |
| `ec_firstjob` | 2 | sets the first real salary |

Add `"priority": 1` to any seed that has to fire for later cards to make sense.

---

## Content modes

Two modes, chosen on the new-game screen and **locked for the life** — switching
mid-life would orphan in-flight arcs and the flags they planted.

Mode is a tone-and-subject dial, **not a difficulty setting**. Safe mode keeps
every real stake: bankruptcy, illness, injury, divorce, estrangement, accidents
and death. What it drops is drugs, crime, prison and vice.

| | Safe | Mature |
| --- | --- | --- |
| money, health, career, love, family, accidents | yes | yes |
| addiction, crime, arrest, prison, gambling | no | occasionally |
| explicit sexual content | no | **no** |
| how-to detail for anything illegal | no | **no** |

The choice is remembered across lives. Selecting Mature asks for age
confirmation **once**, then never again.

### The hard rule

`effectiveTier({ age, contentMode })` in [content.js](shared/content.js) is the
only function that decides what a life may contain, and **age beats mode**: a
character under 18 gets safe-tier content even in a mature life. This is
engine-enforced, not prompt-suggested. The server recomputes the tier from age
and mode rather than trusting the tier the client sends, so a tampered request
cannot buy mature content for a 15-year-old.

Three independent gates stand between a player and content they did not choose:

1. **Tier** — mature cards are invisible unless the resolved tier is mature.
2. **Arc budget** — see below.
3. **Keyword compliance** — a blunt backstop over scenario text, labels, risk
   descriptions and flag names, run on the server *and* again on the client.

### Why mature mode is not a crime spree

Each mature life rolls a budget of **1–3 dark arcs** at birth, from the run's own
RNG. It is spent, never re-rolled. An arc spans up to 3 cards, with 8 swipes of
quiet enforced between arcs. Measured over 300 lives: mean 1.67 arcs, max 3,
100% of lives inside the 1–3 target.

Dark arcs are also required to bend toward recovery and reentry sometimes, not
only punishment — the mature seed deck ships an intervention, a recovery-year
card and a reentry card alongside the sentencing one.

### Checking it

```bash
npm run simulate -- 300 seed --mode=both
```

The report adds a CONTENT MODE section (arc distribution per life) and two
assertions that **fail the run with exit code 1**:

- no mature content in a safe-mode life
- no mature content dealt to a character under 18, in either mode

Both were verified by deliberately breaking them: mis-tagging a mature seed as
safe *and* disabling all three gates makes the run fail and name every offending
card. With any single gate intact it still passes, which is the point of having
three.

### One judgment call

`MINOR_SUBSTANCES_BLOCKED` in [content.js](shared/content.js) is `false`. The
spec says no drugs for minors full stop; set it `true` for that reading. It ships
`false` because the hand-authored coming-of-age deck depends on exactly that kind
of peer-pressure card — a cigarette offered behind the auditorium, a party with
something blue in the bathtub — and those are the game's most age-appropriate
stakes, not its most adult. Hard drugs, crime, prison, gambling and sexual
content are blocked for minors either way.

---

## The situation library

A curated set of anonymised life-event **shapes** in
[server/situation-library.json](server/situation-library.json) that periodically
seed generation, so lives draw on authentic structures rather than pure model
improvisation.

A pattern never becomes a card by itself. It is a *brief* handed to the
storyteller, which writes the actual scenario and proposes effects; the engine
still validates, clamps, rolls and owns all state. The split is unchanged.

### How a slot is filled

Roughly every 4–6 scenarios (`LIBRARY_INTERVAL` in
[shared/library.js](shared/library.js)) one slot in the next batch is a library
event. Candidates are filtered by age window, content mode, `requires` (all
present), `excludes` (none present), and whether the player has seen the pattern
before; survivors are weighted `common 3 : uncommon 2 : rare 1`. **No survivors
means the slot falls back to ordinary free generation** — the library never
blocks a batch.

Selection runs client-side, not on the server, because it needs two things the
server does not have: the run's own RNG (so a seeded life replays identically)
and the cross-life seen list. The server only injects the brief and echoes back
which pattern it used.

`seen_patterns` lives in `localStorage`, deliberately outside per-life state, so
run #7 does not repeat run #2's library events. A card marks its pattern seen
only when it is actually dealt, not when it is fetched.

### Pending events

Five of the thirteen patterns need a deferred consequence, so the referee gained
one. `addPendingEvent` clamps everything: at most 4 unresolved, due between 6
and 96 months out, no duplicates, labels truncated. Promises nobody keeps expire
after five years. The storyteller proposes `pendingEvent`; the engine decides
when it lands.

### Checking it

`npm run simulate` reports slots offered vs filled, which patterns fired, why
the rest were filtered out, and asserts that **no pattern fires twice for one
player** across three lives.

### Two findings from running it

**Eight of thirteen patterns are DEAD in simulation.** That is not a bug in the
selection code — walking the chain deliberately, `unglamorous_niche_commissions`
→ `windfall_draws_federal_eyes` → `relatives_drawn_into_scheme` →
`associate_trades_information` each becomes eligible in turn, exactly as
designed. It is a property of the content: downstream patterns need flags that
only an upstream pattern sets, flags are per-life, and `seen_patterns` prevents
the upstream one recurring in a later life. So a chain can only complete inside
a single life, and a single life gets ~1.3 library events. The levers are
`LIBRARY_INTERVAL`, more ungated patterns, or letting the storyteller set those
flags from ordinary cards — which it will, in a real run.

**82% of slots fall back to free generation.** Nine of thirteen patterns sit
behind `requires`, so most of the time nothing is eligible. That is the
specified behaviour rather than a failure, and it improves as the library grows.

### Growing the library

```bash
npm run extract-patterns -- path/to/source.txt
```

Sends a memoir summary, obituary or profile to the model and asks for 8–15
patterns, each generalised until it could describe thousands of lives, with
identifying detail discarded. Writes `situation-library.draft.json` and
**never** touches the live library — a person decides what gets merged. Output
is schema-checked, scanned for id collisions, and swept for leaked proper nouns
and years.

Verified on a synthetic life story: 12 candidates, all schema-valid, with none
of the source's distinguishing details ("mill", "launderette", "actuary",
"coastal path") surviving into the patterns.

---

## Seed content: schema, anti-repetition, coverage

### Schema

Every entry in [scenarios-seed.json](data/scenarios-seed.json) now carries
`life_stage` (`[minAge, maxAge]`), `modes`, and `weight`, matching the shape
[situation-library.json](server/situation-library.json) already used.
`life_stage` is the canonical age gate for seed selection.

`weight` was renamed to the three-tier vocabulary and the mapping preserves
pacing exactly, because the engine uses weight for time cost:

| old | new | time | authoring |
| --- | --- | --- | --- |
| `trivial` | `minor` | ~1 month | prompt only |
| `minor` | `standard` | ~9 months | prompt + setting |
| `major` | `major` | ~30 months | full scene |

`trivial` is still accepted as an alias so older model output lands on the short
tier rather than falling through to the default.

### Anti-repetition

`seen_seed_ids` lives in the same per-player, cross-life store as
`seen_patterns` — a rolling window of 120. Every seed or fallback card that is
actually shown is recorded, and excluded from selection until the window rolls
past it.

Selection is a uniform random pick among everything matching the current age,
mode and flags and not in `seen_seed_ids`. **If that leaves nothing, the filter
is ignored for that pick only and a warning is logged**, naming the age and mode
of the bucket that ran dry — because an exhausted pool is precisely what "I keep
seeing the same card" looks like from the inside.

Measured over 40 players, comparing a player's first 12 cards in life 2 against
life 1:

```
WITHOUT seen_seed_ids   repeat rate 52.5%
WITH    seen_seed_ids   repeat rate  0.0%
```

One deliberate deviation from a uniform pick: the `priority` tier still wins.
Structural cards (the college fork, the first job) must fire for the economy to
make sense — removing that previously pushed deaths before 40 from 12% to 21%.
Selection is uniform *within* the top priority tier present.

### Coverage

```bash
npm run coverage
```

Counts unGated scenarios per (life-stage bucket × mode) against the targets: 8
for the first playable bracket, 4 for every other. Exits 1 if any bucket is
short. The same check runs at **server startup** and prints a warning naming
each thin bucket, and `GET /api/coverage` returns the table as JSON.

22 new scenarios were written to clear the gaps — `late` and `retirement` were
at 1 and 0 — and to deepen the opening brackets, where repetition is most
visible. All 12 bucket/mode pairs are now at or above target.

### One knock-on worth knowing

More short cards means more swipes per life: mean rose from ~57 to ~69, with p90
at 102 against a documented target of 40–80. Lifespan is unaffected (mean 62).
If you want the old pacing back, the lever is `BAL.TIME.minor` in
[balance.js](shared/balance.js) or re-tagging some of the new one-line cards as
`standard`. I have left it alone rather than quietly retuning balance that was
not part of this fix.

---

## Scenario format: weight tiers

A card is written in fields rather than one blob. The shape lives in
[shared/scenario-format.js](shared/scenario-format.js) and is the single place
the tier rules are defined.

| field | minor | standard | major |
| --- | --- | --- | --- |
| `setting` — place and time | — | yes | yes |
| `beat` — one line of action | — | — | yes |
| `dialogue` — one exchange, max | — | — | yes |
| `prompt` — the decision | **always** | **always** | **always** |

`minor` is prompt-only and is most cards, because that is what keeps the swipe
rhythm. `major` gets a 60–90 word budget across all four fields.

This reconciles with, rather than replaces, the `weight` field added earlier:
the vocabulary (`minor` / `standard` / `major`) and its time costs are unchanged.

### Rendering

`ScenarioBody` in [CardStack.jsx](client/src/components/CardStack.jsx) renders
each field with its own treatment — setting as a light tracked overline, beat as
muted body text, dialogue italic behind a coloured rule, prompt at full weight —
and every field except `prompt` is optional, so a minor card is a single line
with no empty scaffolding.

### Backwards compatibility

`scenario` is now **derived, never authored**: the validator joins the tiered
fields into one string. Fifteen call sites read it (history, obituaries, the
content backstop, the simulator) and none needed changing. A card written in the
old single-field shape still validates — its `scenario` becomes the `prompt`.

That derivation matters for safety, not just convenience: mature content in a
`dialogue` line is still caught by the content backstop, because the string it
scans is built from every field. Verified directly.

### What the validator enforces

Fields outside a tier's set are dropped rather than rejected — a card with one
field too many is still playable. It also strips screenplay habits the house
style does not use: `INT.`/`EXT.` sluglines, `CUT TO`, camera directions, and
`NAME:` in capitals. Dialogue is truncated to one exchange.

`narrativeWarnings()` reports word-budget drift for content tooling. All 57
seeds currently pass with zero warnings; majors run 60–88 words, mean 69.

### A pacing bug this surfaced

`fallback.js` templates never received the `weight` migration from the previous
change, so their `minor` still meant the 9-month tier while everything else had
moved on. Migrating them fixed the regression flagged there: swipes per life in
safe mode drop from ~69 back to **56.8 (p90 79)**, inside the 40–80 target.

### Anti-repetition: the window is measured in lives

`seen_seed_ids` excludes anything shown in the **last two lives**, not the last
N cards. That distinction is the whole thing, and two earlier attempts got it
wrong in opposite directions:

| window | opening repeat rate | warnings/life | why it failed |
| --- | --- | --- | --- |
| 120 cards | 0% | up to 29 | larger than the 57-card corpus, so it never rolled — every card ended permanently excluded |
| 23 cards | 50.6% | 0 | a life draws ~50 cards, so the previous life's opening was always forgiven |
| **2 lives** | **5.6%** | **2–6** | immune to corpus size and life length |

The remaining warnings are legitimate: deep into a 200-swipe life a bucket
genuinely can run dry, because one life draws more cards than a bucket holds.
They are throttled to one per five-year age band per life, and the message says
so rather than pointing at coverage, which was never the problem.
