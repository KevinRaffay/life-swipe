// The admin API. Mounted at /admin by server/index.js, and only ever there.
//
// NO AUTHENTICATION IN THIS PASS. The safety property is the socket: the whole
// server binds to 127.0.0.1, so nothing off this machine can reach these routes.
// server/index.js additionally refuses to mount this router at all if the bind
// host is not loopback. Before this is exposed anywhere, it needs real auth -
// every route below can rewrite the game's content files.

import express from 'express';
import { read, write, update, exists, fileOf, ConflictError } from './store.js';
import { validateLibraryPattern, validateSeedScenario, generateId,
  PATTERN_CATEGORIES, PATTERN_RARITIES, MODES } from './content-schema.js';
import { crossReference } from './cross-reference.js';
import { previewPattern, previewSeed, yearFor } from './preview.js';
import { extractPatterns, identityWarnings, idCollisions, duplicateWarnings } from '../extraction.js';
import { hasKey, MODEL } from '../anthropic.js';
import { queryLogs, getLogEntry, getLogSummary } from '../log-store.js';
import { US_REGIONS } from '../../shared/regions.js';

// try/await rather than Promise.resolve(fn()).catch(): a handler that throws
// SYNCHRONOUSLY - which is exactly what the store does on a version conflict -
// throws before .catch is ever attached, and the request falls through to
// Express's default HTML error page instead of the JSON the client parses.
// Found by testing the conflict path rather than by reading this code.
const asHandler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status || (err instanceof ConflictError ? 409 : 500);
    if (status >= 500) console.error('[admin]', err);
    res.status(status).json({ error: err.message, details: err.details || null });
  }
};

// Writes carry the version the client last read. A mismatch is refused unless
// the client explicitly asks to overwrite, which is what the UI's "save anyway"
// sends after showing the warning.
const writeOpts = (req) => ({
  version: typeof req.body?.version === 'string' ? req.body.version : null,
  force: req.body?.force === true,
});

export function createAdminRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  /* --------------------------------------------------------------- meta */

  router.get('/api/bootstrap', asHandler((_req, res) => {
    const library = read('library');
    const seeds = read('seeds');
    const drafts = read('drafts');
    res.json({
      library: library.data,
      libraryVersion: library.version,
      seeds: seeds.data,
      seedsVersion: seeds.version,
      drafts: drafts.data,
      draftsVersion: drafts.version,
      threadsPresent: exists('threads'),
      llmEnabled: hasKey(),
      model: hasKey() ? MODEL : null,
      vocab: { categories: PATTERN_CATEGORIES, rarities: PATTERN_RARITIES, modes: MODES },
      regions: US_REGIONS,
      files: { library: fileOf('library'), seeds: fileOf('seeds'), drafts: fileOf('drafts') },
    });
  }));

  router.get('/api/validate', asHandler((_req, res) => res.json(crossReference())));

  router.get('/api/stats', asHandler((_req, res) => {
    const library = read('library').data;
    const seeds = read('seeds').data;
    const drafts = read('drafts').data;
    const tally = (items, key) => items.reduce((acc, item) => {
      const value = item[key];
      for (const v of Array.isArray(value) ? value : [value]) {
        acc[v ?? 'unset'] = (acc[v ?? 'unset'] || 0) + 1;
      }
      return acc;
    }, {});
    const { stats } = crossReference();
    res.json({
      patterns: {
        total: library.length,
        byCategory: tally(library, 'category'),
        byRarity: tally(library, 'rarity'),
        byMode: tally(library, 'modes'),
      },
      seeds: {
        total: seeds.length,
        byMode: tally(seeds, 'modes'),
        byWeight: tally(seeds, 'weight'),
        byStage: tally(seeds.map((s) => ({ stage: (s.stages || ['unset'])[0] })), 'stage'),
      },
      drafts: drafts.length,
      threads: exists('threads') ? read('threads').data.length : null,
      crossReference: stats,
    });
  }));

  /* ------------------------------------------------------------ library */

  const libraryRoutes = (name, validate, label) => {
    router.get(`/api/${name}`, asHandler((_req, res) => {
      const { data, version } = read(name);
      res.json({ data, version });
    }));

    router.post(`/api/${name}`, asHandler((req, res) => {
      const record = req.body?.record;
      const current = read(name).data;
      const problems = validate(record, current);
      if (problems.length) return res.status(400).json({ error: `invalid ${label}`, problems });
      const result = update(name, (list) => [...list, record], writeOpts(req));
      res.json({ ok: true, data: result.data, version: result.version, backup: result.backup });
    }));

    router.put(`/api/${name}/:id`, asHandler((req, res) => {
      const record = req.body?.record;
      const current = read(name).data;
      const index = current.findIndex((r) => r.id === req.params.id);
      if (index === -1) return res.status(404).json({ error: `no ${label} with id ${req.params.id}` });
      const problems = validate(record, current.filter((_, i) => i !== index));
      if (problems.length) return res.status(400).json({ error: `invalid ${label}`, problems });
      const result = update(name, (list) => list.map((r, i) => (i === index ? record : r)), writeOpts(req));
      res.json({ ok: true, data: result.data, version: result.version, backup: result.backup });
    }));

    router.delete(`/api/${name}/:id`, asHandler((req, res) => {
      const current = read(name).data;
      if (!current.some((r) => r.id === req.params.id)) {
        return res.status(404).json({ error: `no ${label} with id ${req.params.id}` });
      }
      const result = update(name, (list) => list.filter((r) => r.id !== req.params.id), writeOpts(req));
      res.json({ ok: true, data: result.data, version: result.version, backup: result.backup });
    }));
  };

  libraryRoutes('library', (record, siblings) => validateLibraryPattern(record, siblings), 'pattern');
  libraryRoutes('seeds', (record, siblings) => validateSeedScenario(record, siblings).problems, 'scenario');

  /* ------------------------------------------------- extraction + drafts */

  // Extraction APPENDS to the draft file and touches the library never. That
  // separation is the whole design: a model proposes, a person merges.
  router.post('/api/extract', asHandler(async (req, res) => {
    const source = String(req.body?.text || '');
    if (!source.trim()) return res.status(400).json({ error: 'paste some source text first' });
    if (!hasKey()) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set' });

    let result;
    try {
      result = await extractPatterns(source);
    } catch (err) {
      return res.status(502).json({ error: err.message, raw: err.raw || null });
    }

    const library = read('library').data;
    const existingDrafts = read('drafts').data;
    const taken = new Set([...library.map((p) => p.id), ...existingDrafts.map((p) => p.id)]);

    // Ids must be unique WITHIN the draft queue so the review screen can address
    // one row unambiguously. Library collisions are reported, not renamed - the
    // human decides whether it is a duplicate idea or just a duplicate word.
    const stamped = result.patterns.map((p) => {
      const id = taken.has(p.id) ? generateId(p.id, [...taken]) : (p.id || generateId(p.pattern, [...taken]));
      taken.add(id);
      return { ...p, id };
    });

    const saved = update('drafts', (list) => [...list, ...stamped], { force: true });
    res.json({
      ok: true,
      added: stamped.length,
      drafts: saved.data,
      draftsVersion: saved.version,
      problems: result.problems,
      collisions: idCollisions(result.patterns, library),
      duplicates: duplicateWarnings(stamped, [...library, ...existingDrafts]),
      warnings: stamped.map((p) => ({ id: p.id, warnings: identityWarnings(p) })).filter((w) => w.warnings.length),
      model: result.model,
      ms: result.ms,
    });
  }));

  router.put('/api/drafts/:id', asHandler((req, res) => {
    const record = req.body?.record;
    const drafts = read('drafts').data;
    if (!drafts.some((d) => d.id === req.params.id)) return res.status(404).json({ error: 'no such draft' });
    const saved = update('drafts', (list) => list.map((d) => (d.id === req.params.id ? record : d)), writeOpts(req));
    res.json({ ok: true, drafts: saved.data, draftsVersion: saved.version });
  }));

  router.post('/api/drafts/:id/approve', asHandler((req, res) => {
    const drafts = read('drafts').data;
    const draft = drafts.find((d) => d.id === req.params.id);
    if (!draft) return res.status(404).json({ error: 'no such draft' });

    const library = read('library').data;
    const record = { ...draft, ...(req.body?.record || {}) };
    record.id = generateId(record.id || record.pattern, library.map((p) => p.id));

    const problems = validateLibraryPattern(record, library);
    if (problems.length) return res.status(400).json({ error: 'draft is not a valid pattern yet', problems });

    const merged = update('library', (list) => [...list, record], { version: req.body?.libraryVersion ?? null, force: req.body?.force === true });
    const remaining = update('drafts', (list) => list.filter((d) => d.id !== req.params.id), { force: true });
    res.json({
      ok: true, merged: record, library: merged.data, libraryVersion: merged.version,
      backup: merged.backup, drafts: remaining.data, draftsVersion: remaining.version,
    });
  }));

  router.post('/api/drafts/:id/reject', asHandler((req, res) => {
    const drafts = read('drafts').data;
    const draft = drafts.find((d) => d.id === req.params.id);
    if (!draft) return res.status(404).json({ error: 'no such draft' });
    const reason = String(req.body?.reason || '').slice(0, 500);

    // Rejections are logged rather than dropped: "we already decided against
    // this shape" is worth knowing the next time the same source is processed.
    update('rejected', (list) => [
      ...(Array.isArray(list) ? list : []),
      { id: draft.id, rejectedAt: new Date().toISOString(), reason: reason || null, pattern: draft },
    ], { force: true, fallback: [] });

    const remaining = update('drafts', (list) => list.filter((d) => d.id !== req.params.id), { force: true });
    res.json({ ok: true, drafts: remaining.data, draftsVersion: remaining.version });
  }));

  /* ------------------------------------------------------------ preview */

  router.post('/api/preview', asHandler(async (req, res) => {
    const { kind, id, sample = {}, count = 3, region = null } = req.body || {};

    if (kind === 'seed') {
      const card = read('seeds').data.find((c) => c.id === id);
      if (!card) return res.status(404).json({ error: `no seed scenario with id ${id}` });
      return res.json({ kind: 'seed', year: yearFor(sample.age), ...previewSeed(card, sample) });
    }

    // A null pattern is allowed on purpose: it previews free generation, which
    // is what four cards in five actually are.
    let pattern = null;
    if (id) {
      pattern = read('library').data.find((p) => p.id === id) || null;
      if (!pattern) return res.status(404).json({ error: `no pattern with id ${id}` });
    }
    const result = await previewPattern(pattern, sample, { count, region });
    res.json({ kind: 'pattern', patternId: pattern ? pattern.id : null, year: yearFor(sample.age), ...result });
  }));

  /* ------------------------------------------------------- request log ---- */

  // Read-only: this only surfaces what server/llm.js already wrote. "summary"
  // and any other literal segment must be registered before the ":id" route
  // below, or express matches it as an id instead.
  router.get('/api/logs/summary', asHandler((_req, res) => res.json(getLogSummary())));

  router.get('/api/logs/:id', asHandler((req, res) => {
    const entry = getLogEntry(req.params.id);
    if (!entry) return res.status(404).json({ error: `no log entry with id ${req.params.id}` });
    res.json(entry);
  }));

  router.get('/api/logs', asHandler((req, res) => {
    const { page, pageSize, from, to, outcome, contentMode, hasLibrarySlot, search } = req.query;
    res.json(queryLogs({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
      from: from || null,
      to: to || null,
      outcome: outcome || null,
      contentMode: contentMode || null,
      hasLibrarySlot: hasLibrarySlot === 'yes' ? true : hasLibrarySlot === 'no' ? false : null,
      search: search || null,
    }));
  }));

  return router;
}

export default createAdminRouter;
