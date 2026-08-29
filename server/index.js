// Life Swipe server.
//
// Two jobs: serve the built client, and proxy Anthropic so the API key stays
// on this side of the wire. Every model response is validated before it is
// allowed anywhere near the game; malformed batches get exactly one retry and
// then the client is told to fall back to seed content.

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { complete, extractJson, hasKey, MODEL } from './anthropic.js';
import { callLLM, AnthropicError } from './llm.js';
import {
  buildSystemPrompt, buildUserPrompt, OBITUARY_SYSTEM, buildObituaryPrompt,
  INTRO_SYSTEM, buildIntroPrompt,
} from './prompt.js';
import { effectiveTier } from '../shared/content.js';
import { checkCoverage, coverage } from '../scripts/coverage.js';
import { validateBatch } from '../shared/schema.js';
import { NAME_POOL, resolveBatchEphemeral } from '../shared/names.js';
import { resolveRegion } from './geo.js';
import { createAdminRouter } from './admin/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DIST_ADMIN = path.join(ROOT, 'dist-admin');
const PORT = Number(process.env.PORT) || 8787;

// Loopback, deliberately and by default. The admin module has NO authentication
// in this pass, so the only thing standing between it and the network is this
// bind address - which means the game is localhost-only too. That is the
// accepted trade: see the admin mount below, which refuses to load at all if
// this is ever pointed somewhere else.
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const isLoopback = LOOPBACK.has(HOST);

const app = express();
// Behind a reverse proxy, req.ip is the proxy unless Express is told otherwise,
// which would hand every player the datacentre's region. Off by default because
// trusting X-Forwarded-For from an untrusted client lets it claim any region:
// set TRUST_PROXY (a hop count, or a subnet) only when a proxy really is there.
if (process.env.TRUST_PROXY) {
  const value = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isFinite(value) ? value : process.env.TRUST_PROXY);
}
app.use(express.json({ limit: '512kb' }));

const seedScenarios = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'scenarios-seed.json'), 'utf8'),
);
const situationLibrary = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'situation-library.json'), 'utf8'),
);

/**
 * Name resolution OUTSIDE a real player context - the admin live preview,
 * which posts sample state and has no persisted player to write to.
 *
 * Everything here is in-memory and scoped to this one call: the ledger is
 * created, spent and dropped inside the function, so a preview can never
 * consume a name or a category from anybody's actual life. Seeded from the
 * request rather than the clock, so the same sample state previews the same
 * cast twice running.
 */
function previewNames(scenarios, summary) {
  const relationships = {};
  for (const r of summary.relationships || []) {
    if (r && r.name) relationships[r.name] = { role: r.role || 'acquaintance' };
  }
  return resolveBatchEphemeral(scenarios, {
    relationships,
    kids: summary.kids || [],
    age: summary.age,
    seedInput: { age: summary.age, stage: summary.stage, turn: summary.turn, people: summary.relationships },
  });
}

/* -------------------------------------------------------------- endpoints */

app.get('/api/config', (_req, res) => {
  res.json({ llmEnabled: hasKey(), model: hasKey() ? MODEL : null });
});

// POST /api/scenarios  { summary, recent, count }
// Always 200 with { scenarios, source }. A failure here is not a game-over;
// it just means the client keeps playing from seeds.
app.post('/api/scenarios', async (req, res) => {
  const { summary, recent = [], count = 5, librarySlot = null, preview = false } = req.body || {};

  if (!summary || typeof summary !== 'object' || !summary.stage) {
    return res.status(400).json({ error: 'summary with a stage is required', scenarios: [] });
  }
  if (!hasKey()) {
    return res.json({ scenarios: [], source: 'none', reason: 'no ANTHROPIC_API_KEY set' });
  }

  // The client sends a tier, but the server resolves it again from age and
  // mode. A client that asks for mature content for a 15-year-old gets safe
  // content, because this line does not consult the request's own answer.
  const tier = effectiveTier({ age: summary.age, contentMode: summary.contentMode });
  const system = buildSystemPrompt(tier);
  // The client selects the pattern (it owns the RNG and the cross-life seen
  // list); the server only injects the brief and echoes back which one it used.
  const user = buildUserPrompt({
    summary: { ...summary, tier },
    recent: recent.slice(-10),
    count,
    librarySlot,
  });
  const attempts = [];
  const calls = [];       // every LLM call made for this request, logged once each below
  let won = null;         // the attempt (if any) whose output actually validated

  for (let attempt = 0; attempt < 2; attempt++) {
    const call = await callLLM({
      system,
      user: attempt === 0
        ? user
        : user + '\n\nIMPORTANT: your previous reply was not valid. Reply with ONLY a JSON array of 5 scenario objects. No prose, no code fences.',
      prefill: '[',
      maxTokens: 4000,
      temperature: attempt === 0 ? 1 : 0.7,
      meta: {
        age: summary.age,
        contentMode: summary.contentMode,
        triggeredBy: attempt === 0 ? 'batch_generation' : 'validator_retry',
        librarySlotUsed: librarySlot ? librarySlot.id : null,
        // Paid for by the server's own ANTHROPIC_API_KEY - anthropic.js has no
        // other key path. Stated rather than assumed because the harvester
        // treats an undeclared call as ineligible (see server/llm.js).
        keySource: 'server',
      },
    });
    calls.push(call);

    if (call.error) {
      attempts.push(`attempt ${attempt + 1}: ${call.error.message}`);
      // Auth and rate-limit problems will not fix themselves on a retry.
      if (call.error instanceof AnthropicError && (call.error.status === 401 || call.error.status === 429)) break;
      continue;
    }

    const parsed = extractJson(call.text);
    const { ok, scenarios, errors, warnings, rejectedForMode, rejectedForNameDrift } = validateBatch(parsed, {
      minValid: 3,
      tier,
      age: summary.age,
      // First of two passes at name drift; the client runs the same check
      // again against the live map before anything is buffered.
      relationships: summary.relationships,
      // The same recent window the model was shown, so the reintroduction
      // check knows which named people were off-screen when it wrote a card.
      recent: recent.slice(-10),
    });

    // Advisory craft warnings ride on the call either way: a failed batch can
    // still contain passing major cards worth measuring.
    call.validationWarnings = warnings;
    if (ok) {
      won = { call, scenarios, errors, warnings, rejectedForMode, rejectedForNameDrift };
      break;
    }
    call.validationErrors = errors;
    attempts.push(`attempt ${attempt + 1}: ${errors.slice(0, 3).join('; ') || 'no valid scenarios'}`);
  }

  // Log every call now that the whole request's outcome is known: the winner
  // (if any) passed; an earlier call that will be retried failed; whichever
  // call was the LAST one made is what the player actually falls back away
  // from if nothing won.
  calls.forEach((call, i) => {
    if (won && call === won.call) call.finalizeLog('passed', null, call.validationWarnings);
    else if (!won && i === calls.length - 1) call.finalizeLog('fell_back_to_seed', call.validationErrors, call.validationWarnings);
    else call.finalizeLog('failed', call.validationErrors, call.validationWarnings);
  });

  if (won) {
    // In real play the client resolves "{{new:roommate}}" at deal time,
    // against live state. A preview has no player and nothing to write to,
    // so it gets names here from a throwaway ledger seeded by the request.
    const { scenarios: out, assignedNames } = preview
      ? previewNames(won.scenarios, summary)
      : { scenarios: won.scenarios, assignedNames: null };

    return res.json({
      scenarios: out,
      source: 'llm',
      model: MODEL,
      tier,
      librarySlot: librarySlot ? librarySlot.id : null,
      attempt: calls.indexOf(won.call) + 1,
      dropped: won.errors.length,
      warnings: won.warnings.length,
      rejectedForMode: won.rejectedForMode,
      rejectedForNameDrift: won.rejectedForNameDrift,
      ...(preview ? { preview: true, assignedNames } : {}),
    });
  }

  console.warn('[scenarios] falling back to seed content:', attempts.join(' | '));
  res.json({ scenarios: [], source: 'fallback', reason: attempts.join(' | ') });
});

// POST /api/obituary  { stats, history }
app.post('/api/obituary', async (req, res) => {
  const { stats, history = [] } = req.body || {};
  if (!stats || typeof stats !== 'object') {
    return res.status(400).json({ error: 'stats is required' });
  }
  if (!hasKey()) return res.json({ source: 'fallback', reason: 'no ANTHROPIC_API_KEY set' });

  try {
    const { text } = await complete({
      system: OBITUARY_SYSTEM,
      user: buildObituaryPrompt(stats, history),
      prefill: '{',
      maxTokens: 1200,
      temperature: 1,
    });
    const parsed = extractJson(text);
    if (parsed && typeof parsed.obituary === 'string' && parsed.obituary.trim()) {
      return res.json({
        source: 'llm',
        model: MODEL,
        headline: String(parsed.headline || 'A Life, Concluded').slice(0, 120),
        obituary: parsed.obituary.slice(0, 2000),
        epitaph: String(parsed.epitaph || '').slice(0, 160),
      });
    }
    res.json({ source: 'fallback', reason: 'obituary failed validation' });
  } catch (err) {
    console.warn('[obituary]', err.message);
    res.json({ source: 'fallback', reason: err.message });
  }
});

// How long a field is trusted to be, without leaning on validateScenario's
// prompt/decision-shape rules - this content has no decision by design, so
// those rules do not apply here.
const INTRO_BEAT_FIELD_LEN = [15, 240];

function validateIntroBeat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const [min, max] = INTRO_BEAT_FIELD_LEN;
  const setting = typeof raw.setting === 'string' ? raw.setting.trim() : '';
  const beat = typeof raw.beat === 'string' ? raw.beat.trim() : '';
  if (setting.length < min || setting.length > max) return null;
  if (beat.length < min || beat.length > max) return null;
  return { setting, beat };
}

// POST /api/intro  { financialTier, personality, region }
// The one non-interactive establishing scene between the two authored
// identity choices (shared/intro.js) and the first deck.draw() card. Routed
// through callLLM so it is logged like any generation call, but tagged with a
// distinct triggeredBy: this is a fixed one-off beat with no decision, never a
// scenario a life could repeat, so server/harvest.js's eligibility check
// excludes it by construction. Always 200; a failure here just means the
// client shows one of shared/intro.js's authored fallback beats.
app.post('/api/intro', async (req, res) => {
  const { financialTier, personality, region = null } = req.body || {};
  if (!hasKey()) return res.json({ source: 'fallback', reason: 'no ANTHROPIC_API_KEY set' });

  const call = await callLLM({
    system: INTRO_SYSTEM,
    user: buildIntroPrompt({ region, financialTier, personality }),
    prefill: '{',
    maxTokens: 400,
    temperature: 1,
    meta: {
      triggeredBy: 'intro_generation',
      // Paid for by the server's own ANTHROPIC_API_KEY, same as every other
      // live call - stated rather than assumed, same reasoning as
      // /api/scenarios above.
      keySource: 'server',
    },
  });

  if (call.error) {
    call.finalizeLog('failed', [call.error.message], null);
    return res.json({ source: 'fallback', reason: call.error.message });
  }

  const beat = validateIntroBeat(extractJson(call.text));
  if (!beat) {
    call.finalizeLog('failed', ['intro beat failed the lightweight schema check'], null);
    return res.json({ source: 'fallback', reason: 'invalid intro beat' });
  }
  call.finalizeLog('passed', null, null);
  res.json({ source: 'llm', ...beat });
});

app.get('/api/seed-scenarios', (_req, res) => res.json(seedScenarios));

app.get('/api/situation-library', (_req, res) => res.json(situationLibrary));

// The cast the engine draws from. Served for tooling and preview parity; the
// client bundles it directly, since naming has to work offline too.
app.get('/api/name-pool', (_req, res) => res.json(NAME_POOL));

// GET /api/region -> { region: "US-MN" | null, reason }
//
// Resolved offline from the caller's own IP (see server/geo.js for the privacy
// contract: the address is used and dropped here, and only a state-or-country
// code ever leaves). The client asks once, stores the code, and lets the
// player override it - so this is a suggested default, never a decision.
app.get('/api/region', (req, res) => {
  const { region, reason } = resolveRegion(req.ip);
  res.json({ region, reason });
});

// Content stats, so a thin bucket can be seen rather than inferred from
// repetition complaints.
app.get('/api/coverage', (_req, res) => {
  const rows = coverage(seedScenarios);
  res.json({
    seeds: seedScenarios.length,
    patterns: situationLibrary.length,
    buckets: rows,
    shortfalls: rows.filter((r) => r.short),
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, llmEnabled: hasKey(), model: MODEL }));

/* ----------------------------------------------------------------- admin */

// The content admin. Unauthenticated, so it is mounted ONLY when the server is
// bound to loopback. Pointing HOST at an interface the network can reach does
// not expose the admin - it removes the admin, loudly. The fix at that point is
// authentication, not deleting this check.
if (isLoopback) {
  const adminRouter = createAdminRouter();
  app.use('/admin', adminRouter);
  if (fs.existsSync(DIST_ADMIN)) {
    app.use('/admin', express.static(DIST_ADMIN));
    app.get('/admin/*', (req, res, next) => {
      if (req.path.startsWith('/admin/api/')) return next();
      res.sendFile(path.join(DIST_ADMIN, 'index.html'));
    });
  } else {
    app.get('/admin*', (req, res, next) => {
      if (req.path.startsWith('/admin/api/')) return next();
      res.status(503).type('text/plain').send(
        'The admin UI has not been built.\n\nRun:  npm run admin   (builds dist-admin/, then serves)\n',
      );
    });
  }
} else {
  console.warn(
    `\n  [admin] NOT mounted: HOST is "${HOST}", which is not loopback.\n` +
    '  The admin module has no authentication, so it is only ever served on\n' +
    '  127.0.0.1. Add real auth before exposing it.\n',
  );
  // Answer /admin explicitly rather than letting the player SPA's catch-all
  // serve the game there. Without this the route 200s with the player app,
  // which reads like a broken admin instead of an absent one.
  app.all('/admin*', (_req, res) => {
    res.status(404).type('text/plain').send(
      'The admin module is not available: this server is not bound to loopback.\n',
    );
  });
}

/* ------------------------------------------------------------ static site */

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  app.get('*', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('No client build found.\n\nRun:  npm start   (builds, then serves)\nOr:   npm run dev   (Vite dev server on :5173)');
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Life Swipe listening on http://localhost:${PORT}  (bound to ${HOST})`);
  console.log(`  storyteller: ${hasKey() ? MODEL : 'OFFLINE (no ANTHROPIC_API_KEY - seed content only)'}`);
  console.log(`  client build: ${fs.existsSync(DIST) ? 'dist/' : 'MISSING (run npm start)'}`);
  if (isLoopback) {
    console.log(`  admin:        http://localhost:${PORT}/admin  ` +
      `(${fs.existsSync(DIST_ADMIN) ? 'built' : 'NOT BUILT - run npm run admin'}, no auth, loopback only)`);
  }
  console.log('');
});

// A busy port is an ordinary thing - usually a previous run still alive - and
// deserves an instruction rather than a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use, most likely by a previous Life Swipe server.\n');
    console.error('  Run it somewhere else:');
    console.error('      bash:        PORT=8788 npm start');
    console.error('      PowerShell:  $env:PORT=8788; npm start\n');
    console.error('  Or stop whatever is holding the port:');
    console.error('      PowerShell:  Get-NetTCPConnection -LocalPort ' + PORT +
                  ' -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
    console.error('      any shell:   npx kill-port ' + PORT + '\n');
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error('\n  Not allowed to bind port ' + PORT + '. Try a port above 1024.\n');
    process.exit(1);
  }
  throw err;
});
