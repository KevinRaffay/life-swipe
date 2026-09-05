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
  validateNamePoolEntry, validateGroupControlEntry,
  PATTERN_CATEGORIES, PATTERN_RARITIES, MODES, NAME_GENDER_ASSOCS } from './content-schema.js';
import { crossReference } from './cross-reference.js';
import { previewPattern, previewSeed, yearFor } from './preview.js';
import { extractPatterns, identityWarnings, idCollisions, duplicateWarnings } from '../extraction.js';
import { generateSeedDrafts } from '../seed-generation.js';
import { generateDemoDrafts, remarkNearDuplicates, DEFAULT_TOTAL as DEMO_DEFAULT_TOTAL } from '../demo-seed-generation.js';
import { runHarvest, HARVEST_DEFAULTS } from '../harvest.js';
import { computeNamePoolHealth } from '../name-pool-health.js';
import { hasKey, MODEL, setProvider, providerStatus } from '../provider.js';
import { queryLogs, getLogEntry, getLogSummary } from '../log-store.js';
import { EXTRACTED, HAND_AUTHORED, SOURCES, tallySources, harvestedShare } from '../../shared/provenance.js';
import { US_REGIONS } from '../../shared/regions.js';

const EMPTY_NAME_CONTROLS = { deactivatedCategories: [], deactivatedRegions: [], deactivatedGenderAssocs: [] };

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
    const demoSeeds = read('demoSeeds');
    const demoDrafts = read('demoDrafts');
    const namePool = read('namePool');
    const nameControls = read('nameControls', EMPTY_NAME_CONTROLS);
    res.json({
      library: library.data,
      libraryVersion: library.version,
      seeds: seeds.data,
      seedsVersion: seeds.version,
      drafts: drafts.data,
      draftsVersion: drafts.version,
      seedDrafts: seedDrafts.data,
      seedDraftsVersion: seedDrafts.version,
      demoSeeds: demoSeeds.data,
      demoSeedsVersion: demoSeeds.version,
      demoDrafts: demoDrafts.data,
      demoDraftsVersion: demoDrafts.version,
      demoDefaultTotal: DEMO_DEFAULT_TOTAL,
      namePool: namePool.data,
      namePoolVersion: namePool.version,
      nameControls: nameControls.data,
      nameControlsVersion: nameControls.version,
      threadsPresent: exists('threads'),
      llmEnabled: hasKey(),
      model: hasKey() ? MODEL : null,
      provider: providerStatus(),
      vocab: {
        categories: PATTERN_CATEGORIES, rarities: PATTERN_RARITIES, modes: MODES, sources: SOURCES,
        nameGenderAssocs: NAME_GENDER_ASSOCS,
      },
      harvestDefaults: HARVEST_DEFAULTS,
      regions: US_REGIONS,
      files: {
        library: fileOf('library'), seeds: fileOf('seeds'), drafts: fileOf('drafts'), seedDrafts: fileOf('seedDrafts'),
        demoSeeds: fileOf('demoSeeds'), demoDrafts: fileOf('demoDrafts'),
        namePool: fileOf('namePool'), nameControls: fileOf('nameControls'),
      },
    });
  }));

  // Which backend is the storyteller right now, and what a switch could
  // target. The PUT is the admin header's toggle: server-wide and runtime-only
  // (LLM_PROVIDER stays the boot default; a restart reverts). setProvider
  // refuses a target that could not serve the next call - no key, or an Ollama
  // model that is not actually pulled - so a failed switch is a 4xx/5xx with
  // the reason, never a silent slide into seed fallback.
  router.get('/api/provider', asHandler((_req, res) => res.json(providerStatus())));
  router.put('/api/provider', asHandler(async (req, res) => {
    res.json(await setProvider(req.body?.provider));
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

  /* ----------------------------------------------------------- name pool */

  // Not libraryRoutes: a name-pool entry is addressed by `name`, not `id`,
  // and needs one extra bulk-write route for "select all matching the
  // current filter, then deactivate" - an ad-hoc grouping (an era range, a
  // search match) that does not warrant a persistent control of its own.
  router.get('/api/name-pool', asHandler((_req, res) => {
    const { data, version } = read('namePool');
    res.json({ data, version });
  }));

  router.post('/api/name-pool', asHandler((req, res) => {
    const record = { active: true, ...(req.body?.record || {}) };
    const current = read('namePool').data;
    const problems = validateNamePoolEntry(record, current);
    if (problems.length) return res.status(400).json({ error: 'invalid name-pool entry', problems });
    const result = update('namePool', (list) => [...list, record], writeOpts(req));
    res.json({ ok: true, data: result.data, version: result.version, backup: result.backup });
  }));

  router.put('/api/name-pool/:name', asHandler((req, res) => {
    const record = req.body?.record;
    const current = read('namePool').data;
    const index = current.findIndex((e) => e.name.toLowerCase() === req.params.name.toLowerCase());
    if (index === -1) return res.status(404).json({ error: `no name-pool entry "${req.params.name}"` });
    const problems = validateNamePoolEntry(record, current.filter((_, i) => i !== index));
    if (problems.length) return res.status(400).json({ error: 'invalid name-pool entry', problems });
    const result = update('namePool', (list) => list.map((e, i) => (i === index ? record : e)), writeOpts(req));
    res.json({ ok: true, data: result.data, version: result.version, backup: result.backup });
  }));

  router.delete('/api/name-pool/:name', asHandler((req, res) => {
    const current = read('namePool').data;
    const key = req.params.name.toLowerCase();
    if (!current.some((e) => e.name.toLowerCase() === key)) {
      return res.status(404).json({ error: `no name-pool entry "${req.params.name}"` });
    }
    const result = update('namePool', (list) => list.filter((e) => e.name.toLowerCase() !== key), writeOpts(req));
    res.json({ ok: true, data: result.data, version: result.version, backup: result.backup });
  }));

  router.post('/api/name-pool/bulk-active', asHandler((req, res) => {
    const names = Array.isArray(req.body?.names) ? req.body.names.map(String) : [];
    const active = req.body?.active === true;
    if (!names.length) return res.status(400).json({ error: 'no names given' });
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const current = read('namePool').data;
    const missing = names.filter((n) => !current.some((e) => e.name.toLowerCase() === n.toLowerCase()));
    if (missing.length) return res.status(404).json({ error: `unknown name(s): ${missing.join(', ')}` });
    const result = update(
      'namePool',
      (list) => list.map((e) => (wanted.has(e.name.toLowerCase()) ? { ...e, active } : e)),
      writeOpts(req),
    );
    res.json({ ok: true, data: result.data, version: result.version, backup: result.backup, changed: names.length });
  }));

  router.get('/api/name-pool-health', asHandler((_req, res) => {
    const pool = read('namePool').data;
    const controls = read('nameControls', EMPTY_NAME_CONTROLS).data;
    res.json(computeNamePoolHealth({ pool, controls }));
  }));

  /* --------------------------------------------------- name-pool controls */

  router.get('/api/name-pool-controls', asHandler((_req, res) => {
    const { data, version } = read('nameControls', EMPTY_NAME_CONTROLS);
    res.json({ data, version });
  }));

  // One route builder for all three group-level controls - category, region
  // and gender_assoc deactivation share one shape (a list of {value, reason,
  // deactivatedAt} in name-pool-controls.json), so it is written once and
  // parametrised rather than duplicated three times, the same relationship
  // libraryRoutes above has to library/seeds.
  const groupControlRoutes = (listKey, field, urlSegment, noun, countAffected) => {
    router.post(`/api/name-pool-controls/${urlSegment}`, asHandler((req, res) => {
      const value = req.body?.value;
      const reason = req.body?.reason;
      const controls = read('nameControls', EMPTY_NAME_CONTROLS).data;
      const siblings = (controls[listKey] || []).map((e) => e[field]);
      const problems = validateGroupControlEntry({ value, reason }, siblings, noun);
      if (problems.length) return res.status(400).json({ error: `invalid ${noun} deactivation`, problems });
      const pool = read('namePool').data;
      const affected = countAffected(pool, value);
      const entry = { [field]: value, reason: String(reason).trim(), deactivatedAt: new Date().toISOString() };
      const result = update(
        'nameControls',
        (data) => ({ ...EMPTY_NAME_CONTROLS, ...data, [listKey]: [...((data && data[listKey]) || []), entry] }),
        { ...writeOpts(req), fallback: EMPTY_NAME_CONTROLS },
      );
      res.json({ ok: true, data: result.data, version: result.version, backup: result.backup, affected });
    }));

    router.delete(`/api/name-pool-controls/${urlSegment}/:value`, asHandler((req, res) => {
      const controls = read('nameControls', EMPTY_NAME_CONTROLS).data;
      if (!(controls[listKey] || []).some((e) => e[field] === req.params.value)) {
        return res.status(404).json({ error: `"${req.params.value}" is not deactivated` });
      }
      const result = update(
        'nameControls',
        (data) => ({ ...EMPTY_NAME_CONTROLS, ...data, [listKey]: ((data && data[listKey]) || []).filter((e) => e[field] !== req.params.value) }),
        { ...writeOpts(req), fallback: EMPTY_NAME_CONTROLS },
      );
      res.json({ ok: true, data: result.data, version: result.version, backup: result.backup });
    }));

    // Bulk select on the admin's Name Pool tab needs one atomic write for the
    // whole selection, not a sequence of the single-value routes above: this
    // request carries the `version` the client last read exactly once, so N
    // selected rows cost one version check instead of N sequential ones (each
    // racing the last write's new version and needing its own conflict retry).
    // Same shape choice as /api/name-pool/bulk-active: one route, an `active`
    // boolean picks the direction, rather than two routes.
    router.post(`/api/name-pool-controls/${urlSegment}/bulk`, asHandler((req, res) => {
      const values = Array.isArray(req.body?.values) ? [...new Set(req.body.values.map(String))] : [];
      const active = req.body?.active === true;
      const reason = req.body?.reason;
      if (!values.length) return res.status(400).json({ error: `no ${noun}s given` });

      const controls = read('nameControls', EMPTY_NAME_CONTROLS).data;
      const siblings = (controls[listKey] || []).map((e) => e[field]);

      if (active) {
        const missing = values.filter((v) => !siblings.includes(v));
        if (missing.length) return res.status(404).json({ error: `not deactivated: ${missing.join(', ')}` });
        const result = update(
          'nameControls',
          (data) => ({ ...EMPTY_NAME_CONTROLS, ...data, [listKey]: ((data && data[listKey]) || []).filter((e) => !values.includes(e[field])) }),
          { ...writeOpts(req), fallback: EMPTY_NAME_CONTROLS },
        );
        return res.json({ ok: true, data: result.data, version: result.version, backup: result.backup, changed: values.length });
      }

      // Reused per-value: reason-required and not-already-deactivated are the
      // same rules the single-add route enforces, just run once per selected
      // value here so a bulk request cannot smuggle in a bad one.
      const problems = [...new Set(values.flatMap((value) => validateGroupControlEntry({ value, reason }, siblings, noun)))];
      if (problems.length) return res.status(400).json({ error: `invalid ${noun} bulk deactivation`, problems });
      const timestamp = new Date().toISOString();
      const entries = values.map((value) => ({ [field]: value, reason: String(reason).trim(), deactivatedAt: timestamp }));
      const result = update(
        'nameControls',
        (data) => ({ ...EMPTY_NAME_CONTROLS, ...data, [listKey]: [...((data && data[listKey]) || []), ...entries] }),
        { ...writeOpts(req), fallback: EMPTY_NAME_CONTROLS },
      );
      res.json({ ok: true, data: result.data, version: result.version, backup: result.backup, changed: values.length });
    }));
  };

  groupControlRoutes('deactivatedCategories', 'category', 'categories', 'category',
    (pool, value) => pool.filter((e) => e.category === value).length);
  groupControlRoutes('deactivatedRegions', 'region', 'regions', 'region',
    (pool, value) => pool.filter((e) => e.region_frequency && Number.isFinite(e.region_frequency[value])).length);
  groupControlRoutes('deactivatedGenderAssocs', 'genderAssoc', 'gender-assocs', 'gender_assoc',
    (pool, value) => pool.filter((e) => e.gender_assoc === value).length);

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

  // The DEMO pool's draft queue - the third draft/target pair through the
  // same factory, parametrised exactly like the other two rather than
  // duplicated. Its target is data/demo-seed-scenarios.json, never
  // data/scenarios-seed.json: the two pools stay separate all the way
  // through approval, which is the whole reason the demo has its own file.
  // The validator is the same `validateSeedScenario` (a demo card is a real
  // scenario and has to pass the real structural check), and the same
  // `validationWarnings` strip applies - those are review metadata, not
  // schema.
  draftRoutes({
    draftKey: 'demoDrafts', targetKey: 'demoSeeds', rejectedKey: 'demoRejected', label: 'scenario',
    validate: (record, siblings) => validateSeedScenario(record, siblings).problems,
    idBase: (record) => record.prompt,
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

  /* -------------------------------------------------------- demo pool */

  // Bulk-generate DEMO pool candidates and append them to the demo draft
  // queue. Same shape as /api/generate-seeds above - NDJSON progress lines,
  // a `done` line carrying the payload, cancel via the response's 'close'
  // event - because a thousand-card run is an hour or two of sequential
  // model calls and a silent request would read as a hung button long before
  // it finished.
  //
  // Appends only. data/demo-seed-scenarios.json is reached solely through
  // the demoDrafts approve route above, by a person.
  router.post('/api/generate-demo-seeds', async (req, res) => {
    if (!hasKey()) return res.status(503).json({ error: 'no LLM provider is configured' });
    const totalNum = Number(req.body?.total);
    const total = Number.isFinite(totalNum) && totalNum > 0 ? Math.min(totalNum, 5000) : DEMO_DEFAULT_TOTAL;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + '\n'); };

    let stopped = false;
    res.on('close', () => { stopped = true; });

    try {
      const existingDrafts = read('demoDrafts').data;
      const livePool = read('demoSeeds').data;
      // De-duplicate against BOTH the queue and what is already approved, so
      // a second run does not re-propose cards a reviewer has already taken.
      const known = [...existingDrafts, ...livePool];

      const results = await generateDemoDrafts({
        total,
        existingIds: new Set(known.map((d) => d.id)),
        existingPrompts: known.map((d) => d.prompt).filter(Boolean),
        onStage: (info) => send({ type: 'stage', ...info }),
        onBatch: (info) => send({ type: 'batch', ...info }),
        shouldStop: () => stopped,
      });

      const generated = results.flatMap((r) => r.accepted);
      // Re-run the near-duplicate pass over the MERGED queue, not just this
      // run's output: a top-up run's cards are otherwise never checked against
      // what is already queued, and same-situation-different-words is exactly
      // the repeat the lexical de-duplication cannot see. See
      // remarkNearDuplicates - no model call, no content change.
      const saved = update('demoDrafts', (list) => {
        const merged = [...list, ...generated];
        remarkNearDuplicates(merged);
        return merged;
      }, { force: true });

      send({
        type: 'done',
        ok: true,
        added: generated.length,
        demoDrafts: saved.data,
        demoDraftsVersion: saved.version,
        stages: results.map((r) => ({
          stage: r.stage, target: r.target, accepted: r.accepted.length, stats: r.stats,
        })),
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
