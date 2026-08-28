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

import { complete, extractJson, hasKey, MODEL, AnthropicError } from './anthropic.js';
import { buildSystemPrompt, buildUserPrompt, OBITUARY_SYSTEM, buildObituaryPrompt } from './prompt.js';
import { effectiveTier } from '../shared/content.js';
import { validateBatch } from '../shared/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 8787;

const app = express();
app.use(express.json({ limit: '512kb' }));

const seedScenarios = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'scenarios-seed.json'), 'utf8'),
);
const situationLibrary = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'situation-library.json'), 'utf8'),
);

/* -------------------------------------------------------------- endpoints */

app.get('/api/config', (_req, res) => {
  res.json({ llmEnabled: hasKey(), model: hasKey() ? MODEL : null });
});

// POST /api/scenarios  { summary, recent, count }
// Always 200 with { scenarios, source }. A failure here is not a game-over;
// it just means the client keeps playing from seeds.
app.post('/api/scenarios', async (req, res) => {
  const { summary, recent = [], count = 5, librarySlot = null } = req.body || {};

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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await complete({
        system,
        user: attempt === 0
          ? user
          : user + '\n\nIMPORTANT: your previous reply was not valid. Reply with ONLY a JSON array of 5 scenario objects. No prose, no code fences.',
        prefill: '[',
        maxTokens: 4000,
        temperature: attempt === 0 ? 1 : 0.7,
      });

      const parsed = extractJson(text);
      const { ok, scenarios, errors, rejectedForMode } = validateBatch(parsed, {
        minValid: 3,
        tier,
        age: summary.age,
      });

      if (ok) {
        return res.json({
          scenarios,
          source: 'llm',
          model: MODEL,
          tier,
          librarySlot: librarySlot ? librarySlot.id : null,
          attempt: attempt + 1,
          dropped: errors.length,
          rejectedForMode,
        });
      }
      attempts.push(`attempt ${attempt + 1}: ${errors.slice(0, 3).join('; ') || 'no valid scenarios'}`);
    } catch (err) {
      attempts.push(`attempt ${attempt + 1}: ${err.message}`);
      // Auth and rate-limit problems will not fix themselves on a retry.
      if (err instanceof AnthropicError && (err.status === 401 || err.status === 429)) break;
    }
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

app.get('/api/seed-scenarios', (_req, res) => res.json(seedScenarios));

app.get('/api/situation-library', (_req, res) => res.json(situationLibrary));

app.get('/api/health', (_req, res) => res.json({ ok: true, llmEnabled: hasKey(), model: MODEL }));

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

const server = app.listen(PORT, () => {
  console.log(`\n  Life Swipe listening on http://localhost:${PORT}`);
  console.log(`  storyteller: ${hasKey() ? MODEL : 'OFFLINE (no ANTHROPIC_API_KEY - seed content only)'}`);
  console.log(`  client build: ${fs.existsSync(DIST) ? 'dist/' : 'MISSING (run npm start)'}\n`);
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
