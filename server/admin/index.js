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
import { generateSeedDrafts } from '../seed-generation.js';
import { runHarvest, HARVEST_DEFAULTS } from '../harvest.js';
import { hasKey, MODEL } from '../anthropic.js';
import { queryLogs, getLogEntry, getLogSummary } from '../log-store.js';
import { EXTRACTED, HAND_AUTHORED, SOURCES, tallySources, harvestedShare } from '../../shared/provenance.js';
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
    const seedDrafts = read('seedDrafts');
    res.json({
      library: library.data,
      libraryVersion: library.version,
      seeds: seeds.data,
      seedsVersion: seeds.version,
      drafts: drafts.data,
      draftsVersion: drafts.version,
      seedDrafts: seedDrafts.data,
      seedDraftsVersion: seedDrafts.version,
      threadsPresent: exists('threads'),
      llmEnabled: hasKey(),
      model: hasKey() ? MODEL : null,
      vocab: { categories: PATTERN_CATEGORIES, rarities: PATTERN_RARITIES, modes: MODES, sources: SOURCES },
      harvestDefaults: HARVEST_DEFAULTS,
      regions: US_REGIONS,
      files: {
        library: fileOf('library'), seeds: fileOf('seeds'), drafts: fileOf('drafts'), seedDrafts: fileOf('seedDrafts'),
      },
    });
  }));

  router.get('/api/validate', asHandler((_req, res) => res.json(crossReference())));

  router.get('/api/stats', asHandler((_req, res) => {
    const library = read('library').data;
    const seeds = read('seeds').data;
    const drafts = read('drafts').data;
    const seedDrafts = read('seedDrafts').data;
    const tally = (items, key) => items.reduce((acc, item) => {
      const value = item[key];
      for (const v of Array.isArray(value) ? value : [value]) {
        acc[v ?? 'unset'] = (acc[v ?? 'unset'] || 0) + 1;
      }
      return acc;
    }, {});
    const { stats } = crossReference();
    res.json({
      // Where the content came from, and how much of it the game wrote for
      // itself. NOT a limit - nothing enforces this number. It is a
      // content-diversity signal: a deck that becomes mostly harvested-from-
      // itself narrows toward the model's own most common outputs, and the
      // only way to notice that happening is to watch the number move.
      provenance: {
        patterns: tallySources(library),
        seeds: tallySources(seeds),
        drafts: tallySources(drafts),
        seedDrafts: tallySources(seedDrafts),
        harvestedShare: {
          patterns: harvestedShare(library),
          seeds: harvestedShare(seeds),
          combined: harvestedShare([...library, ...seeds]),
        },
      },
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
      seedDrafts: seedDrafts.length,
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
      // Created through the admin form, so a person typed it. Only on POST:
      // editing a harvested or extracted record must not relabel where it came
      // from, and an explicit source in the body always wins.
      const record = { source: HAND_AUTHORED, ...(req.body?.record || {}) };
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
      return { ...p, id, source: EXTRACTED };
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

  // One shape, two content types: a pattern draft (from extraction) approves
  // into the library; a seed draft (from bulk generation) approves into the
  // seed deck. Edit-inline, approve-and-merge, and reject are identical
  // control flow either way, so it is written once and parametrised rather
  // than duplicated - same relationship the admin UI's DraftQueue component
  // has to Extraction.jsx and SeedGeneration.jsx.
  const draftRoutes = ({ draftKey, targetKey, rejectedKey, label, validate, idBase, sanitize = (r) => r }) => {
    router.put(`/api/${draftKey}/:id`, asHandler((req, res) => {
      const record = req.body?.record;
      const drafts = read(draftKey).data;
      if (!drafts.some((d) => d.id === req.params.id)) return res.status(404).json({ error: `no such ${label} draft` });
      const saved = update(draftKey, (list) => list.map((d) => (d.id === req.params.id ? record : d)), writeOpts(req));
      res.json({ ok: true, [draftKey]: saved.data, [`${draftKey}Version`]: saved.version });
    }));

    router.post(`/api/${draftKey}/:id/approve`, asHandler((req, res) => {
      const drafts = read(draftKey).data;
      const draft = drafts.find((d) => d.id === req.params.id);
      if (!draft) return res.status(404).json({ error: `no such ${label} draft` });

      const target = read(targetKey).data;
      const record = sanitize({ ...draft, ...(req.body?.record || {}) });
      record.id = generateId(record.id || idBase(record), target.map((r) => r.id));

      const problems = validate(record, target);
      if (problems.length) return res.status(400).json({ error: `draft is not a valid ${label} yet`, problems });

      const merged = update(targetKey, (list) => [...list, record], { version: req.body?.targetVersion ?? null, force: req.body?.force === true });
      const remaining = update(draftKey, (list) => list.filter((d) => d.id !== req.params.id), { force: true });
      res.json({
        ok: true,
        merged: record,
        [targetKey]: merged.data,
        [`${targetKey}Version`]: merged.version,
        backup: merged.backup,
        [draftKey]: remaining.data,
        [`${draftKey}Version`]: remaining.version,
      });
    }));

    router.post(`/api/${draftKey}/:id/reject`, asHandler((req, res) => {
      const drafts = read(draftKey).data;
      const draft = drafts.find((d) => d.id === req.params.id);
      if (!draft) return res.status(404).json({ error: `no such ${label} draft` });
      const reason = String(req.body?.reason || '').slice(0, 500);

      // Rejections are logged rather than dropped: "we already decided against
      // this shape" is worth knowing the next time the same source is processed.
      update(rejectedKey, (list) => [
        ...(Array.isArray(list) ? list : []),
        { id: draft.id, rejectedAt: new Date().toISOString(), reason: reason || null, [label]: draft },
      ], { force: true, fallback: [] });

      const remaining = update(draftKey, (list) => list.filter((d) => d.id !== req.params.id), { force: true });
      res.json({ ok: true, [draftKey]: remaining.data, [`${draftKey}Version`]: remaining.version });
    }));
  };

  draftRoutes({
    draftKey: 'drafts', targetKey: 'library', rejectedKey: 'rejected', label: 'pattern',
    validate: (record, siblings) => validateLibraryPattern(record, siblings),
    idBase: (record) => record.pattern,
  });

  draftRoutes({
    draftKey: 'seedDrafts', targetKey: 'seeds', rejectedKey: 'seedRejected', label: 'scenario',
    validate: (record, siblings) => validateSeedScenario(record, siblings).problems,
    idBase: (record) => record.prompt,
    // validationWarnings is draft-review metadata (server/seed-generation.js
    // attaches it so a reviewer can see major-tier craft drift before
    // approving) - it is not part of the seed schema and must not ship into
    // data/scenarios-seed.json just because a draft happened to carry it.
    // harvestedFrom is the same kind of thing: which log entry a candidate came
    // out of is worth reading during review and worthless afterwards, since the
    // log rotates and that id stops resolving. `source` is NOT stripped - the
    // whole point of provenance is that it survives approval.
    sanitize: ({ validationWarnings, harvestedFrom, ...rest }) => rest,
  });

  // Bulk-generate seed candidates for coverage-thin buckets and append them to
  // the seed draft queue - the same generation core as
  // scripts/generate-seed-scenarios.js, called directly from the admin UI's
  // "Generate seeds" tab so a batch run doesn't require the command line.
  // Appends only; entering the seed deck is still the separate approve step.
  //
  // A run against several bucket/mode pairs is many sequential LLM calls and
  // can run for minutes - a plain request/response would sit there with no
  // sign of life, which is exactly what read as "stuck" before this existed.
  // So the response streams one NDJSON line per bucket/batch as it happens,
  // ending in a `done` line carrying the same payload the old JSON response
  // used. Not asHandler-wrapped: once a line has been written the client is
  // mid-stream, and asHandler's error path (a fresh res.status().json()) can
  // no longer run - errors after that point are written as an `error` line
  // and the stream is closed instead.
  router.post('/api/generate-seeds', async (req, res) => {
    if (!hasKey()) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set' });
    const mode = ['safe', 'mature', 'both'].includes(req.body?.mode) ? req.body.mode : 'both';
    const targetNum = Number(req.body?.target);
    const target = Number.isFinite(targetNum) && targetNum > 0 ? targetNum : null;
    const force = req.body?.force === true;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // harmless outside nginx, stops it buffering the stream if ever fronted by one
    res.flushHeaders();
    const send = (event) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + '\n'); };

    // A run can be many minutes of sequential LLM calls; if the browser tab
    // cancels the fetch (the UI's own Cancel button, a reload, a closed tab),
    // 'close' fires on this response. Nothing stops an in-flight LLM call
    // (anthropic.js owns that timeout), but shouldStop() is checked between
    // batches and between buckets, so a cancel actually stops spending API
    // calls within one call's timeout instead of running the whole plan out.
    let stopped = false;
    res.on('close', () => { stopped = true; });

    try {
      const seeds = read('seeds').data;
      const library = read('library').data;
      const existingDrafts = read('seedDrafts').data;

      const results = await generateSeedDrafts({
        seeds, library, mode, target, force,
        existingIds: new Set(existingDrafts.map((d) => d.id)),
        onBucket: (info) => send({ type: 'bucket', ...info }),
        onBatch: (info) => send({ type: 'batch', ...info }),
        shouldStop: () => stopped,
      });
      const generated = results.flatMap((r) => r.accepted);
      const saved = update('seedDrafts', (list) => [...list, ...generated], { force: true });

      send({
        type: 'done',
        ok: true,
        added: generated.length,
        seedDrafts: saved.data,
        seedDraftsVersion: saved.version,
        buckets: results.map((r) => ({ bucket: r.bucket, mode: r.mode, target: r.target, accepted: r.accepted.length, batches: r.batches })),
      });
    } catch (err) {
      if (err.status >= 500) console.error('[admin]', err);
      send({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  /* ------------------------------------------------------------ harvest */

  // Mine the LLM request log for content worth keeping and append it to the
  // two draft queues. ON DEMAND ONLY: there is no scheduler behind this and
  // there should not be one - harvesting decides what the game's permanent
  // content becomes, so a person starts every run and reads every result.
  //
  // Same never-merge rule as extraction and seed generation, and the same
  // streaming shape as /api/generate-seeds: the library path is a single
  // extraction call that can run for minutes, so progress goes out as NDJSON
  // rather than leaving the button looking hung. Not asHandler-wrapped for
  // the same reason that route is not - once a line is written, a fresh
  // res.status().json() can no longer run.
  router.post('/api/harvest', async (req, res) => {
    const body = req.body || {};
    const wantSeeds = body.seeds !== false;
    const wantPatterns = body.patterns !== false;

    if (!wantSeeds && !wantPatterns) {
      return res.status(400).json({ error: 'nothing to harvest - pick at least one destination' });
    }
    // Only the library path calls a model; seed harvesting is pure text
    // transformation over what the log already holds, so it works with no key.
    if (wantPatterns && !hasKey()) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set, so library-pattern harvesting is unavailable' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + '\n'); };

    try {
      const seeds = read('seeds').data;
      const library = read('library').data;
      const seedDrafts = read('seedDrafts').data;
      const drafts = read('drafts').data;

      const limitNum = Number(body.limit);
      const craftNum = Number(body.maxCraftWarnings);

      const result = await runHarvest({
        from: body.from || null,
        to: body.to || null,
        limit: Number.isFinite(limitNum) && limitNum > 0 ? limitNum : HARVEST_DEFAULTS.limit,
        maxCraftWarnings: Number.isFinite(craftNum) && craftNum >= 0 ? craftNum : HARVEST_DEFAULTS.maxCraftWarnings,
        seeds, library, seedDrafts, drafts,
        wantSeeds, wantPatterns,
        // The event's own `type` becomes `stage`: `type` is the NDJSON
        // envelope's word for done/error/progress, and letting a progress
        // event overwrite it would make the last line of a run look like
        // an unknown event to the reader in admin/src/api.js.
        onProgress: ({ type: stage, ...rest }) => send({ type: 'progress', stage, ...rest }),
      });

      // Append only, both queues, exactly like /api/extract and
      // /api/generate-seeds. Nothing here can reach data/scenarios-seed.json
      // or server/situation-library.json.
      const savedSeedDrafts = result.seeds.records.length
        ? update('seedDrafts', (list) => [...list, ...result.seeds.records], { force: true })
        : { data: seedDrafts, version: read('seedDrafts').version };
      const savedDrafts = result.patterns.patterns.length
        ? update('drafts', (list) => [...list, ...result.patterns.patterns], { force: true })
        : { data: drafts, version: read('drafts').version };

      send({
        type: 'done',
        ok: true,
        scanned: result.scanned,
        matching: result.matching,
        stats: result.stats,
        rejections: result.rejections,
        seedsAdded: result.seeds.records.length,
        seedDuplicates: result.seeds.duplicates,
        patternsAdded: result.patterns.patterns.length,
        patternProblems: result.patterns.problems,
        patternCollisions: result.patterns.collisions,
        patternDuplicates: result.patterns.duplicates,
        patternWarnings: result.patterns.warnings,
        patternsSkipped: result.patterns.skipped,
        majorsUsed: result.patterns.majorsUsed,
        model: result.patterns.model,
        ms: result.patterns.ms,
        seedDrafts: savedSeedDrafts.data,
        seedDraftsVersion: savedSeedDrafts.version,
        drafts: savedDrafts.data,
        draftsVersion: savedDrafts.version,
      });
    } catch (err) {
      if (err.status >= 500 || !err.status) console.error('[admin]', err);
      send({ type: 'error', message: err.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

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
    const { page, pageSize, from, to, outcome, contentMode, keySource, hasLibrarySlot, search } = req.query;
    res.json(queryLogs({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
      from: from || null,
      to: to || null,
      outcome: outcome || null,
      contentMode: contentMode || null,
      keySource: keySource || null,
      hasLibrarySlot: hasLibrarySlot === 'yes' ? true : hasLibrarySlot === 'no' ? false : null,
      search: search || null,
    }));
  }));

  return router;
}

export default createAdminRouter;
