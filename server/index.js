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
import { SYSTEM_PROMPT, buildUserPrompt, OBITUARY_SYSTEM, buildObituaryPrompt } from './prompt.js';
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

/* -------------------------------------------------------------- endpoints */

app.get('/api/config', (_req, res) => {
  res.json({ llmEnabled: hasKey(), model: hasKey() ? MODEL : null });
});

// POST /api/scenarios  { summary, recent, count }
// Always 200 with { scenarios, source }. A failure here is not a game-over;
// it just means the client keeps playing from seeds.
app.post('/api/scenarios', async (req, res) => {
  const { summary, recent = [], count = 5 } = req.body || {};

  if (!summary || typeof summary !== 'object' || !summary.stage) {
    return res.status(400).json({ error: 'summary with a stage is required', scenarios: [] });
  }
  if (!hasKey()) {
    return res.json({ scenarios: [], source: 'none', reason: 'no ANTHROPIC_API_KEY set' });
  }

  const user = buildUserPrompt({ summary, recent: recent.slice(-10), count });
  const attempts = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await complete({
        system: SYSTEM_PROMPT,
        user: attempt === 0
          ? user
          : user + '\n\nIMPORTANT: your previous reply was not valid. Reply with ONLY a JSON array of 5 scenario objects. No prose, no code fences.',
        prefill: '[',
        maxTokens: 4000,
        temperature: attempt === 0 ? 1 : 0.7,
      });

      const parsed = extractJson(text);
      const { ok, scenarios, errors } = validateBatch(parsed, { minValid: 3 });

      if (ok) {
        return res.json({
          scenarios,
          source: 'llm',
          model: MODEL,
          attempt: attempt + 1,
          dropped: errors.length,
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

app.listen(PORT, () => {
  console.log(`\n  Life Swipe listening on http://localhost:${PORT}`);
  console.log(`  storyteller: ${hasKey() ? MODEL : 'OFFLINE (no ANTHROPIC_API_KEY - seed content only)'}`);
  console.log(`  client build: ${fs.existsSync(DIST) ? 'dist/' : 'MISSING (run npm start)'}\n`);
});
