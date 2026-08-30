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
| `shared/names.js` | the name pool reader, era filter, diversity and regional weighting, tag resolution, drift check, pool-wide activation filtering. |
| `shared/regions.js` | region codes and labels, shared by the server resolver and the settings dropdown. |
| `server/name-pool.json` | 993 names across 49 origins, generated from SSA birth records, with era, gender, national births, per-region frequency (all on the 2025 archive vintage) and an `active` flag. Data only. |
| `server/name-pool-controls.json` | pool-wide deactivation lists (category / region / gender_assoc), each entry carrying a required reason and timestamp. Data only. |
| `server/name-pool-health.js` | pool-health measurements (spread, era gaps, zero-candidate combinations) shared by `npm run names` and the admin's Name Pool health panel. |
| `server/geo.js` | offline IP → region. Holds the privacy contract; read it before touching location. |
| `scripts/build-name-pool.js` | generates the pool CANDIDATES from SSA birth records: top-N per state/era/gender, merged into the existing pool, never deleting. |
| `scripts/name-categories.json` | folded name → category, for SSA-sourced names. An organisational label, not a weight. Data only. |
| `scripts/build-region-weights.js` | one-time: SSA birth data → the `region_frequency` maps for names already in the pool. |
| `shared/library.js` | situation-library selection, filtering, rarity weighting. |
| `shared/intro.js` | the two authored identity choices shown at the start of every life, and the offline fallback text for the grounding beat that follows them. Not generated content: excluded from seen_patterns/seen_seed_ids and from LLM request logging. |
| `shared/deck.js` | buffering, eligibility, background refill, anti-repetition. |
| `shared/fallback.js` | procedural templates so offline play never runs dry. |
| `server/index.js` | serves `dist/`, proxies the LLM provider, resolves the content tier. |
| `server/prompt.js` | system + user prompts. (The spec calls this `llm.js`.) |
| `server/provider.js` | the LLM provider seam: one `complete` dispatched to Anthropic or Ollama (`LLM_PROVIDER` at boot, runtime-switchable via the admin's storyteller toggle), return shape normalized to `{ text, usage: {input, output}, stopReason, provider, model }`. Every server-side LLM caller imports this, never a backend client directly. |
| `server/anthropic.js` | Anthropic Messages API client, no SDK. Imported only by `provider.js`. |
| `server/ollama.js` | Ollama client mirroring `anthropic.js`'s interface: model-presence check against `/api/tags`, structured-output detection by server version, usage normalized from eval counts. Imported only by `provider.js`. |
| `server/llm.js` | wraps the provider call with request/response logging. The generation endpoints call this instead of `provider.js` directly; obituary, extraction and admin preview do not. |
| `server/log-store.js` | the log file itself: append, size/count rotation to gzip, paginated + filtered reads across rotated files, summary stats. |
| `client/src/prefs.js` | per-player cross-life memory. |
| `client/src/components/CardStack.jsx` | the swipe gesture and tiered card rendering. |
| `server/admin/` | the content admin API. Localhost only, no auth — read `index.js` before touching it. |
| `server/admin/store.js` | the ONLY thing that writes content files: backup, atomic write, version check, key order. |
| `server/extraction.js` | the extraction prompt and checks, shared by the CLI and the admin. |
| `server/harvest.js` | mining the LLM request log for content worth keeping: eligibility, de-personalisation, generalisability, both draft paths. Reads the log, writes nothing. |
| `shared/provenance.js` | the authoring-provenance vocabulary (`hand-authored`/`extracted`/`generated`/`harvested`) and the harvested-share maths. |
| `admin/` | the admin React app. Its own Vite root; never an input to the player build. |
| `client/src/styles.css` | all styles: Radix Mauve neutral scale imports, semantic token definitions, theme-aware CSS variables, Electric-dusk brand accent preservation. Applies `.dark-theme` class via `App.jsx` for dark mode. |
| `@radix-ui/colors` | Radix UI color system: Mauve light/dark scales for neutral palette, paired variables (`--mauve-1` through `--mauve-12`). CSS imports in `styles.css`: `mauve.css` (light) and `mauve-dark.css` (dark). |

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
| `server/index.js` | the HTTP server: serves `dist/`, the `/api/*` endpoints (`scenarios`, `intro`, `obituary`, `region`, `coverage`, seed/library/name-pool reads), resolves the content tier, and mounts the admin when bound to loopback. |
| `server/provider.js` | the provider seam every LLM caller imports: dispatches `complete` on the active provider (`LLM_PROVIDER` at boot — "anthropic" default, "ollama" — switchable at runtime via `setProvider`, the admin's storyteller toggle), normalizes the return shape, re-exports `hasKey`/`extractJson`/the error classes and `PROVIDER`/`MODEL` (live bindings, so importers see a switch), and fails at startup on an unknown provider or an unset `OLLAMA_MODEL`. |
| `server/anthropic.js` | the Anthropic Messages API client, hand-rolled (no SDK). Holds the API key check and `complete`. Imported only by `provider.js`. |
| `server/ollama.js` | the Ollama client, same external interface as `anthropic.js`. `OLLAMA_BASE_URL` (default `http://localhost:11434`), `OLLAMA_MODEL` (no default, on purpose). First use verifies the model is pulled via `/api/tags` and detects schema-constrained vs basic-`"json"` structured output from the server version; responses are normalized to `{ text, usage: {input, output} }` from `prompt_eval_count`/`eval_count`. Imported only by `provider.js`. |
| `server/llm.js` | wraps the `provider.js` call for `/api/scenarios` and `/api/intro` with request/response logging; returns a `finalizeLog` closure the caller invokes after validation. Stamps `provider` on every log record. |
| `server/prompt.js` | builds the system + user storyteller prompts, the intro grounding-beat prompt, and the obituary prompt. (The spec calls this `llm.js`.) |
| `server/log-store.js` | the LLM log file: append, size/count rotation to gzip, paginated + filtered reads across rotated files, summary stats. |
| `server/extraction.js` | the pattern-extraction prompt and its checks (anonymity sweep, duplicate scoring, id collisions); shared by the CLI and the admin. |
| `server/seed-generation.js` | bulk offline generation of seed-scenario drafts for coverage-thin buckets: a generic per-bucket sample state, the weight-tier mix, occasional situation-library grounding, all down the real prompt/validator path. Shared by the CLI and the admin, same relationship `server/extraction.js` has to pattern extraction. |
| `server/harvest.js` | the content harvester: reads `server/logs/llm-requests.jsonl`, filters it to server-key calls that passed validation, puts the cast's name tags back into the cards, drops the ones that only make sense inside one life, and proposes seed-deck and situation-library drafts. Never writes a content file - the admin route does the appending. |
| `server/geo.js` | offline IP → region via `geoip-lite`. Holds the privacy contract; read it before touching location. |
| `server/name-pool.json` | data only: 993 names across 49 origins, generated from SSA birth records, with era, gender, national births, per-region frequency (all on the 2025 archive vintage) and an `active` flag. |
| `server/name-pool-controls.json` | data only: pool-wide deactivation lists for category / region / gender_assoc, each entry requiring a reason. |
| `server/name-pool-health.js` | pool-health measurements (category spread, era gaps, zero-eligible-candidate warnings), shared by `npm run names` and the admin's health panel. |
| `server/situation-library.json` | data only: the situation-library life-event shapes the storyteller is briefed with. |
| `server/admin/index.js` | the admin API router; mounted at `/admin`, loopback-only, no auth. Every route can rewrite content files. |
| `server/admin/store.js` | the ONLY writer of content files: `.bak` backup, temp-file atomic write, content-hash version check. |
| `server/admin/preview.js` | live preview: runs the real generation path against fresh in-memory sample state and returns raw + validated output, including the cards `/api/scenarios` would have dropped. |
| `server/admin/cross-reference.js` | best-effort reachability check: which library `requires` flags nothing in the game ever sets. Advisory, never a save blocker. |
| `server/admin/content-schema.js` | field-level validation for the editable content types (library, seeds, name-pool entries, name-pool group controls), reusing the extraction checks and the game's own `validateScenario`. |

**`client/`** — the player app (React, built by Vite to `dist/`).

| file | owns |
| --- | --- |
| `client/index.html` | the Vite HTML entry. |
| `client/src/main.jsx` | mounts the React root. |
| `client/src/App.jsx` | the root component: the game loop (title → intro → playing → ended), the `Deck`, engine calls (`createState`/`applyChoice`/`stateSummary`), which screen is showing, and theme class application (`.dark-theme` on `<html>` root). |
| `client/src/api.js` | the client half of the LLM wiring: best-effort POSTs to the server that fall back to seed content silently, including the intro grounding beat (`fetchIntroBeat`). |
| `client/src/prefs.js` | per-player cross-life memory in `localStorage` (content mode, age gate, region choice, theme override, `seen_patterns`/`seen_seed_ids`), every access wrapped. Theme functions: `getTheme()` (explicit override or null), `setTheme()`, `getActiveTheme()` (override or OS preference). |
| `client/src/styles.css` | all styles: Radix Mauve imports, semantic color tokens, light/dark theme declarations, component styles. Applies theme variables via `.dark-theme` selector. |
| `client/src/components/CardStack.jsx` | the swipe gesture (pointer events), tiered card rendering, and `useFitToCard` — the measure-and-shrink pass that keeps a long card inside its box so it never scrolls. |
| `client/src/components/Hud.jsx` | the stats HUD (money/health/happiness/age) and the shared money formatter. |
| `client/src/components/StartScreen.jsx` | the start screen: content-mode pick, age confirmation, region choice, theme toggle (light/dark/auto). |
| `client/src/components/Intro.jsx` | the opening sequence between StartScreen and the first `deck.draw()` card: two authored identity choices (`shared/intro.js`) rendered through the same `CardStack`, then the grounding beat as a modal over that same screen (the framing line and the emptied card slot stay mounted underneath; the choice buttons do not, since the card they belonged to has been swiped away). Presentational only - `App.jsx` owns the state and the `applyChoice` calls. |
| `client/src/components/GroundingBeat.jsx` | the intro's one non-interactive step: a generated (or, on failure/timeout, authored-fallback) establishing scene, shown once as a popup modal over the intro screen - the same backdrop + centered-dialog shape as `ConsequenceModal.jsx`, with the major-tier card's `.scene__setting`/`.scene__beat` treatment inside the panel. Tap, drag (via `pointerup`, not `click`, so a drag still registers) or press a key anywhere to continue - there is no choice to make. Inputs are ignored until the beat lands. |
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
npm run build-name-pool -- <dir>       # generate pool candidates from SSA birth records
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

Past the per-field character caps (`FIELD_LIMITS` in `shared/scenario-format.js`)
a field is cut, and `truncateNarrative` decides where: the last complete
sentence inside the budget if there is one worth keeping, otherwise a word
boundary and an ellipsis. Never mid-word — that shipped once, as "The super is
not answering. Someone n" on a live card. Roughly one generated card in twelve
overruns a field; no card in the seed deck does.

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

**Spelling convention** — house style is American English throughout. The
generation system prompt, the obituary prompt and the extraction prompt
(`server/prompt.js`, `server/extraction.js`) each carry an explicit instruction
to write American spelling regardless of source-text conventions, since
`server/seed-generation.js` and admin preview share `buildSystemPrompt` and
would otherwise inherit whatever the base prompt says. `shared/scenario-format.js`
exports `BRITISH_SPELLINGS` (an explicit-inflected-form reference list, not
stems — see the "embezzl" lesson below) and `britishSpellingWarnings`, wired
into `validateBatch` (`shared/schema.js`) as a log-only `validationWarnings`
entry across every tier, same pattern as the major-tier craft warnings. It is a
style-consistency signal, never a rejection. A one-off audit against the live
content (`server/situation-library.json`, `data/scenarios-seed.json`) run
2026-08-28 flagged 15 of 91 library patterns and 18 of 239 seed scenarios —
mostly "neighbour"/"behaviour"/"centre"/"programme"/"grey" — left for the
normal admin edit flow to correct rather than auto-rewritten.

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

**Names** — 993 names across 49 cultural origins in `server/name-pool.json`,
each carrying the era it was in use and any gender it reads as.

The pool is **generated from SSA birth records**, not authored. It used to be
an authored list: 187 names written to satisfy the spec's "at least 150 names,
diverse origins", which `build-region-weights.js` then scored. Nothing had ever
asked the data WHICH names Americans actually have, so the pool carried Ignacio
and Rocío but not **Jose, Maria or Juan** — among the most frequently registered
given names in the country. `scripts/build-name-pool.js` now pulls the top 75
names per state, per 20-year era bucket, per gender straight out of the archive.
An authored list scored by real data is still an authored list.

It only ever ADDS. All 187 original entries survive byte-for-byte, including the
deliberately rare flavour names (Siobhan, Struan, Aino) — being uncommon is not
a defect, being absent-because-nobody-looked is. `npm run names` hard-fails if
Jose, Maria, Juan, Guadalupe, James, Mary or Robert goes missing, which is the
regression check against this exact bug returning. The engine
filters by the character's implied birth year (`PRESENT_YEAR` in `balance.js`,
plus a per-role age offset) and then samples **category first**, on three
factors multiplied together:

| factor | scope | what it says |
| --- | --- | --- |
| frequency | fixed | how many Americans actually carry these names (`national_births`, summed over the surviving candidates, raised to `BAL.NAMES.categoryPower`) |
| diversity | per life | `1/(1+used)^1.5` against origins this life has already spent |
| affinity | per session | the player's region, via `region_frequency` |

...and then **again inside the chosen origin**, where a name's own
`national_births` (raised to `BAL.NAMES.nameFrequencyPower`) multiplies its
region weight. Both halves are needed and neither is sufficient. Weighting only
the category left the flatness one level down: anglo's share spread evenly over
633 names while irish's spread over 23, so an individual Irish name stayed
likelier than an individual anglo one and the most-drawn name in the pool was
**Fiona**. With the inner weight, irish yields Brian/Ryan/Sean/Patrick and
latin-american yields Jose/Maria/Manuel/Juan.

`nameFrequencyPower` is **0.5, and region is what sets it.** The inner draw is
the one place region is supposed to pick *which* name — "Minnesota's
Scandinavian name is more often the one Minnesota actually registers". At 1.0
(raw births) that stops being true: the birth spread inside a category exceeds
`regionCeiling` and region can no longer reorder irish-in-MA or
scandinavian-in-MN at all. At 0.5 it still reorders every case tested. Variety
barely moves across the range (780 → 747 distinct names drawn), so region, not
variety, is the binding constraint.

**Frequency weighting is why the category draw is not flat**, and its absence
used to be load-bearing: with 49 origins weighted equally, a player was exactly
as likely to meet a `maori`-named character (2 names) as an `anglo` one (633).
Region could not supply it — a location quotient is a *ratio to the national
rate*, so it carries where a name is used and divides out how much.

`categoryPower` is **0.35, and that is a ceiling, not a preference.** Measured
over 400 lives: at 0.35 anglo takes 14.9% of draws, same-origin repeat within
one life is 8.6% and all 49 origins stay reachable; at 0.5 it is 23.1%/16.3%
and at 1.0 it is 56.7%/47.8%. Both higher settings **fail `npm run names`** on
`US-CA did not lift its own origins` — region affinity is capped at
`regionCeiling` (6) and anglo outweighs California's own origins by ~460x in
births, so past ~0.35 no regional signal survives the frequency term and
regional weighting stops working. Raising it does not turn region down, it
turns region off. Picking a state barely moves the anglo share either way
(54–59% across every state at 1.0, 14–17% at 0.35); what region moves is the
*rest* of the draw.

A category with no SSA presence at all (`maori`, `thai` — suppressed under 5
births per state-year) is credited `BAL.NAMES.categoryBirthsFloor` rather than
zero. Zero weight is never-drawn, which would make this a **filter**, and
`npm run names` asserts that outcome directly rather than trusting the
constant.

**A name may not itself be a mature-content keyword.** "Molly" is a top-75
girl's name in several states and also slang for MDMA, so cards naming her
tripped the engine's own content backstop — the simulator's mature-in-safe
assertion failed 5 times on one card. Fixed in the *pool*, not in
`shared/content.js`: the backstop is one of three independent gates
(invariant 9) and is meant to be blunt, so teaching it to ignore words that
are also cast names would open a hole a card could aim at deliberately.
`scripts/build-name-pool.js` drops such candidates at generation and
`npm run names` fails if one arrives any other way.

**Activation controls** sit ahead of all of that. Every entry carries an
`active` flag (default true), and `server/name-pool-controls.json` adds three
pool-wide exclusion lists — deactivated categories, gender_assocs and regions —
each entry requiring a `reason`, since these are high-impact and should leave
a visible trail of why. Category and gender_assoc deactivation exclude every
matching name from selection outright, applied in `assignName` before era
filtering and before any random draw, regardless of a name's own `active`
flag. Region deactivation is different in kind: it never excludes a name, it
only makes that region behave like the existing no-signal case (see Regional
weighting below) — region is a weight, never a filter, so there is nothing
else for a region control to remove. If deactivation ever leaves a role with
no untaken, era/gender-matching candidate, `assignName` relaxes era and
gender-want exactly as before, then — new — falls back to reusing a name
already in play among the still-eligible names, logging a warning each time;
only if literally no active, non-deactivated name exists at all does it return
null, which `resolveCardNames` covers with the capitalised role word. All of
this is edited from the admin's Name Pool tab (`npm run dev:admin`), including
a bulk "select all matching the current filter" action against the individual
`active` flag — how an ad-hoc grouping (an era range, a search match) is
deactivated without a persistent control of its own.

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
  entry, or anywhere outside the US all score exactly 1 and change nothing.
  (Florida used to be listed here as absent from the archive. It is not: 360
  entries carry a `US-FL` weight. Its signal is genuinely mild though — 16
  entries above 2x against Minnesota's 48, and 253 of its 360 below 0.8x —
  which is what a high-migration state whose naming profile sits near the
  national average looks like.)
- **The data describes reality; we do not.** Every number is counted from birth
  records. Hand-writing weights is how you encode a stereotype instead of a
  demographic — see the warning under "Measure, don't assume".

Region belongs to the **session**, not the life: it says who is playing, not
who the character is, so a story that moves them to another state does not
change it, and it never enters saved game state.

---

## The opening intro sequence

Between `StartScreen` (content mode, age confirmation, region) and the first
`deck.draw()` card, every life runs three fixed steps, tracked by `App.jsx` as
`phase === 'intro'` and never persisted across lives:

1. **Two authored identity choices** (`shared/intro.js`) - a financial-tier
   binary and a bookish/social binary, each picked from a small pool of 3-4
   hand-written phrasing variants (no cross-life seen-tracking; the pool is
   too small to need it). Rendered through the exact same `CardStack` swipe
   gesture as any real card, and applied through the exact same
   `applyChoice`/`normalizeEffects` path (invariant 1) - `shared/intro.js`
   only builds the scenario shape, via `validateScenario`, same as a
   hand-authored seed. The financial card sets a starting-money nudge
   (`BAL.INTRO.financialTierModifiers`, `shared/balance.js`) and a
   `modest_upbringing`/`comfortable_upbringing` flag; the personality card
   sets `bookish`/`social` with no mechanical effect. Both are excluded from
   `seen_patterns`/`seen_seed_ids` and from LLM request logging entirely -
   they never touch `Deck.draw` and never call the model, so there is nothing
   here for `server/harvest.js` to ever see.
2. **One non-interactive grounding beat** (`client/src/components/GroundingBeat.jsx`),
   generated by `POST /api/intro` (`server/prompt.js`'s `INTRO_SYSTEM`/
   `buildIntroPrompt`, inputs: `PRESENT_YEAR`, the resolved region, and the two
   flags just set) and logged through `server/llm.js` like any generation
   call, tagged `triggeredBy: "intro_generation"` - a value
   `server/harvest.js`'s eligibility check excludes on purpose (see "Content
   harvesting" below), since this is a fixed line with no decision, not a
   scenario a life could repeat. Validated with a lightweight length-only
   schema check (`server/index.js`'s `validateIntroBeat`), deliberately NOT
   `validateScenario`'s prompt/decision-shape rules, since this content has no
   decision by design. Same "cannot fail" guarantee as `deck.draw`: a failed
   or slow (15s timeout) call falls back to one of `shared/intro.js`'s two
   authored beats, keyed by the financial-tier flag only. Shown as a **popup
   modal over the intro screen**, not a screen of its own: the same backdrop +
   centered-dialog shape as `ConsequenceModal.jsx`, with the major-tier card's
   `.scene__setting`/`.scene__beat` weight inside the panel, since this is the
   first thing a player reads. The framing line and the (now empty) card slot
   stay mounted and dimmed underneath, inert - `CardStack` is passed
   `disabled` so its window-level arrow-key handler cannot fire under the
   dialog, since the backdrop only swallows pointers. Tap, drag (via
   `pointerup`, not `click`, so a deliberate drag still registers) or press a
   key anywhere to continue - there is no choice, so every plausible "go on"
   key is accepted, including the two arrows the player has just used on both
   identity cards.
3. **Hand-off**: `App.jsx`'s `completeIntro` draws the first two real cards
   from the already-constructed `Deck` and switches to `phase === 'playing'`,
   exactly what `start()` used to do directly before this sequence existed.

`deck.draw`, the situation library, seed selection and every existing card's
effect-resolution logic are all unchanged - this is a pre-game sequence that
terminates into the existing game loop, not a new game mode.

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
- **The SSA source archive IS committed**, at `data/ssa/namesbystate.zip`
  (24MB, ~155MB extracted). It used to be kept out of the repo, which is how
  the project ended up unable to answer "which names do Americans actually
  have" for as long as it did — the one dataset that could settle it was the
  one nobody had. Unzip it anywhere and pass the directory to
  `npm run build-name-pool` / `npm run build-region-weights`.
  **Two things this file's earlier notes got wrong**, both corrected by direct
  audit of the committed archive (`STATE,SEX,YEAR,NAME,COUNT`; 6,696,687 rows;
  331M births):
  - **Florida is present.** 51 files = 50 states + DC. The old note said it was
    missing; entries authored before this rebuild simply have no `US-FL` key
    because the vintage in use then predated it.
  - **The data runs 1910–2025**, not "stops at 2015".
  Note also that ssa.gov blocks automated egress with a 403 (confirmed again,
  with and without browser headers) — which is why the archive is committed
  rather than fetched. `npm run names` will tell you if what you fed it was wrong.
- **The whole pool is on ONE archive vintage** (the committed 2025 one), after
  `npm run build-region-weights -- <dir>` was run across all 993 entries. It
  briefly was not: the SSA-sourced entries were measured against 2025 while the
  187 originals kept maps from an older archive that had no Florida in it, so
  none of them carried a `US-FL` key. If you ever regenerate part of the pool,
  re-run that command over all of it — a half-updated pool is not wrong exactly
  (a missing region reads as no signal, never as exclusion) but it silently
  answers "how common is this name here" from two different decades.
- **JSON imported from `shared/` needs the import attribute.** `shared/` runs in
  the browser, the server and the simulator, and a vite alias like `@library`
  means nothing to the last two. Use
  `import pool from '../server/name-pool.json' with { type: 'json' }` — Node 22+
  and Rollup 4 both take it, and vite inlines the file into the bundle.
- **Don't leave a server on :8787.** It has blocked the user's `npm start` once.
  Check ownership before killing anything on that port — it may be theirs.

---

## Branch workflow

New work goes on a branch off `dev`. Always create that branch before
starting a new feature — never commit a new feature straight to `dev`.
Name it short and `kebab-case`.

When the Definition of done is satisfied, Claude Code stops and reports
the branch as ready to merge — it does not attempt the merge into `dev`
itself. Claude Code's Auto Mode permission classifier blocks pushes/
merges to shared branches by design (a repo-file instruction doesn't
count as live consent), so this isn't optional. Both feature → dev and
dev → main merges are the user's call.

main   ← user merges, after testing dev
dev    ← user merges, once Definition of done is satisfied
<feature branches off dev, short kebab-case name>

```

## Definition of done

Before a feature branch is considered ready to merge into dev, verify —
out loud, in your final message on that branch — all three:
1. CLAUDE.md's Feature Status table includes this feature.
2. Any changed invariant, architecture-map entry, or file-structure
   entry is updated to match.
3. Verification, scaled to what changed:
   - PRESENTATION-ONLY (the diff touches only client/src/components,
     client/src/styles.css, admin/src/components, admin/src/*.css —
     no changes to shared/, server/, any *.json data file, or any API
     route/contract): run the build (`npm run build`) and confirm it
     exits 0. The simulate/coverage/names suite is optional.
   - ANYTHING ELSE (touches shared/, server/, engine logic, content
     data, name pool, balance.js, or any API contract): the full
     verification commands (npm run simulate / coverage / names) must
     exit 0, as before.
   State which category applied and why in the final message — the
   classification should be visible, not assumed silently.
If any of these fail, the feature is not done — fix it in the same
session, not as a follow-up. Do not report a feature as finished
without stating you checked all three.
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
| Admin edit forms open in a modal dialog | shipped | on `main` — library, seed and draft-review forms open in a centered dialog (`admin/src/components/Modal.jsx`) instead of inline below the grid; Esc/backdrop-click/Cancel discard and unmount. The cross-reference warnings panel stays above the grid, not in the dialog. Draft review gained a row-level quick "Approve" alongside "Edit & approve". No data logic, validation or API changes |
| Extraction content dedup check | shipped | on `main` — `duplicateWarnings` flags likely repeat patterns by word overlap; see the admin module section below |
| Major-tier exemplar prompt + craft warnings | shipped | on `main` — worked exemplar and per-field word budgets in the system prompt; log-only `validationWarnings` through `validateBatch` → `finalizeLog` → Logs tab; 5 weakest major seeds rewritten (`col_major`, `col_dropout`, `ec_move`, `ec_kid`, `lt_severance_or_stay`) |
| EventToast timing fix + consequence modal | shipped | on `main` — toast duration fixed at ~3.8s (was a flat 4.2s regardless of read time), paused while a pointer is down anywhere on screen, tap-to-dismiss-early. `client/src/severity.js` classifies each turn's events/new-flags/stat-delta as `major` or `standard`; `major` (a resolved pending event, a significant new flag, or a ±15+ health/happiness swing - all tunable in that one file) routes through `ConsequenceModal` (explicit tap to close) instead of the toast. Presentation-only: no engine/effect changes. |
| Career/education continuity | shipped | on `main` — same class of bug as off-screen relationship reintroduction, different mechanism: `stateSummary()` in `shared/engine.js` now derives a `careerBackground` object (current occupation, current education, and any of `CAREER_BACKGROUND_FLAGS` = `college_degree`/`trade_cert`/`white_collar_experience` the life has earned), computed fresh every call so it can never scroll out of the trimmed recent-history window. Surfaced in every generation prompt as its own STATE line, plus a new CAREER BACKGROUND FLAGS / CAREER PLAUSIBILITY block in the system prompt instructing the model that a white-collar offer needs a bridging event without a qualifying flag already on record. Four career-category situation-library patterns that previously fired with `requires: []` despite presupposing white-collar standing (`early_career_toxic_mentor`, `early_career_toxic_mentorship`, `market_crash_job_loss`, `market_crash_job_loss_2`) now require `college_degree`; the seed deck's `col_major` (declaring a CS/philosophy major) sets it. No engine/effect-resolution changes - purely context completeness and library gating |
| Off-screen relationship reintroduction | shipped | on `main` — a named relationship absent from the recent-history window is marked `[OFF-SCREEN lately]` in the prompt's people line (which already carries role/flags), and the storyteller is asked to reintroduce it by role on first mention ("Dmitri, the guy from your study group") rather than a bare name. Log-only backstop `checkReintroductions` (`shared/names.js`) fires through `validateBatch` → `validationWarnings` → Logs tab across all tiers, best-effort string match. No tier budgets, structure or effect/engine changes; no question-mark/either-or rule added |
| Bulk seed-scenario generation | shipped | on `main` — `server/seed-generation.js` drafts candidates for whichever bucket/mode pairs `npm run coverage` flags short, down the real `server/prompt.js` templates and `shared/schema.js`/`shared/content.js` validators against a generic per-bucket sample state (built from the real engine's `createState`, trimmed to Mom/Dad only so no card can hardcode one throwaway life's assigned names). Weight-tier mix biased toward minor (`tierQuotas`); roughly 1-in-4-5 candidates ground in an eligible situation-library pattern via `shared/library.js`'s own `filterPatterns`. `npm run generate-seeds -- --mode=both --target=15` (CLI) and the admin's "Generate seeds" tab (`POST /api/generate-seeds`) share this core. Draft-only: writes `scenarios-seed.draft.json`, never `data/scenarios-seed.json`. Draft review generalises the existing pattern-draft approve/reject/edit routes (`server/admin/index.js`'s `draftRoutes`) and UI (`admin/src/components/DraftQueue.jsx`, extracted from `Extraction.jsx`) to a second draft/target pair rather than duplicating them. `force` (CLI `--force`, admin checkbox) generates for every bucket/mode pair regardless of current coverage, not only short ones - the common case once the deck is healthy is that a plain run has nothing to do. No live generation path, engine or validator changes |
| Card content scrolling | superseded | on `main` — added `overflow: auto` to `.card` CSS to prevent text truncation when scenario content exceeds available card space; content now scrolls within card bounds instead of being clipped **Superseded by "Card text fits instead of scrolling" below**: `.card` is `overflow: clip` now, and a long card is handled by shrinking the type to fit rather than by letting the card scroll. A scroll gesture on a card fights the swipe for the same pointer, which is why this was replaced rather than kept. |
| Content harvesting pipeline | shipped | on `main` — `server/harvest.js` mines `server/logs/llm-requests.jsonl` for live generations worth keeping and routes them into the two existing draft queues. Eligibility: `keySource === "server"` (a NEW log field, `server/llm.js` ← `meta.keySource`, declared by `server/index.js`'s generation call; there is no BYOK path in the codebase, and an UNDECLARED key source records null and is ineligible, so nothing logged before this feature can be harvested and a future BYOK path that forgets to declare itself is excluded by default rather than swept in), `validationResult === "passed"`, and per-CARD craft warnings at or below a configurable threshold (default 0 — `validateBatch` indexes each warning by raw-array position, so one over-budget major does not disqualify its neighbours). Seed path → `scenarios-seed.draft.json`: the card as written, de-personalised by reading the cast back out of the logged prompt and reversing `shared/names.js`'s resolution (narrative fields get the tag; choice LABELS get the role in plain words, so a person named only on a button does not cost a fresh name), screened against story-memory flag callbacks and explicit back-references to a decision this player already made, gated with `requiresFlags: ["married"]`/`["has_kids"]` where the dependency can be carried instead of disqualifying, and de-duplicated by extraction's own Jaccard scoring (`duplicatesBy`, refactored out of `duplicateWarnings`) against the deck, the queue and the batch. Library path → `situation-library.draft.json`: major-tier only, fed to the EXISTING `extractPatterns` prompt as its "source text" rather than a new prompt, whole batch as one document, skipped below 3 majors; output through the existing `duplicateWarnings`/`idCollisions`/`identityWarnings`. Trigger is the admin's "Harvest" tab (`POST /api/harvest`, NDJSON-streamed like `/api/generate-seeds`) — on demand only, no scheduler. Provenance: `shared/provenance.js` (`hand-authored`/`extracted`/`generated`/`harvested`) stamped by every writing path, surviving approval into the live files, with the harvested share on the Stats tab as a diversity signal nothing enforces. Never auto-merges; no generation, engine, effect-resolution or referee changes. |
| Name tags resolved in choice labels | shipped | on `main` — `resolveCardNames` walked `setting/beat/dialogue/prompt/scenario` and a relationship's name, but not `leftLabel`/`rightLabel`, so `col_sam` and `ec_marry_sam` put a literal `{{cast:sam}}` on a live choice button while the prompt above it read a resolved name. The field list is now `NAMED_FIELDS` in `shared/names.js` and is EXPORTED, because `Deck.resolveNames` kept a second hardcoded copy as its "is there anything to do" gate — a card whose only tag sat in a label never reached the resolver at all, and two lists that had to agree were the reason one went stale. Labels are deliberately not re-capped after resolution (see the comment on `NAMED_FIELDS`). The simulator's unresolved-tag assertion now reads every player-visible field rather than `scenario`/`prompt` alone, and `synthesiseNamedCard` gained a `labelOnly` shape — without it, reverting the deck's pre-check alone still passed, because every other tagged card trips the gate through its prose. Both reverts were confirmed to fail before the fix was trusted. No engine, effect-resolution, referee or content changes. |
| Card text fits instead of scrolling | shipped | on `main` — a long major card overflowed its box: the last line of the prompt ran underneath `.card__hint`, and `.card` carried `overflow: auto`, so the card grew a scrollbar. A card is a thing you swipe, and a scroll gesture on it fights the swipe for the same pointer. `useFitToCard` (`client/src/components/CardStack.jsx`) now measures the laid-out scene against the card's content box and binary-searches a type scale down to `FIT_MIN` (0.62) until it fits, publishing it as `--fit`; every font size, gap and indent inside the card is a multiple of that one variable, so the card rescales proportionally instead of one field being squashed. Measured rather than chosen in CSS because how much text fits depends on where the lines wrap, which a media query cannot see. `overflow: clip` (with `hidden` as the fallback for older engines) is the backstop, and the bottom padding now reserves the hint's row. Presentation only: no engine, validator, content or prompt changes — an over-budget major card is still logged by `narrativeWarnings`, which is where that belongs. |
| Narrative truncation stops on a boundary | shipped | on `main` — `cleanNarrative` capped each field with a bare `slice(0, FIELD_LIMITS[field])`, so an over-long field was cut mid-word: a live card read "The super is not answering. Someone n". Measured before changing anything: 0 of 339 fields in the seed deck overrun a limit, but 23 of 285 generated cards do (~8%, `setting` and `beat` only), and 15 of those landed mid-word. `truncateNarrative` now prefers the last COMPLETE SENTENCE inside the budget, and falls back to a word boundary plus an ellipsis when there is no sentence end worth keeping (below 60% of the budget, obeying one would gut the text). Abbreviations and initials are not sentence ends, so "Dr. Okonkwo" and "J. K." do not cut there. Across all 23 real cases: 0 still cut mid-word, 0 exceed their limit, 7 end on a full sentence. The seed deck renders byte-identically — this only ever fires on live generation. |
| American English spelling enforcement | shipped | on `dev` — explicit spelling instruction added to the generation system prompt, the obituary prompt and the extraction prompt (all three previously said nothing about it); `britishSpellingWarnings`/`BRITISH_SPELLINGS` added to `shared/scenario-format.js` and wired into `validateBatch` as a log-only warning across every tier. Also fixed British spellings that had crept into the prompts' own instructional text ("cheques", "ageing", "labelled", "ANONYMISE", "GENERALISE"). One-off audit of the live content flagged 15/91 library patterns and 18/239 seed scenarios, left for the admin edit flow — see Content model above. No tier budgets, structure or engine/effect changes |
| Name pool activation controls + admin manager | shipped | on `dev` — every `server/name-pool.json` entry gained an `active` flag (default true), and a new `server/name-pool-controls.json` holds three pool-wide deactivation lists (category, region, gender_assoc), each entry requiring a `reason`. `shared/names.js`'s `assignName` filters out inactive/deactivated-category/deactivated-gender_assoc candidates before era filtering and before any `nextRandom` draw (deactivation never changes how many randoms a selection consumes, same rule region already followed), then degrades in a fixed order exactly as before, with one new final tier — reuse a name already in play among the still-eligible names, logged — ahead of the existing null/role-word fallback. `regionalWeight` treats a deactivated region exactly like the pre-existing no-signal case; region remains a weight, never a filter, so it cannot independently empty the eligible pool. `scripts/build-region-weights.js` needed no change: it already mutates each pool entry's `region_frequency` in place rather than replacing the record, so `active` (and any other field) already survives a rebuild untouched. New admin "Name pool" tab (`admin/src/components/NamePool.jsx`, `NamePoolForm.jsx`, `GroupControls.jsx`, `NamePoolHealth.jsx`): a filterable/searchable table with bulk multi-select + "select all matching filter" (the individual `active` flag is how an ad-hoc grouping like an era range is deactivated, since it doesn't warrant a persistent control), a create/edit modal with a plain add/remove `region_frequency` list editor, and three group-control panels (category/region/gender_assoc) each requiring a reason and a confirmation step before deactivating. New routes in `server/admin/index.js` (`/api/name-pool`, `/api/name-pool/bulk-active`, `/api/name-pool-controls/{categories,regions,gender-assocs}`, `/api/name-pool-health`), validated by new `content-schema.js` functions, all going through the existing `server/admin/store.js` backup/atomic-write/version-check path like every other content file. `server/name-pool-health.js` computes category spread, era coverage gaps, duplicate names, deactivation counts and a zero-eligible-candidate sweep across era+gender (region is deliberately not swept — see above), shared by `npm run names` and the admin's health panel; advisory only, never blocks a save or fails the build. No change to era-filtering logic, the diversity-weighted sampling algorithm, or `region_frequency`'s underlying values. |
| Game-opening intro sequence | shipped | on `dev` — see "The opening intro sequence" above for the full three-step flow (two authored identity choices, then a generated grounding beat). New: `shared/intro.js` (identity-card content + fallback beats + framing-line variants), `BAL.INTRO.financialTierModifiers` (`shared/balance.js`), `server/prompt.js`'s `INTRO_SYSTEM`/`buildIntroPrompt`, `POST /api/intro` (`server/index.js`, its own lightweight `validateIntroBeat` rather than `validateScenario`), `client/src/api.js`'s `fetchIntroBeat`, `client/src/components/Intro.jsx` and `GroundingBeat.jsx`, and a new `'intro'` phase in `App.jsx` between `'title'` and `'playing'`. `server/harvest.js`'s `entryEligibility` gained a `triggeredBy` check (only `"batch_generation"`/`"validator_retry"` are harvestable) specifically so the new `"intro_generation"` log entries are excluded — the first caller of `server/llm.js` other than `/api/scenarios`, which is what made that check necessary rather than implicit. No change to `deck.draw`, the situation library, seed selection, or any existing card's effect-resolution logic. **Updated:** Added `INTRO_FRAMING_LINES` (4 short variants, picked per life) and `pickFramingLine(rng)` to `shared/intro.js`; shows as `.intro__framing` eyebrow above the identity-choice card stack for both cards. Styled light with `var(--dim)` text and minimal spacing. (It stays mounted and dimmed behind the grounding beat now - see the row below.) |
| Name Pool tab: unified tab strip + per-row names list | shipped | on `dev` — a page-length rework of the Name Pool tab, in two passes that landed as one: first the three group-control cards became a tab strip, then the browsable/filterable name table joined it as a fourth tab rather than sitting permanently above. `admin/src/components/NamePool.jsx` holds a single `tab` state (`'names'` default, then `'categories'`/`'regions'`/`'gender-assocs'`) and a small button strip (`Names`/`Category`/`Region`/`Gender association`, reusing the header's `.tabs` button styling via a new `.tabs--sub` CSS variant since a bare `.tabs` inside a column-flex `.pane` stretches full-width and floats right); only the active tab's panel renders. The Pool Health panel is the one thing that stays pinned above the strip regardless of tab. The table's bulk-select and create/edit modal are otherwise unchanged, just now conditionally rendered. `GroupControls.jsx` itself is unchanged in shape (still one component, three instantiations) plus two new props: `namePool` (the same array `NamePool.jsx` already fetched for the table) and `matchNames(entry, rowValue)` (the same predicate each tab already used to compute a row's count — `matchesCategory`/`matchesRegion`/`matchesGenderAssoc`, now named and shared instead of inlined per-call, so the count and the list can never disagree). Every row gained a collapsed-by-default `<details>` disclosure listing the matching names, filtered client-side with no new API call. No change to any API route, `name-pool-controls.json`'s shape, `assignName`'s selection/filtering logic, or the table's own filtering/bulk-select behavior. |
| Name Pool tab: bulk select for group controls | shipped | on `dev` — each of the three group-control tabs (Category/Region/Gender association) gained the same bulk-select toolbar shape the Names tab's own table already had: a checkbox per row, "Select all", a selected count, and "Activate selected"/"Deactivate selected" buttons that act only on the applicable subset of the current selection (already-deactivated rows for activate, still-active rows for deactivate - mixing both in one selection is fine, each button just ignores the rows it doesn't apply to). Bulk deactivate opens the same reason-required confirm step the single-row flow uses, once, covering every selected row. **This DOES touch the API**, unlike every other Name Pool layout change above: `POST /api/name-pool-controls/:kind/bulk` (`server/admin/index.js`, inside the existing `groupControlRoutes` factory so all three kinds get it for free) takes `{ values, active, reason, version, force }` and writes the whole selection in one atomic call, the same shape `/api/name-pool/bulk-active` already established for the main table. This is not a style choice: a client-side loop calling the existing single-value `onDeactivate`/`onReactivate` props N times would race itself, because each of those closures (`admin/src/App.jsx`) captures `boot.nameControlsVersion` from whatever render created it, and nothing re-renders between synchronous loop iterations to hand it the version the *previous* iteration's write just produced - every call after the first would arrive with a stale version and hit the store's conflict check. `GroupControls.jsx` computes an exact (not summed) affected-name count for the bulk-deactivate confirmation by reusing its own `namePool`/`matchNames` - summing each row's `count` would double-count a name that carries several selected regions, since region membership isn't exclusive the way category and gender_assoc are. No change to `name-pool-controls.json`'s shape or `assignName`'s selection/filtering logic; the single-row add/remove routes and the Names tab's own bulk-active endpoint are untouched. |
| Grounding beat as a popup modal | shipped | on `dev` — the intro's grounding beat was a full screen that replaced the identity cards; it is a popup over them now. `GroundingBeat.jsx` renders `.grounding-backdrop` + `.grounding-modal` — the same backdrop/centered-dialog shape as `ConsequenceModal.jsx` (scrim, blur, `toast-in` entry, `z-index: 100`) rather than a second modal idiom for the same job — while the panel itself keeps the card gradient and `--card-ink`, because its body is major-tier `.scene` content whose colours are card colours. `Intro.jsx` keeps the framing line and the emptied `CardStack` mounted underneath and passes `disabled` while the dialog is up: the backdrop swallows pointers but not keys, so without that the card stack's window-level ArrowLeft/ArrowRight handler still fires under the dialog. The gesture moved from the panel to the backdrop, so a tap or drag anywhere continues — the consequence modal's click-outside-to-dismiss, where dismissing IS the continue. Keyboard continue is new: Enter/Space/Escape/ArrowLeft/ArrowRight, the arrows included because the player has just used them on both identity cards and they were the one input that silently did nothing here. `role="dialog"`, `aria-modal`, focus-on-mount and an `aria-live` body follow `ConsequenceModal` too; `aria-modal` is what takes the dimmed intro out of the accessibility tree, so nothing behind it is marked `aria-hidden` by hand. Every input is still ignored while `beat` is null (the fetch is in flight), which is why the backdrop carries its own `--loading` cursor state. Presentation only: no engine, validator, prompt, content, `/api/intro` or fallback-path changes. |
| Radix Colors color system + theme toggle | shipped | on dev branch — replaces hardcoded Electric-dusk palette with Radix UI Mauve neutral scale (pairs light/dark) plus Radix CSS imports. Semantic tokens (`--color-bg`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-accent`, `--color-accent-text`) map to Radix steps, redeclared under `.dark-theme` class. Brand accents (--left, --right, --violet, --gold) preserved. Theme toggle in `StartScreen`: defaults to OS preference (`prefers-color-scheme`), explicit override persisted via `prefs.js` (same pattern as region/mode). `App.jsx` applies `.dark-theme` class to `<html>` on mount. Contrast verification: all text/background pairs exceed WCAG AA (EventToast #eeeef0 on #121113: 8.3:1 AAA; ConsequenceModal 5.34:1 AA; card text on light card 8.13:1 AAA). No engine/logic changes; presentation-only per Definition of done. |
| SSA-sourced name pool | shipped | on `dev` — the pool is GENERATED from real birth records now, not authored. Root cause: the original 187 entries were written to satisfy the spec's "at least 150 names, diverse origins" and `build-region-weights.js` only ever scored names that already existed, so nothing ever asked the SSA archive which names Americans actually have — the pool carried Ignacio and Rocío but not Jose, Maria or Juan. New `scripts/build-name-pool.js` pulls the top 75 names per state, per 20-year era bucket, per gender (two passes: one to pick candidates a state at a time so peak memory is one state's table, one to measure only the survivors), derives `gender_assoc` from each name's own national F/M split (neutral at ≥25% minority share) and `era_start`/`era_end` from the years it sits at ≥10% of its own peak, snapped to the 5-year boundaries the pool already used, and computes `region_frequency` with the SAME location quotient, constants, era windowing and neutral band as `build-region-weights.js` — the method is untouched, it is just applied to real-frequency-sourced candidates instead of an authored list. **Additive only**: all 187 originals verified byte-for-byte identical afterwards, including the rare flavour names (Siobhan, Struan, Aino), and dedup is on the FOLDED name so "Rocio" cannot shadow "Rocío". 187 → 994 entries, 909 with real regional data. `scripts/name-categories.json` (181 explicit mappings) labels the non-mainstream clusters; everything else takes the `anglo` default, which is the correct label for most of the SSA top-N and is reported as a count rather than a warning. Category is an ORGANISATIONAL label now, not a selection weight, so `server/name-pool-health.js` exempts that default bucket from the 8% share cap — it legitimately holds ~64% of a data-sourced pool, and a permanent false warning is exactly what taught nobody to read the harvester's anonymity sweep. `npm run names` gained the before/after pool line and a HARD regression check on Jose/Maria/Juan/Guadalupe/James/Mary/Robert. Measured: same-origin repeat within one life 5.3% → 2.7%, regional lift 1.3-1.6x → 1.3-2.0x, all 49 categories reachable (was 48), era-coverage gaps GONE and zero-candidate era+gender combinations 24 → 6 (the archive reaches back to 1910). Costs +72KB gzipped in the player bundle (134 → 206KB), since the pool is inlined by vite. The archive itself is now committed at `data/ssa/namesbystate.zip`. No change to era-filtering logic, deactivation controls, the diversity/region sampling algorithm, or how `region_frequency` is calculated. **Partly superseded by "Category draw weighted by real birth counts" below**: category is no longer a purely organisational label — it carries the frequency weight now — and the pool is 993 entries, not 994 ("Molly" was removed as a content-keyword collision). The health panel's share-cap exemption still stands. |
| Category draw weighted by real birth counts | shipped | on `dev` — the category half of a name draw was FLAT: 49 origins at ~1/49 each, so a player was exactly as likely to meet a maori-named character (2 names) as an anglo one (633). `region_frequency` could not fix it, because a location quotient is a ratio to the national rate — it encodes where a name is used and divides out how much. `server/name-pool.json` now carries `national_births` per entry (954 of 993 measured; the other 40 are the deliberately rare flavour names, below SSA's 5-per-state-year suppression floor), and `shared/names.js`'s new `categoryBirths()` sums it over the SURVIVING candidates so deactivating half an origin really does halve its weight. Wired into `assignName` as a third multiplicative factor beside the existing per-life diversity and per-session region terms; `BAL.NAMES.categoryPower` (0.35) damps it and `categoryBirthsFloor` (500) keeps an origin the archive cannot report from reaching zero weight, which would silently turn the weight into a filter. **0.35 is a measured ceiling, not a taste setting**: at 0.5 and 1.0 anglo takes 23.1% and 56.7% of draws and `npm run names` FAILS on `US-CA did not lift its own origins`, because region affinity is capped at 6x and anglo outweighs California's own origins ~460x in births — raising it retires regional weighting rather than reducing it. Shipped at 0.35: anglo 2% → 14.9%, same-origin repeat within one life 8.6%, all 49 origins reachable, and regional lift IMPROVED to 1.4-1.9x (was 1.3-2.0x). `name-check.js`'s old `top 8 origins > 60%` hard error is replaced — it measured "weighting too strong", which is now the design — by a direct assertion that no origin can reach zero probability. Also found and fixed a latent pool bug this exposed: **"Molly" is both a top-75 girl's name and slang for MDMA**, so cards naming her tripped the engine's own mature-content backstop and failed the simulator's mature-in-safe assertion 5 times. Fixed in the pool (dropped at generation, asserted in `npm run names`), NOT by softening `shared/content.js` — that backstop is one of three independent gates and is supposed to be blunt. 994 → 993 entries. No change to era filtering, deactivation controls, or the region-signal calculation. |
| Within-category draw weighted by real birth counts | shipped | on `dev` — the other half of the flat draw. Weighting the CATEGORY by births fixed which origin you meet but not which name: anglo's 14.9% still split evenly across 633 names while irish's 6.4% split across 23, so an individual Irish name stayed likelier than an individual anglo one and the single most-drawn name in the pool was **Fiona**. `nameFrequency(entry)` (`shared/names.js`) raises the entry's own `national_births` to `BAL.NAMES.nameFrequencyPower` and multiplies it into the inner pick alongside the region weight that was already there — same measurement as the category factor, same `categoryBirthsFloor` for a name the archive cannot report, and `power: 0` restores the old behaviour exactly. Result: irish now yields Brian/Ryan/Sean/Patrick, latin-american yields Jose/Maria/Manuel/Juan. **0.5 is set by region, not by taste**: the inner draw is where region is meant to choose WHICH name ("Minnesota's Scandinavian name is more often the one Minnesota registers"), and at 1.0 the within-category birth spread exceeds `regionCeiling` so region can no longer reorder irish-in-MA or scandinavian-in-MN at all, while at 0.5 it still reorders every case tested. Variety is not the binding constraint — distinct names drawn only falls 780 → 747 across the whole 0.35-1.0 range. A separate knob from `categoryPower` because the contest differs: there region competes with frequency ACROSS origins and loses past 0.35, here it competes INSIDE one, where the spread is narrower. No pool, era, deactivation or region-signal changes — this is one factor added to one line. |
| LLM provider abstraction + Ollama backend | shipped | on `dev` — `server/provider.js` is the seam every LLM caller now imports (`/api/scenarios` and `/api/intro` via `server/llm.js`, `/api/obituary`, `server/extraction.js` — and through it `server/harvest.js`'s library path — `server/seed-generation.js`, `server/admin/preview.js`, both CLI scripts' `hasKey` gates); `server/anthropic.js` is imported by nothing else. `complete` keeps anthropic.js's call signature and normalizes the return to `{ text, usage: {input, output}, stopReason, provider, model }` — the one downstream shape change is `server/llm.js`'s `tokenUsage`, which reads the normalized shape now. New `server/ollama.js` mirrors the interface against a local Ollama (`OLLAMA_BASE_URL` default localhost:11434, `OLLAMA_MODEL` required with no default — unset fails at STARTUP by name, unpulled fails at first use naming the model and the pulled list via `/api/tags`; structured-output support detected from the server version: schema-constrained `format` on ≥0.5.0, basic `"json"` below, reported once at handshake). Selection is `LLM_PROVIDER` (`anthropic` default — zero config change for existing deployments), server-wide for the process; per-player selection and player-supplied endpoints are explicitly future work (see "LLM provider abstraction" for the SSRF consideration that gates the latter). Log records gain a `provider` field; `keySource` stays `"server"` for both providers (server-run compute, same ownership reasoning as the server's key). No engine, effect-resolution, referee, schema, content or fallback changes — a malformed Ollama batch verified to hit the same retry-then-seed-fallback path as Anthropic. |
| Admin storyteller provider toggle | shipped | on `dev` — the admin header gained a "storyteller" switch between Anthropic and Ollama: `admin/src/components/ProviderToggle.jsx` + `GET|PUT /admin/api/provider` (`server/admin/index.js`) + `setProvider`/`providerStatus` in `server/provider.js`, whose `PROVIDER`/`MODEL` became `export let` LIVE BINDINGS so every importer (responses, logs, `/api/config`, `/api/health`) reflects a switch the moment it happens with zero call-site changes. Still server-wide (one storyteller per process — per-player selection remains future work) and runtime-only: `LLM_PROVIDER` is the boot default, a restart reverts, and the UI tags the model label "runtime, reverts on restart" whenever active ≠ boot. A switch is REFUSED with its reason when the target cannot serve — unknown name 400, no key / no `OLLAMA_MODEL` 400, unpulled Ollama model 503 via the same `/api/tags` handshake first use runs — leaving the previous provider active (verified live: toggle both directions in the browser, generation on the switched provider logging `provider: "ollama"`, and both refusal paths). A provider that isn't configured at boot renders as a disabled button with the reason in its tooltip. No engine, schema, content, fallback or player-client changes. |
| Extraction works on Ollama (array prefill) | shipped | on `dev` — bugfix. `extractPatterns` (`server/extraction.js`) was the ONE array-expecting `complete` caller that passed no `prefill: '['`. Harmless on Anthropic (the prefill is a nudge there; Claude follows the prompt's "return a JSON array" anyway), but on Ollama the prefill is load-bearing: `formatFor` (`server/ollama.js`) reads it to choose the grammar constraint, and no prefill meant `{ type: 'object' }` — schema-constrained decoding that made a top-level array IMPOSSIBLE, so the model returned an object wrapper and extraction's own `Array.isArray` guard reported "model did not return a JSON array". Hit anything through `extractPatterns` with the storyteller on Ollama: the harvest library path, the admin extraction paste box, `npm run extract-patterns`. One-line fix, verified live against Ollama 0.33.2 / qwen3-coder:30b. No prompt, validator, engine or provider-seam changes. |
| Anonymity sweep ignores field-initial capitals | shipped | on `dev` — bugfix for a false positive the Harvest and Extraction review UIs surfaced as "anonymity: possible proper nouns: Creates". `identityWarnings` (`server/extraction.js`) joined `pattern`/`typical_effects`/`note` with a space and then decapitalized only string-start and after-punctuation capitals — so a field's conventional opening imperative ("Creates a branch point…", "Fires once per life") sat "mid-sentence" whenever the previous field ended without punctuation, and got flagged as a name. The decapitalizing pass now runs PER FIELD, before joining, since each field starts its own sentence. The `Set`/`Create`/`Requires`/`Effects`/`Note` STOPWORDS entries were symptom patches for this same class; left in place as harmless belt-and-braces. Verified: the bug case flags `["Creates","Fires"]` under the old logic and nothing under the new, while mid-sentence proper nouns (Lehman, Nadia) and years still flag. Advisory-only path — no blocking, merging, engine or prompt changes. |
| Category vocabulary drift normalized at extraction | shipped | on `dev` — bugfix for harvested pattern drafts arriving with a category the model invented ("education"), which `validatePattern` rightly rejects, leaving a draft in the queue whose Approve button can only fail ("draft is not a valid pattern yet: category: education"). Two halves. Server: `CATEGORY_ALIASES`/`normalizeCategory` (`server/extraction.js`) maps a stray label to its ONE clear home in the vocabulary at parse time (education/school/work/job → career; finance/financial → money; relationship(s) → romance — career is where the live library files every education-shaped pattern), applied inside `extractPatterns` so the CLI, the admin paste box and the harvest library path all get it; an unmapped label stays as written for `validatePattern` to flag, since guessing a home for an ambiguous label is worse than an honest problem report. Admin: `PatternForm.jsx` now mirrors the server's category check in its inline validation AND renders an off-vocabulary value as a visible disabled option — a controlled `<select>` whose value matches no option renders BLANK, which hid exactly the field the reviewer needed to fix. The three stuck drafts were re-labeled to `career` through the running admin's own PUT route (store-backed: backup, atomic write, version check), approval left to a person. No prompt, engine, schema-vocabulary or referee changes — `CATEGORIES` itself is untouched. |
| Region weights rebuilt on one archive vintage | shipped | on `dev` — housekeeping with a real payoff. The pool had been sitting on TWO archive vintages: the 807 SSA-sourced entries were measured against the committed 2025 archive, while the 187 originals kept maps from an older one that predated Florida's inclusion, so not a single entry carried a `US-FL` key. `npm run build-region-weights -- ../ssa-state` re-run across all 993 entries puts every map on the same 2025 data. No code change at all — the script already mutated `region_frequency` in place rather than replacing the record, so `national_births`, `active` and every other field survived untouched (verified: 993 entries, 953 with `national_births`, key order intact). Results: 908 → 914 entries with a regional map, 23,417 region entries written, 50 → 51 distinct regions, and 360 entries now carry `US-FL`. Measured regional lift IMPROVED to 1.4-2.2x (was 1.4-1.9x), with US-HI now 2.2x. Florida itself turns out to tilt only mildly — caribbean 1.12x, latin-american 1.02x — and that is the data, not a bug: FL has 16 entries above 2x against Minnesota's 48, and 253 of its 360 entries sit BELOW 0.8x, which is what a high-migration state whose naming profile sits near the national average looks like. Its strongest signals are plausible (Joaquim 8.9x, Rafaela, Thiago; Winston; Valentina). No pool membership, era, deactivation, weighting-method or selection changes. |

---

## The admin module

A separate interface for editing content — the library, the seed deck, the
name pool, the extraction draft queue — plus a cross-reference check, a live
preview, a content harvester and a stats view. `npm run admin`, then
<http://localhost:8787/admin>.

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
- **The Name Pool tab is one tab strip, not a table plus three stacked
  cards.** `admin/src/components/NamePool.jsx` holds a single `tab` state
  (`'names'` default) switching between four panels — Names (the
  browsable/filterable table, bulk-select and create/edit modal, unchanged
  from before this rework), Category, Region and Gender association — behind
  a small button strip reusing the header's `.tabs` button styling (a new
  `.tabs--sub` CSS variant, since a bare `.tabs` inside a column-flex `.pane`
  stretches full-width and floats right). Only the Pool Health panel stays
  pinned above the strip regardless of which tab is active. The three group
  controls still go through `admin/src/components/GroupControls.jsx` — still
  one component, three instantiations — and every row there carries a names
  disclosure (a plain `<details>`, collapsed by default) that expands to the
  actual names in that group — category/gender_assoc match by equality,
  region by any `region_frequency` entry for that code. It filters the
  `namePool` array `NamePool.jsx` already passes down as a prop, through the
  same `matchNames(entry, row.value)` predicate that computes the row's
  count, so the two can never disagree — no separate API call, same as the
  count never was one.
- **Each group-control tab's bulk select is one atomic API call, not a loop
  over the single-row routes.** `GroupControls.jsx`'s selection toolbar
  (checkboxes, "Select all", "Activate selected"/"Deactivate selected",
  each acting only on the applicable subset of the selection) calls
  `POST /api/name-pool-controls/:kind/bulk` — new, same shape as
  `/api/name-pool/bulk-active` — through props threaded from
  `admin/src/App.jsx`. A client-side loop calling the existing per-value
  `onDeactivate`/`onReactivate` closures repeatedly would have raced itself:
  each of those closures captures `boot.nameControlsVersion` from whichever
  render created it, nothing re-renders mid-loop, so every call after the
  first would carry a stale version and hit the store's conflict check.
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
- **The header's "storyteller" toggle switches the LLM provider at runtime** —
  server-wide, for every life this process serves, which is exactly why it
  lives here and not in the player UI. `admin/src/components/ProviderToggle.jsx`
  → `PUT /admin/api/provider` → `provider.js`'s `setProvider`. Runtime-only
  (`LLM_PROVIDER` stays the boot default; restart reverts — the label says so
  whenever active ≠ boot), and a switch to a provider that could not serve
  (no key, model not pulled) is refused with the reason while the previous
  provider stays active. See "LLM provider abstraction" below.
- `admin/` is a separate Vite root building to `dist-admin/`. `npm run build`
  never sees it, which is why no admin code can reach the player bundle.

### Request/response logging

`server/llm.js` wraps the Anthropic call made by `/api/scenarios` — the one
that runs on every swipe — and writes one JSON line per call to
`server/logs/llm-requests.jsonl` regardless of outcome. The write is
fire-and-forget (`log-store.js`'s `appendLog`, called from inside the
`fs.appendFile` callback), so a slow disk never delays the response already on
its way to the player.

`/api/intro` (the intro flow's one-off establishing-scene call, see "The
opening intro sequence" below) is wrapped the same way, with `triggeredBy:
"intro_generation"`. `age`/`contentMode`/`librarySlotUsed` are all `null` on
that call - it has no live player's state to draw them from, and no scenario
shape to validate against `validateBatch`.

Deliberately **not** wrapped: the obituary call, admin preview, and pattern
extraction. Preview and extraction already show their own raw output in the
admin UI, so nothing about them is opaque today.

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

`provider` (`"anthropic"` | `"ollama"`) says which backend ran the call —
recorded even when the call errored, since the provider was still asked. It is
deliberately not a `keySource` value: see "LLM provider abstraction" below.

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
`validationResult === "passed"`, and `triggeredBy` is `"batch_generation"` or
`"validator_retry"` — the two values an actual scenario-generation call
carries. That last check is what keeps the intro flow's one-off establishing
beat (`triggeredBy: "intro_generation"`, logged the same way as a gameplay
call — see "Request/response logging" above) out of the harvester entirely:
it is a fixed non-interactive line with no decision, not a scenario a life
could ever repeat. And the individual card carries no more than
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

## LLM provider abstraction

The storyteller can be Anthropic (the default) or a local Ollama instance,
chosen by `LLM_PROVIDER` at startup — **server-wide, for the whole process**.
This is permanent infrastructure, the foundation for a future per-player
local-model option, not a dev toggle.

**The seam is `server/provider.js`, and it is the only importer of a backend
client.** Everything that talks to a model — `/api/scenarios` and `/api/intro`
(through `server/llm.js`'s logging wrapper), `/api/obituary`,
`server/extraction.js` (and through it `server/harvest.js`'s library path),
`server/seed-generation.js`, the admin preview, and both CLI scripts' `hasKey`
gates — imports `provider.js`. Its `complete` keeps `anthropic.js`'s exact
call signature and normalizes the return to
`{ text, usage: { input, output }, stopReason, provider, model }`, so nothing
downstream — validators, logging, harvesting — knows or cares which provider
ran. The storyteller/referee split is identical either way: whichever model
writes the proposals, the engine still owns every number.

**Selection.** `LLM_PROVIDER=anthropic` is the default — an existing
deployment needs zero config changes. `LLM_PROVIDER=ollama` additionally
requires `OLLAMA_MODEL` (no default, deliberately: a guessed model that isn't
pulled would fail confusingly mid-generation, so an unset one fails at startup
by name instead) and honors `OLLAMA_BASE_URL` (default
`http://localhost:11434`) and `OLLAMA_TIMEOUT_MS` (a floor of 120s over caller
timeouts — local inference is a different latency regime). On first use the
Ollama client verifies the configured model against `/api/tags`, failing with
the model's name and the pulled list rather than a generic fetch error, and
detects whether the server supports schema-constrained `format` (Ollama
≥ 0.5.0) or only basic `format: "json"`, logging which one it found. An
unknown `LLM_PROVIDER` value refuses to boot rather than silently meaning
"anthropic".

**Runtime toggle, admin-only.** The admin header carries a "storyteller"
switch (`admin/src/components/ProviderToggle.jsx`, `GET|PUT
/admin/api/provider`, `provider.js`'s `setProvider`). It is still the same
server-wide selection — one storyteller for every life this process serves,
NOT per-player — just settable without a restart, and **runtime-only**:
`LLM_PROVIDER` stays the boot default and a restart reverts to it (the UI
tags the label "runtime, reverts on restart" whenever the active provider
differs from the boot one). A switch is refused, with the reason, if the
target could not serve the next call — no `ANTHROPIC_API_KEY`, no
`OLLAMA_MODEL`, or (via the same first-use handshake) an Ollama model that
is not actually pulled — so a failed toggle keeps the previous provider
rather than quietly turning every generation into a seed fallback. It lives
in the admin, not the player UI, on purpose: server-wide state belongs on
the server-config surface, and the player client deliberately never mentions
providers. `provider.js` exports `PROVIDER`/`MODEL` as **live bindings**
(`export let`) so every importer sees a switch the moment it happens.

**`keySource` does not change for Ollama.** That field answers "whose key paid
for this call" so the harvester knows what it may mine; a server-run Ollama
instance is the server's own compute, exactly as the server's Anthropic key is
the server's own spend, so both providers log `keySource: "server"`. Which
backend ran is a separate question, answered by the new `provider` field on
each log record. Calls that were never logged (obituary, extraction, admin
preview, seed-gen) stay unlogged under either provider.

**Expect a higher validation-failure/fallback rate on Ollama.** A local model
writes weaker JSON and weaker cards than Anthropic; that is a capability gap,
not a bug. A malformed Ollama batch hits the exact same
retry-then-seed-fallback path a malformed Anthropic batch does (verified
deliberately, with a mock returning prose: attempt 1 `failed`, retry
`fell_back_to_seed`, client got seed content) — no changes to
`shared/schema.js`, `shared/content.js`, or any fallback logic.

**Not built yet, on purpose:**

- **Per-player provider selection.** Selection is one env var for the whole
  process; there is no per-request or per-player routing, and nothing
  client-facing mentions providers.
- **A player-supplied Ollama endpoint.** The base URL is server config only.
- The **SSRF consideration** a player-supplied URL would create: a URL a
  player controls would let them point the server's own HTTP client at
  internal services (cloud metadata endpoints, the loopback-only admin, other
  LAN hosts). Before any such feature ships it needs egress validation —
  scheme/host allow-listing, private-range blocking, no redirects — plus a
  `keySource`/harvest-eligibility decision, since a player-run model's output
  is their content (the `byok` reasoning applies to compute, not just keys).

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
