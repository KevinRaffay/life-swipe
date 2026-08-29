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
   resolves it at deal time, across every field a player can read — the
   narrative fields, a relationship's name, **and the two choice labels**
   (`NAMED_FIELDS`, which `Deck.resolveNames` imports rather than restating).
   The model never invents a name and never renames anyone —
   `state.relationships` is keyed by name, so a rename silently forks a person
   in two. Assigned names live in the relationships map as before;
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
| `server/llm.js` | wraps the Anthropic call with request/response logging. The generation endpoint calls this instead of `anthropic.js` directly; obituary, extraction and admin preview do not. |
| `server/log-store.js` | the log file itself: append, size/count rotation to gzip, paginated + filtered reads across rotated files, summary stats. |
| `client/src/prefs.js` | per-player cross-life memory. |
| `client/src/components/CardStack.jsx` | the swipe gesture and tiered card rendering. |
| `server/admin/` | the content admin API. Localhost only, no auth — read `index.js` before touching it. |
| `server/admin/store.js` | the ONLY thing that writes content files: backup, atomic write, version check, key order. |
| `server/extraction.js` | the extraction prompt and checks, shared by the CLI and the admin. |
| `server/harvest.js` | mining the LLM request log for content worth keeping: eligibility, de-personalisation, generalisability, both draft paths. Reads the log, writes nothing. |
| `shared/provenance.js` | the authoring-provenance vocabulary (`hand-authored`/`extracted`/`generated`/`harvested`) and the harvested-share maths. |
| `admin/` | the admin React app. Its own Vite root; never an input to the player build. |

`shared/` runs in both the browser and Node — the simulator exercises the same
engine that ships.

---

## Current file structure

The concrete `server/` and `client/` files, with what each one owns. **Keep
this current**: when a file is added, renamed, merged or deleted, update this
section in the same commit — a stale map is worse than none. (`shared/`,
`scripts/` and `data/` are covered by the Architecture map above.)

**`server/`** — the API process (Node, ESM).

| file | owns |
| --- | --- |
| `server/index.js` | the HTTP server: serves `dist/`, the `/api/*` endpoints (`scenarios`, `obituary`, `region`, `coverage`, seed/library/name-pool reads), resolves the content tier, and mounts the admin when bound to loopback. |
| `server/anthropic.js` | the Messages API client, hand-rolled (no SDK). Holds the API key check, `MODEL`, `complete`, `extractJson`. |
| `server/llm.js` | wraps the `anthropic.js` call for `/api/scenarios` with request/response logging; returns a `finalizeLog` closure the caller invokes after validation. |
| `server/prompt.js` | builds the system + user storyteller prompts and the obituary prompt. (The spec calls this `llm.js`.) |
| `server/log-store.js` | the LLM log file: append, size/count rotation to gzip, paginated + filtered reads across rotated files, summary stats. |
| `server/extraction.js` | the pattern-extraction prompt and its checks (anonymity sweep, duplicate scoring, id collisions); shared by the CLI and the admin. |
| `server/seed-generation.js` | bulk offline generation of seed-scenario drafts for coverage-thin buckets: a generic per-bucket sample state, the weight-tier mix, occasional situation-library grounding, all down the real prompt/validator path. Shared by the CLI and the admin, same relationship `server/extraction.js` has to pattern extraction. |
| `server/harvest.js` | the content harvester: reads `server/logs/llm-requests.jsonl`, filters it to server-key calls that passed validation, puts the cast's name tags back into the cards, drops the ones that only make sense inside one life, and proposes seed-deck and situation-library drafts. Never writes a content file - the admin route does the appending. |
| `server/geo.js` | offline IP → region via `geoip-lite`. Holds the privacy contract; read it before touching location. |
| `server/name-pool.json` | data only: 187 names across 49 origins, with era, gender and per-region frequency. |
| `server/situation-library.json` | data only: the situation-library life-event shapes the storyteller is briefed with. |
| `server/admin/index.js` | the admin API router; mounted at `/admin`, loopback-only, no auth. Every route can rewrite content files. |
| `server/admin/store.js` | the ONLY writer of content files: `.bak` backup, temp-file atomic write, content-hash version check. |
| `server/admin/preview.js` | live preview: runs the real generation path against fresh in-memory sample state and returns raw + validated output, including the cards `/api/scenarios` would have dropped. |
| `server/admin/cross-reference.js` | best-effort reachability check: which library `requires` flags nothing in the game ever sets. Advisory, never a save blocker. |
| `server/admin/content-schema.js` | field-level validation for the two editable content types, reusing the extraction checks and the game's own `validateScenario`. |

**`client/`** — the player app (React, built by Vite to `dist/`).

| file | owns |
| --- | --- |
| `client/index.html` | the Vite HTML entry. |
| `client/src/main.jsx` | mounts the React root. |
| `client/src/App.jsx` | the root component: the game loop, the `Deck`, engine calls (`createState`/`applyChoice`/`stateSummary`) and which screen is showing. |
| `client/src/api.js` | the client half of the LLM wiring: best-effort POSTs to the server that fall back to seed content silently. |
| `client/src/prefs.js` | per-player cross-life memory in `localStorage` (content mode, age gate, region choice, `seen_patterns`/`seen_seed_ids`), every access wrapped. |
| `client/src/styles.css` | all styles. |
| `client/src/components/CardStack.jsx` | the swipe gesture (pointer events), tiered card rendering, and `useFitToCard` — the measure-and-shrink pass that keeps a long card inside its box so it never scrolls. |
| `client/src/components/Hud.jsx` | the stats HUD (money/health/happiness/age) and the shared money formatter. |
| `client/src/components/StartScreen.jsx` | the start screen: content-mode pick, age confirmation, region choice. |
| `client/src/severity.js` | classifies a turn's consequences as `major` or `standard` for EventToast - the one place the toast/modal threshold is tuned. |
| `client/src/components/EventToast.jsx` | the toast of what the engine did to the player after the last swipe: fixed ~3-4s duration, paused while a pointer is down, tap to dismiss early. Routes `major` turns to `ConsequenceModal` instead. |
| `client/src/components/ConsequenceModal.jsx` | the dismissible dialog for major-tier consequences (a pending event resolving, a significant new flag, a large stat swing). Same centered-dialog pattern as `admin/src/components/Modal.jsx`, reimplemented client-side since admin never ships to players. |
| `client/src/components/Obituary.jsx` | the end-of-life screen; fetches the obituary and falls back to a locally written one. |

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
npm run generate-seeds -- --mode=both --target=15  # draft seed scenarios for thin buckets (never auto-merges)
npm run admin                          # build dist-admin/, serve, open :8787/admin
npm run dev:admin                      # admin vite :5174 + api, for admin UI work
npm run normalise-content              # rewrite content files in canonical key order
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

A major card also carries per-field budgets, anchored by a worked exemplar in
the system prompt: setting 15–20 words, beat 15–20 (with a real specific
number), dialogue 12–18 as *reported* speech ("Dad says he will…", not a
quoted line), prompt 18–25 framed as a values/identity choice. Every major
card needs at least one concrete number — a dollar amount, an age, a
quantity, a date. Drift outside ±30% of a field budget, or a missing number,
is *logged* (`narrativeWarnings` → `validationWarnings` on the call record),
never rejected.

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
`server/seed-generation.js` (CLI: `npm run generate-seeds`; admin: the
"Generate seeds" tab) bulk-drafts candidates for whichever bucket/mode pairs
`npm run coverage` flags as short, down the real prompt/validator path against
a generic per-bucket sample state — never a real player's. Draft-only, same as
extraction: it writes `scenarios-seed.draft.json` and stops. Every bucket
meeting its target is the common case, in which a plain run has nothing to
do; `--force` (CLI) / the "generate even for buckets that already meet their
coverage target" checkbox (admin) generates for every bucket/mode pair
regardless, since the bare target is a floor, not a ceiling on how much
variety a bucket is worth having.

**Content provenance** — every library pattern and seed scenario records where
it came from, in a `source` field: `hand-authored` (a person, in the admin forms
or the JSON directly), `extracted` (`server/extraction.js`, from pasted external
text), `generated` (`server/seed-generation.js`, bulk drafting) or `harvested`
(`server/harvest.js`, mined from the request log). A record written before the
field existed reads as hand-authored, which is what it is. `shared/provenance.js`
owns the vocabulary.

This is **not** the runtime `source` `shared/deck.js` stamps on a dealt card
(`seed`/`llm`/`fallback`/`library`) — the deck overwrites that for every seed at
load time, so the two never meet, and nothing in the game loop reads the
authoring value. The admin's Stats tab shows the **harvested share** of the deck
and the library. Watch it; nothing enforces it. A deck that becomes mostly
harvested from itself narrows toward the model's own most common outputs.

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
- no unresolved `{{new:role}}` tag reaches a player, in prose **or on a
  choice button**
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
- The unresolved-tag assertion read `scenario` and `prompt` and was described
  as "no tag reached a player". It had never read the choice labels, so two
  seed cards shipped a literal `{{cast:sam}}` on a button, under a prompt that
  named the same person correctly. **An assertion is only as wide as the fields
  it actually looks at, whatever its message claims.** Widening it was not
  enough on its own either: reverting only `Deck.resolveNames`'s duplicate field
  list still passed, because every card in the sim that tagged a label also
  tagged its prose and got dragged through the resolver anyway — so the sim now
  injects a label-only card too.
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

- **A synchronous throw escapes `Promise.resolve(fn()).catch()`.** The admin's
  error wrapper used that shape, so a version-conflict error — which the store
  throws synchronously — bypassed it and the client got Express's HTML error
  page instead of JSON. `async` + `try/await` catches both. Found by exercising
  the conflict path, not by reading the code.
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

New work goes on a branch off `dev`. Always create that branch before starting
a new feature — never commit a new feature straight to `dev`. Name it short
and `kebab-case`, describing the feature (`request-response-logging`, not
`fix` or `feature/thing` or `request_response_logging`). **The user merges to
`main` themselves** after testing; do not merge to `main` unless explicitly
asked.

```
main   ← user merges, after testing dev
dev    ← integration branch, work lands here
<feature branches off dev, short kebab-case name>
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
| Seed schema, anti-repetition, coverage | shipped | on `main` |
| Scenario tiers (setting/beat/dialogue/prompt) | shipped | on `main` |
| Seen-window measured in lives | shipped | on `main` |
| Engine-controlled name assignment | shipped | on `main` — pool, both tag forms, drift check, preview path, randomized seed-deck cast |
| Regional name weighting | shipped | on `main` — offline geoip, settings override, SSA-derived weights |
| Content admin module | shipped | on `main` — localhost only, no auth. Thread editor deliberately absent until `thread-templates.json` exists |
| LLM request/response logging + log viewer | shipped | on `main` — wraps the `/api/scenarios` generation call only (not obituary, extraction or preview); JSON Lines, gzip rotation, `/admin` Logs tab |
| Admin edit forms open in a modal dialog | shipped | on `dev` — library, seed and draft-review forms open in a centered dialog (`admin/src/components/Modal.jsx`) instead of inline below the grid; Esc/backdrop-click/Cancel discard and unmount. The cross-reference warnings panel stays above the grid, not in the dialog. Draft review gained a row-level quick "Approve" alongside "Edit & approve". No data logic, validation or API changes |
| Extraction content dedup check | shipped | on `dev` — `duplicateWarnings` flags likely repeat patterns by word overlap; see the admin module section below |
| Major-tier exemplar prompt + craft warnings | shipped | on `dev` — worked exemplar and per-field word budgets in the system prompt; log-only `validationWarnings` through `validateBatch` → `finalizeLog` → Logs tab; 5 weakest major seeds rewritten (`col_major`, `col_dropout`, `ec_move`, `ec_kid`, `lt_severance_or_stay`) |
| EventToast timing fix + consequence modal | shipped | on `dev` — toast duration fixed at ~3.8s (was a flat 4.2s regardless of read time), paused while a pointer is down anywhere on screen, tap-to-dismiss-early. `client/src/severity.js` classifies each turn's events/new-flags/stat-delta as `major` or `standard`; `major` (a resolved pending event, a significant new flag, or a ±15+ health/happiness swing - all tunable in that one file) routes through `ConsequenceModal` (explicit tap to close) instead of the toast. Presentation-only: no engine/effect changes. |
| Career/education continuity | shipped | on `dev` — same class of bug as off-screen relationship reintroduction, different mechanism: `stateSummary()` in `shared/engine.js` now derives a `careerBackground` object (current occupation, current education, and any of `CAREER_BACKGROUND_FLAGS` = `college_degree`/`trade_cert`/`white_collar_experience` the life has earned), computed fresh every call so it can never scroll out of the trimmed recent-history window. Surfaced in every generation prompt as its own STATE line, plus a new CAREER BACKGROUND FLAGS / CAREER PLAUSIBILITY block in the system prompt instructing the model that a white-collar offer needs a bridging event without a qualifying flag already on record. Four career-category situation-library patterns that previously fired with `requires: []` despite presupposing white-collar standing (`early_career_toxic_mentor`, `early_career_toxic_mentorship`, `market_crash_job_loss`, `market_crash_job_loss_2`) now require `college_degree`; the seed deck's `col_major` (declaring a CS/philosophy major) sets it. No engine/effect-resolution changes - purely context completeness and library gating |
| Off-screen relationship reintroduction | shipped | on `dev` — a named relationship absent from the recent-history window is marked `[OFF-SCREEN lately]` in the prompt's people line (which already carries role/flags), and the storyteller is asked to reintroduce it by role on first mention ("Dmitri, the guy from your study group") rather than a bare name. Log-only backstop `checkReintroductions` (`shared/names.js`) fires through `validateBatch` → `validationWarnings` → Logs tab across all tiers, best-effort string match. No tier budgets, structure or effect/engine changes; no question-mark/either-or rule added |
| Bulk seed-scenario generation | shipped | on `bulk-seed-generation` — `server/seed-generation.js` drafts candidates for whichever bucket/mode pairs `npm run coverage` flags short, down the real `server/prompt.js` templates and `shared/schema.js`/`shared/content.js` validators against a generic per-bucket sample state (built from the real engine's `createState`, trimmed to Mom/Dad only so no card can hardcode one throwaway life's assigned names). Weight-tier mix biased toward minor (`tierQuotas`); roughly 1-in-4-5 candidates ground in an eligible situation-library pattern via `shared/library.js`'s own `filterPatterns`. `npm run generate-seeds -- --mode=both --target=15` (CLI) and the admin's "Generate seeds" tab (`POST /api/generate-seeds`) share this core. Draft-only: writes `scenarios-seed.draft.json`, never `data/scenarios-seed.json`. Draft review generalises the existing pattern-draft approve/reject/edit routes (`server/admin/index.js`'s `draftRoutes`) and UI (`admin/src/components/DraftQueue.jsx`, extracted from `Extraction.jsx`) to a second draft/target pair rather than duplicating them. `force` (CLI `--force`, admin checkbox) generates for every bucket/mode pair regardless of current coverage, not only short ones - the common case once the deck is healthy is that a plain run has nothing to do. No live generation path, engine or validator changes |
| Content harvesting pipeline | shipped | on `dev` — `server/harvest.js` mines `server/logs/llm-requests.jsonl` for live generations worth keeping and routes them into the two existing draft queues. Eligibility: `keySource === "server"` (a NEW log field, `server/llm.js` ← `meta.keySource`, declared by `server/index.js`'s generation call; there is no BYOK path in the codebase, and an UNDECLARED key source records null and is ineligible, so nothing logged before this feature can be harvested and a future BYOK path that forgets to declare itself is excluded by default rather than swept in), `validationResult === "passed"`, and per-CARD craft warnings at or below a configurable threshold (default 0 — `validateBatch` indexes each warning by raw-array position, so one over-budget major does not disqualify its neighbours). Seed path → `scenarios-seed.draft.json`: the card as written, de-personalised by reading the cast back out of the logged prompt and reversing `shared/names.js`'s resolution (narrative fields get the tag; choice LABELS get the role in plain words, so a person named only on a button does not cost a fresh name), screened against story-memory flag callbacks and explicit back-references to a decision this player already made, gated with `requiresFlags: ["married"]`/`["has_kids"]` where the dependency can be carried instead of disqualifying, and de-duplicated by extraction's own Jaccard scoring (`duplicatesBy`, refactored out of `duplicateWarnings`) against the deck, the queue and the batch. Library path → `situation-library.draft.json`: major-tier only, fed to the EXISTING `extractPatterns` prompt as its "source text" rather than a new prompt, whole batch as one document, skipped below 3 majors; output through the existing `duplicateWarnings`/`idCollisions`/`identityWarnings`. Trigger is the admin's "Harvest" tab (`POST /api/harvest`, NDJSON-streamed like `/api/generate-seeds`) — on demand only, no scheduler. Provenance: `shared/provenance.js` (`hand-authored`/`extracted`/`generated`/`harvested`) stamped by every writing path, surviving approval into the live files, with the harvested share on the Stats tab as a diversity signal nothing enforces. Never auto-merges; no generation, engine, effect-resolution or referee changes. |
| Name tags resolved in choice labels | shipped | on `dev` — `resolveCardNames` walked `setting/beat/dialogue/prompt/scenario` and a relationship's name, but not `leftLabel`/`rightLabel`, so `col_sam` and `ec_marry_sam` put a literal `{{cast:sam}}` on a live choice button while the prompt above it read a resolved name. The field list is now `NAMED_FIELDS` in `shared/names.js` and is EXPORTED, because `Deck.resolveNames` kept a second hardcoded copy as its "is there anything to do" gate — a card whose only tag sat in a label never reached the resolver at all, and two lists that had to agree were the reason one went stale. Labels are deliberately not re-capped after resolution (see the comment on `NAMED_FIELDS`). The simulator's unresolved-tag assertion now reads every player-visible field rather than `scenario`/`prompt` alone, and `synthesiseNamedCard` gained a `labelOnly` shape — without it, reverting the deck's pre-check alone still passed, because every other tagged card trips the gate through its prose. Both reverts were confirmed to fail before the fix was trusted. No engine, effect-resolution, referee or content changes. |
| Card text fits instead of scrolling | shipped | on `card-text-autofit` — a long major card overflowed its box: the last line of the prompt ran underneath `.card__hint`, and `.card` carried `overflow: auto`, so the card grew a scrollbar. A card is a thing you swipe, and a scroll gesture on it fights the swipe for the same pointer. `useFitToCard` (`client/src/components/CardStack.jsx`) now measures the laid-out scene against the card's content box and binary-searches a type scale down to `FIT_MIN` (0.62) until it fits, publishing it as `--fit`; every font size, gap and indent inside the card is a multiple of that one variable, so the card rescales proportionally instead of one field being squashed. Measured rather than chosen in CSS because how much text fits depends on where the lines wrap, which a media query cannot see. `overflow: clip` (with `hidden` as the fallback for older engines) is the backstop, and the bottom padding now reserves the hint's row. Presentation only: no engine, validator, content or prompt changes — an over-budget major card is still logged by `narrativeWarnings`, which is where that belongs. |

---

## The admin module

A separate interface for editing content — the library, the seed deck, the
extraction draft queue — plus a cross-reference check, a live preview, a
content harvester and a stats view. `npm run admin`, then <http://localhost:8787/admin>.

**It has no authentication, and the server binds to `127.0.0.1` because of
that.** The consequence is deliberate and worth knowing: the *game* is
localhost-only too, so it can no longer be opened from a phone on the same wifi.
Getting LAN play back means moving the admin to its own port and process, not
loosening this binding.

Two rules hold the safety story together:

1. **The binding is the defence, not a middleware check.** Nothing off this
   machine can open the socket, so no request-inspection logic has to be right.
2. **`HOST` set to anything non-loopback removes the admin entirely** — the
   router is never mounted and `/admin` returns 404 with the reason. Exposing
   the game does not silently expose the admin. If you need that, add auth.

Other things worth knowing before working on it:

- `server/admin/store.js` is the only writer. Every save copies the old file to
  `.bak`, writes to a temp file and renames (so an interrupted save cannot leave
  a half-written library the game server then refuses to boot on), and checks a
  content hash so a file edited underneath you is refused rather than clobbered.
- **Extraction never merges.** It appends to `situation-library.draft.json` and
  stops; entering the library is always an explicit human approval.
- **Extraction flags likely content duplicates, it doesn't block them.**
  `duplicateWarnings` in `server/extraction.js` does word-overlap scoring
  (Jaccard over each pattern's tokenized `pattern` sentence, threshold 0.6)
  against the live library, the existing draft queue, and earlier candidates
  in the same batch — catching a rephrased repeat that id matching (`idCollisions`)
  can't. Advisory only, same as the anonymity sweep: a person reads every flag
  and decides. Shared by both extraction callers (admin `/api/extract` and
  `scripts/extract-patterns.js`), same as the rest of `server/extraction.js`.
- The cross-reference check answers only *"can any content file or the engine
  ever set this flag?"*. It is **not** the same measurement as "8 of 13 patterns
  are dead in simulation" below — that is about chains that cannot complete
  inside one life. Today it reports 0 unreachable and 3 inert exclusions.
- The thread-template editor is deliberately absent: `thread-templates.json`
  does not exist. The cross-reference check and the stats view already branch on
  that, so adding it later is a new file plus a nav entry.
- **Seed generation never merges either.** The "Generate seeds" tab
  (`admin/src/components/SeedGeneration.jsx`) and `npm run generate-seeds`
  both call `server/seed-generation.js`, which only appends to
  `scenarios-seed.draft.json`. Draft review — edit inline, approve & merge
  into `data/scenarios-seed.json`, or reject — reuses the same
  `admin/src/components/DraftQueue.jsx` component and the same
  `PUT|POST /api/<draftKey>/:id[/approve|/reject]` route shape
  (`server/admin/index.js`'s `draftRoutes`) that pattern-draft review uses,
  parametrised by draft file, target file and validator rather than
  duplicated.
- **The harvester does NOT run extraction's anonymity sweep on seed
  candidates.** It did, and the reason it stopped is worth remembering: that
  sweep is written for a library pattern lifted out of somebody's biography,
  where a proper noun or a date means leaked identity. A seed card is under
  the opposite instruction — the storyteller prompt's GROUNDING section
  demands "A Tuesday in April, the garden centre car park" and the tone guide
  asks for brand names outright. Pointed at that content the sweep flagged
  Tuesday, September, Saturday, Civic, Kmart and Dad: nine warnings across
  fifteen drafts, none of them real, which is how a reviewer learns to skip
  the warnings list entirely. A narrower "capitalised word in a person-naming
  position" replacement was measured too and scored *worse* — it caught
  choice-label verbs and more brands, and still found no real name in 201
  candidates. What remains is one precise check, `hardcodedNameWarnings`: a
  relationship effect naming somebody outright instead of by tag, which is
  exactly the condition `npm run names` fails on, and therefore the one that
  would otherwise break the build *after* approval. It fires zero times on
  today's log, so it was confirmed by planting a card that trips it and
  watching `npm run names` exit 1. The library path still runs the real
  `identityWarnings`, where it is the right question.
- **Harvesting never merges either**, and never runs on a timer. The "Harvest"
  tab (`admin/src/components/Harvest.jsx`) reads the request log on demand and
  appends to both draft queues; see "Content harvesting" below. Its two review
  lists are the same `DraftQueue.jsx` the other two tabs use, filtered to
  `source === 'harvested'` so "where did this row come from" stays answerable
  at a glance in a queue three features write to.
- `admin/` is a separate Vite root building to `dist-admin/`. `npm run build`
  never sees it, which is why no admin code can reach the player bundle.

### Request/response logging

`server/llm.js` wraps the Anthropic call made by `/api/scenarios` — the one
that runs on every swipe — and writes one JSON line per call to
`server/logs/llm-requests.jsonl` regardless of outcome. The write is
fire-and-forget (`log-store.js`'s `appendLog`, called from inside the
`fs.appendFile` callback), so a slow disk never delays the response already on
its way to the player.

Deliberately **not** wrapped: the obituary call, admin preview, and pattern
extraction. The log schema is shaped around gameplay (`triggeredBy` is only
`"batch_generation"` or `"validator_retry"`; `age`/`contentMode`/
`librarySlotUsed` all come from a live player's state), and those three calls
don't have that context. Preview and extraction already show their own raw
output in the admin UI, so nothing about them is opaque today.

Major-tier craft drift — a field outside ±30% of its word budget, or a card
with no concrete number — is measured by `narrativeWarnings` during
`validateBatch` and logged as `validationWarnings` on the call record, never
rejected. Passing calls carry warnings too (the third `finalizeLog` argument),
and the Logs tab shows them as an amber list in the call detail plus a count
pill on the row — so the signal is read, not just written.

A request is logged once, after validation has run, not at call time —
`callLLM` returns a `finalizeLog(validationResult, validationErrors,
validationWarnings)` closure
because the call itself has no way to know whether its output will be
accepted. On a two-attempt request, the winning attempt (if any) logs
`"passed"`, an earlier attempt that got retried logs `"failed"`, and whichever
attempt was the *last* one made logs `"fell_back_to_seed"` if nothing won —
that is the one line that actually corresponds to what the player experienced.

`keySource` (`"server"` | `"byok"` | `null`) says which API key paid for the
call. It exists for the harvester, which may only mine server-key generations —
see "Content harvesting" below for why null is ineligible rather than assumed.
The Logs tab shows it as a column and a filter, and reads a missing one as "not
recorded" rather than a dash, because that absence is a real answer.

The log is otherwise still write-once and read-only. The harvester reads it
through `log-store.js`'s `queryEntries` (full entries, including the two big text
blobs the list view strips) and never writes back to it.

Rotation is by size (10MB) or entry count (5000), whichever comes first —
`LIFESWIPE_LOG_MAX_BYTES` / `LIFESWIPE_LOG_MAX_ENTRIES` override either. The
active file becomes `llm-requests.<epoch-ms>.jsonl.gz`; the 5 most recent
rotations are kept, older ones deleted automatically. Reads (the admin's Logs
tab) scan the active file plus every rotated file, so a filtered date range
spanning a rotation boundary still returns complete results.

The admin has no URL router (see above), so "Logs" is a tab like the others,
not literally a route at `/admin/logs`.

### Content harvesting

`server/harvest.js` mines `server/logs/llm-requests.jsonl` for live generations
worth keeping, and feeds them into the two draft queues that already exist. The
admin's "Harvest" tab (`POST /admin/api/harvest`) is the only trigger, and it is
**on demand only** — no scheduler, deliberately, because this decides what the
game's permanent content becomes.

**Eligibility.** A logged call is a candidate only if `keySource === "server"`,
`validationResult === "passed"`, and the individual card carries no more than
`maxCraftWarnings` (default 0) of the batch's `validationWarnings`. That last
filter is per CARD, not per call: `validateBatch` prefixes each warning with its
raw-array index, so one over-budget major does not disqualify the other four.

`keySource` was added by this feature (`server/llm.js`, from `meta.keySource`;
`server/index.js`'s generation call declares `'server'`). There is no BYOK path in
the codebase — `anthropic.js` reads `process.env.ANTHROPIC_API_KEY` and nothing
else — so today every live call says `server`. **Undeclared is null, and null is
ineligible.** That shape is the point: every entry logged before this feature
existed is skipped rather than assumed, and a future BYOK path that forgets to
declare itself is excluded by default rather than quietly harvested. A player's
own key pays for their content; harvesting it would be taking something that was
not offered.

**Seed path** (lighter touch) → `scenarios-seed.draft.json`. The card is kept as
written, with three things done to it:

- **De-personalised.** The reverse of `shared/names.js`'s resolution step. The
  cast is read back out of the logged prompt text (the `people:` line, the
  `children:` line, and the "Tags already spent in this life" line, which gives an
  exact tag→name mapping), and every name goes back to a tag. Narrative fields get
  the tag; **choice labels get the role in plain words** ("Ask Nadia" → "Ask your
  spouse"). This began as a workaround for labels never being name-resolved at
  all, which was true when the harvester was written and is not any more. It
  stays because a label can name somebody the prose never mentions, and a tag
  there would spend a fresh name on a button that only needs to say which kind
  of person it means. Mom and Dad are left alone —
  address forms, not names (invariant 8). A card with a cast name still in it
  afterwards is dropped, not shipped.
- **Screened for generalisability.** A proxy, not a rule, in the same spirit as a
  library pattern's requires/excludes. A card is dropped if it leans on a flag
  only this life has (the story-memory flags, not the canonical engine ones — so
  `lawn_business` disqualifies, `married` does not), or if it explicitly
  back-references a decision this player already made. Where a flag can carry the
  dependency instead of disqualifying it, it does: a card whose cast includes a
  spouse or a child is gated with `requiresFlags: ["married"]` / `["has_kids"]`.
- **Checked for near-repeats**, by the same Jaccard word-overlap scoring
  extraction uses (`duplicatesBy`, threshold 0.6), against the live deck, the
  draft queue and earlier candidates in the same run. This is what makes a second
  harvest over the same window add nothing.

**Library path** (heavier touch) → `situation-library.draft.json`. Major-tier
cards only, and it does **not** write a second generalisation prompt: it hands
those scenarios to `extractPatterns` as its "source text", exactly as the paste
box hands it a memoir. The whole batch goes in as one document — the extractor is
asked for 8–15 patterns, which is a sensible ask of fifteen scenes and a nonsense
ask of one, so the path skips itself below three eligible majors. Output runs
through the existing `duplicateWarnings`, `idCollisions` and `identityWarnings`
against the live library, the draft queue and the batch.

Both paths only ever APPEND. `server/harvest.js` writes no file at all; the admin
route does the appending, and approval into `data/scenarios-seed.json` or
`server/situation-library.json` stays the separate human action it is everywhere
else. Every harvested draft is stamped `source: "harvested"` (which survives
approval) plus a `harvestedFrom` note of which log entry it came from (which does
not — the log rotates and that id stops resolving).

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
