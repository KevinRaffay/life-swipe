# Life Swipe — working notes

A darkly comic life simulator played through binary swipe decisions. One life,
age 16 until death or bankruptcy, 40–80 swipes.

Keep this file current. When a rule, invariant or feature status changes,
update it in the same commit as the change.

---

## The one rule everything else serves

**The LLM is the storyteller. A deterministic engine is the referee.**

The model writes scenario text and *proposes* effects. It has no authority over
anything. The engine owns all state, clamps every proposed number against live
state, rolls every probability, and decides death and bankruptcy.

A proposed 90% chance of death becomes 8% and then **the engine rolls it**.

Never let generated content mutate state directly, and never move a decision
from the engine into the prompt. If a feature seems to need that, it doesn't.

---

## Invariants

Breaking any of these is a bug regardless of what the tests say.

1. **The model never mutates state.** It returns proposals; `applyChoice` is the
   only thing that writes.
2. **Age beats mode.** `effectiveTier({age, contentMode})` in `shared/content.js`
   is the *only* function that decides what a life may contain. Under 18 gets
   safe-tier content even in a mature life. The server recomputes this from age
   and mode rather than trusting the tier the client sent.
3. **Every number is clamped against live state.** `normalizeEffects` caps money
   by income and net worth, stats to ±25, death risk to 8%.
4. **`deck.draw(state)` is synchronous and cannot fail.** It returns the best
   card available now — buffered LLM card, then unused seed, then procedural
   fallback — and refills in the background. Swiping never waits on the network.
5. **`scenario` is derived, never authored.** The validator joins
   `setting/beat/dialogue/prompt` into one string. ~15 call sites read it,
   including the content backstop — which is why mature content hidden in a
   `dialogue` line is still caught.
6. **Runs are deterministic.** The RNG state is a serializable uint32 inside
   game state. A given seed replays identically. Anything that consumes
   randomness must go through `nextRandom(state)`. One documented input sits
   alongside the seed: the session's **region**, which tilts name selection, so
   a replay is identical given the same seed *and* region. Region changes which
   name a draw lands on, never how many randoms it consumes, so the stream
   stays aligned either way.
7. **Cross-life memory lives outside per-life state.** `seen_patterns` and
   `seen_seed_ids` are per-player, in `localStorage`, never in the state object.
8. **The engine names the cast.** Nobody in a life is named in advance except
   Mom and Dad. The storyteller emits `{{new:roommate}}` and the seed deck
   writes `{{cast:sam}}`; `shared/names.js` picks the name and `Deck.draw`
   resolves it at deal time. The model never invents a name and never renames
   anyone — `state.relationships` is keyed by name, so a rename silently forks
   a person in two. Assigned names live in the relationships map as before;
   `state.names.byTag` only remembers which tag meant whom.
9. **Content gates are defence in depth.** Three independent gates stand between
   a player and content they didn't choose: tier visibility, the dark-arc
   budget, and the keyword backstop. Don't collapse them into one.

---

## Architecture map

| file | owns |
| --- | --- |
| `shared/engine.js` | state, economics, mortality, clamping, pending events. The referee. |
| `shared/balance.js` | every tunable number. Change here, then `npm run simulate`. |
| `shared/schema.js` | structural validation + mode compliance. Runs server-side *and* client-side. |
| `shared/content.js` | content-mode policy, the minor rule, keyword detection, dark-arc budget. |
| `shared/scenario-format.js` | weight tiers and which narrative fields each carries. |
| `shared/names.js` | the name pool reader, era filter, diversity and regional weighting, tag resolution, drift check. |
| `shared/regions.js` | region codes and labels, shared by the server resolver and the settings dropdown. |
| `server/name-pool.json` | 187 names across 49 origins, with era, gender and per-region frequency. Data only. |
| `server/geo.js` | offline IP → region. Holds the privacy contract; read it before touching location. |
| `scripts/build-region-weights.js` | one-time: SSA birth data → the `region_frequency` maps. |
| `shared/library.js` | situation-library selection, filtering, rarity weighting. |
| `shared/deck.js` | buffering, eligibility, background refill, anti-repetition. |
| `shared/fallback.js` | procedural templates so offline play never runs dry. |
| `server/index.js` | serves `dist/`, proxies Anthropic, resolves the content tier. |
| `server/prompt.js` | system + user prompts. (The spec calls this `llm.js`.) |
| `server/anthropic.js` | Messages API client, no SDK. |
| `client/src/prefs.js` | per-player cross-life memory. |
| `client/src/components/CardStack.jsx` | the swipe gesture and tiered card rendering. |

`shared/` runs in both the browser and Node — the simulator exercises the same
engine that ships.

---

## Commands

```bash
npm start                              # build + serve on :8787
npm run dev                            # vite :5173 + api :8787
npm run simulate -- 300 seed --mode=both
npm run coverage                       # seed coverage per bucket/mode
npm run names                          # validate the name pool + measure its spread
npm run build-region-weights -- <dir>  # regenerate region_frequency from SSA data
npm run extract-patterns -- source.txt # draft library patterns (never auto-merges)
```

---

## Content model

**Weight tiers** — `minor` / `standard` / `major`. One vocabulary, two meanings
that must stay in sync: authoring detail *and* time cost.

| tier | fields | time |
| --- | --- | --- |
| `minor` | prompt only | ~1 month |
| `standard` | setting + prompt | ~9 months |
| `major` | setting + beat + dialogue + prompt, 60–90 words | ~30 months |

`trivial` is a legacy alias for `minor`. Most cards should be `minor` — that is
what keeps the swipe rhythm.

**Content modes** — `safe` and `mature`, chosen at start, locked for the life.
Mode is a tone dial, not a difficulty setting: safe keeps bankruptcy, illness,
divorce, accidents and death; it drops drugs, crime, prison and vice. A mature
life rolls a budget of **1–3 dark arcs at birth** and spends it — never
re-rolled, which is what stops it becoming a crime spree.

**Situation library** — 13 anonymised life-event *shapes* that brief the
storyteller roughly every 4–6 scenarios. A pattern is never a card by itself.
Selection runs client-side because it needs the run's RNG and the cross-life
seen list.

**Seed deck** — 57 hand-authored scenarios plus 27 procedural fallback
templates. Coverage targets: 8 for the opening bracket, 4 elsewhere, per mode.

**Names** — 187 names across 49 cultural origins in `server/name-pool.json`,
each carrying the era it was in use and any gender it reads as. The engine
filters by the character's implied birth year (`PRESENT_YEAR` in `balance.js`,
plus a per-role age offset) and then samples **category first**, weighted
`1/(1+used)^1.5` against origins this life has already spent — a uniform draw
over the whole pool would just hand out names in proportion to how many of each
origin the file happens to contain.

Two tag forms, resolved identically; what differs is who writes them.
`{{new:roommate}}` is the storyteller introducing somebody, where the role is
the whole identity (`{{new:roommate#2}}` for a deliberate second). `{{cast:sam}}`
is an authored recurring character in the seed deck, where the **id** is the
identity — Sam is a roommate at 19, a partner at 21 and a spouse at 27, and a
role-derived key would make them three different people. The cast id doubles as
the age/gender hint, so a non-role id names a peer; a cast member who is a
parent or a boss needs the role word in the id.

The seed deck's four authored characters (`cast:best friend`, `cast:sam`,
`cast:casey`, `cast:dev`) are named per life, the friend at `createState` and
the rest on the card that introduces them. **Mom and Dad stay Mom and Dad** —
those are how you address a parent, not names, and nobody calls their father by
his first name in the second person. `npm run names` fails if any seed card
hardcodes a name other than those two.

**Regional weighting** — the second dimension, after era. Each name carries a
`region_frequency` map of *location quotients* measured from SSA state-level
birth records: `"US-MN": 25` means twenty-five times commoner in Minnesota than
nationally. `BAL.NAMES.regionPower` (0.5) damps it and `regionCeiling` (6) caps
it, so it tilts the draw without deciding it — measured lift is 1.4–1.7× on a
region's own origins, with the top-8 origin share moving only 19% → 21–25%.

Three rules hold the design together, and all three are the same rule:

- **A weight, never a filter.** Nothing is excluded for being regionally
  unusual. People move; a Minnesotan pool of only Minnesotan names would be a
  worse lie than the one this feature set out to fix.
- **Absence means no signal, not exclusion.** A missing region, a missing name
  entry, anywhere outside the US, or Florida (absent from the published SSA
  archive) all score exactly 1 and change nothing.
- **The data describes reality; we do not.** Every number is counted from birth
  records. Hand-writing weights is how you encode a stereotype instead of a
  demographic — see the warning under "Measure, don't assume".

Region belongs to the **session**, not the life: it says who is playing, not
who the character is, so a story that moves them to another state does not
change it, and it never enters saved game state.

---

## Verification expectations

Three commands must exit 0 before anything merges:

```bash
npm run simulate -- 200 x --mode=both   # five hard assertions
npm run coverage                        # every bucket at target
npm run names                           # pool is well formed, spreads, tilts by
                                        # region, and no seed card hardcodes a name
```

The assertions are:
- no mature content in a safe-mode life
- no mature content dealt to a character under 18, in either mode
- no library pattern fires twice for the same player
- no unresolved `{{new:role}}` tag reaches a player
- no two characters in one life share a first name

The naming assertions only mean something because the simulator injects
synthetic tagged cards (`synthesiseNamedCard`) — with no model in the loop
nothing would otherwise emit a tag, and the whole path would pass untested.
The duplicate-name check reads `state.names.byTag`, **not** the relationships
map: the map is keyed by name, so a collision there does not appear as two
entries, it appears as two people quietly becoming one. Checking the map
instead gave an assertion that could never fail, which is how it was found.

**Measure, don't assume.** Every significant bug in this project was found by
running a number, not by reading code:

- `od'?d` matched the word **"odd"**, flagging 487 ordinary cards as drug
  content and silently inflating the dark-arc budget.
- Stems inside `\b(...)\b` could never match their own suffixes, so `embezzl`
  never matched "embezzlement" — a hole exactly where the backstop mattered.
- A seen-window of 120 cards against a 57-card corpus never rolled, so every
  card ended permanently excluded.
- The fix for that (23-card window) sent the opening repeat rate straight back
  to 50.6%, because a life draws ~50 cards. **Zero warnings looked like success
  and was actually the system giving up.**
- The regional check first asserted, by hand, that California should favour
  Armenian and Filipino names. It failed — while the weighting was working
  perfectly. Both *are* elevated in California (3.4× and 1.7×), but Vietnamese
  and Persian are elevated more, so the hand-written expectation lost. The
  check now reads its expectations out of the data. **A test that encodes your
  assumption about who lives where measures your assumption, not the code.**
- Raw state counts are useless for this: every name "peaks" in California,
  because California has the most births. Only per-capita comparison
  (a location quotient) says anything.

If a test has never failed, it has not been tested. Break it deliberately and
confirm it fails before trusting it.

---

## Gotchas

- **Heredocs eat backslashes** when routed through a patch script's template
  literal. Anything containing regex must be written directly to its file, or
  spliced by line with `String.raw`. This has cost several cycles.
- **`/tmp` differs**: bash resolves it to AppData, node resolves it to `C:\tmp`.
  Use the scratchpad with a full Windows path for anything node will open.
- **The Bash tool truncates around 8KB**, which silently breaks long heredocs —
  the terminator is lost and bash reports "unexpected EOF". Write in chunks.
- **`PATH` needs exporting** in the Bash tool before node/git/coreutils resolve.
- **The SSA source data is not committed.** 114MB extracted, and
  `scripts/build-region-weights.js` only needs it once. Get it from
  <https://www.ssa.gov/oact/babynames/limits.html> ("State-specific data"), unzip
  anywhere, pass the directory. Two things about the archive that surprised us:
  **Florida is missing** from it, and it stops at 2015 — both degrade to
  no-regional-signal rather than to anything wrong. Note also that ssa.gov
  blocks some automated egress with a 403; the same archive is mirrored on
  GitHub, and `npm run names` will tell you if what you fed it was wrong.
- **JSON imported from `shared/` needs the import attribute.** `shared/` runs in
  the browser, the server and the simulator, and a vite alias like `@library`
  means nothing to the last two. Use
  `import pool from '../server/name-pool.json' with { type: 'json' }` — Node 22+
  and Rollup 4 both take it, and vite inlines the file into the bundle.
- **Don't leave a server on :8787.** It has blocked the user's `npm start` once.
  Check ownership before killing anything on that port — it may be theirs.

---

## Branch workflow

New work goes on a branch off `dev`. **The user merges to `main` themselves**
after testing; do not merge to `main` unless explicitly asked.

```
main   ← user merges, after testing dev
dev    ← integration branch, work lands here
<feature branches off dev>
```

---

## Feature status

| feature | state | notes |
| --- | --- | --- |
| Engine, economics, mortality | shipped | on `main` |
| LLM storyteller + validation + retry | shipped | on `main` |
| Situation library + pending events | shipped | on `main` |
| Content modes (safe/mature) | shipped | on `main` |
| Electric-dusk visual restyle | shipped | on `main` |
| Seed schema, anti-repetition, coverage | **on `dev`, awaiting user testing** | |
| Scenario tiers (setting/beat/dialogue/prompt) | **on `dev`, awaiting user testing** | |
| Seen-window measured in lives | **on `dev`, awaiting user testing** | |
| Engine-controlled name assignment | **on `dev`, awaiting user testing** | pool, both tag forms, drift check, preview path, randomized seed-deck cast |
| Regional name weighting | **on `dev`, awaiting user testing** | offline geoip, settings override, SSA-derived weights. Adds `geoip-lite`, so `npm install` before running |

---

## Location and privacy

The game stores **one region code** per player — `US-MN`, or a bare country
like `DE` — and uses it for exactly one thing: tilting which names the engine
hands out. The rules, in short, with `server/geo.js` holding the long version:

- Resolution is **offline**, via `geoip-lite`'s bundled database. The player's
  IP is never sent to a third party. That is the whole reason it is not an API
  call to a geolocation service.
- The IP is read inside `resolveRegion()` and dropped there. Never logged,
  never returned to the client, never written down.
- geoip-lite also returns city, coordinates, timezone and metro code on every
  lookup. All of it is discarded at the boundary and **must stay discarded**.
- What is stored is coarse by construction: a US state is millions of people.
  It is the coarsest thing that still carries a name-frequency signal.
- IP geolocation is **wrong for a lot of people** — VPNs, mobile carriers,
  corporate egress. So it is only ever a default. The settings dropdown lets a
  player pin any region or switch weighting off, and their choice always wins.
- `TRUST_PROXY` is off by default: trusting `X-Forwarded-For` from an untrusted
  client would let it claim any region. Set it only when a proxy really is
  in front.

### Known open items

- **8 of 13 library patterns are dead in simulation.** Not a selection bug —
  chains need upstream flags that `seen_patterns` prevents recurring, so a chain
  can only complete inside one life. Levers: `LIBRARY_INTERVAL`, more ungated
  patterns, or the live model setting those flags from ordinary cards.
- **82% of library slots fall back** to free generation, because 9 of 13
  patterns sit behind `requires`. Specified behaviour; improves as the library
  grows.
- **Mature-mode lives run short** — mean 39.6 swipes, p10 19, against a 40–80
  target, because the mature seed deck is financially brutal. Pre-existing.
- **`MINOR_SUBSTANCES_BLOCKED` is `false`** in `content.js`. The spec's stricter
  reading is `true`; it ships `false` so the coming-of-age deck keeps its
  peer-pressure cards. Hard drugs, crime, prison, gambling and sexual content
  are blocked for minors either way.
