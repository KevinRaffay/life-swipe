// The only thing in the admin module allowed to touch the content files.
//
// These are the same files the game server reads at boot, so a half-written
// library is not a cosmetic problem - it is a server that will not start. Hence
// three rules, all enforced here rather than trusted to callers:
//
//   1. WRITE ATOMICALLY. Serialise to a temp file in the same directory, then
//      rename over the target. A rename within a filesystem is atomic, so an
//      interrupted save leaves the old file intact rather than a truncated one.
//   2. BACK UP FIRST. The previous contents are copied to <name>.bak before
//      every write. One level deep, which is all this pass promises.
//   3. NOTICE CONCURRENT EDITS. Every read hands out a version (a hash of the
//      bytes). A write must present one; if the file moved underneath, the
//      write is refused rather than silently winning. The caller can retry with
//      force, which is the documented last-write-wins escape hatch - the point
//      is that the warning arrives BEFORE the loss, not after.
//
// Paths are whitelisted by name. Nothing derived from a request ever reaches
// the filesystem, so there is no traversal to defend against.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// name -> { file, kind }. `kind` picks the canonical key order used on save.
export const FILES = {
  library: { file: path.join(ROOT, 'server', 'situation-library.json'), kind: 'pattern' },
  seeds: { file: path.join(ROOT, 'data', 'scenarios-seed.json'), kind: 'seed' },
  drafts: { file: path.join(ROOT, 'situation-library.draft.json'), kind: 'pattern' },
  rejected: { file: path.join(ROOT, 'situation-library.draft.rejected.json'), kind: 'rejection' },
  // Bulk-generated seed candidates (server/seed-generation.js). Same draft/
  // approve/reject shape as `drafts`/`library` above, targeting the seed deck
  // instead of the situation library.
  seedDrafts: { file: path.join(ROOT, 'scenarios-seed.draft.json'), kind: 'seed' },
  seedRejected: { file: path.join(ROOT, 'scenarios-seed.draft.rejected.json'), kind: 'rejection' },
  // The DEMO pool and its own draft/rejected pair. A third draft/target
  // triple through the same `draftRoutes` factory the other two use - a
  // separate content set with a separate register, deliberately not a mode
  // flag on the seed deck, so demo content can never reach a normal life by
  // being approved into the wrong file.
  demoSeeds: { file: path.join(ROOT, 'data', 'demo-seed-scenarios.json'), kind: 'seed' },
  demoDrafts: { file: path.join(ROOT, 'demo-seed-scenarios.draft.json'), kind: 'seed' },
  demoRejected: { file: path.join(ROOT, 'demo-seed-scenarios.draft.rejected.json'), kind: 'rejection' },
  // Not present in the repo yet. Everything here copes with that; the thread
  // editor is the one feature deliberately left for later.
  threads: { file: path.join(ROOT, 'server', 'thread-templates.json'), kind: 'thread' },
  namePool: { file: path.join(ROOT, 'server', 'name-pool.json'), kind: 'namePoolEntry' },
  nameControls: { file: path.join(ROOT, 'server', 'name-pool-controls.json'), kind: 'nameControls' },
};

// Canonical key order, so a save produces a readable diff instead of a
// wholesale reshuffle. Keys not listed keep their existing relative order and
// follow the listed ones.
const KEY_ORDER = {
  pattern: ['id', 'pattern', 'category', 'life_stage', 'modes', 'requires', 'excludes',
    'typical_effects', 'rarity', 'note', 'source'],
  // Identity, then where the card may be dealt, then the narrative in the same
  // order a player reads it (the tier order in shared/scenario-format.js), then
  // the choice and its consequences.
  //
  // The seed file did NOT have one order before this: some cards put `modes`
  // near the front, others near the back, so no key order round-trips it
  // byte-for-byte. `npm run normalise-content` rewrites it into this order once,
  // in its own commit, after which every admin save is a minimal diff.
  // `source` sits with the identity fields: it is authoring provenance
  // ('hand-authored' | 'extracted' | 'generated' | 'harvested', see
  // shared/provenance.js), not the runtime `source` shared/deck.js stamps on a
  // dealt card - the deck overwrites that one for every seed at load time, so
  // the two never collide.
  seed: ['id', 'source', 'stages', 'life_stage', 'minAge', 'maxAge', 'modes', 'weight', 'priority',
    'requiresFlags', 'forbidsFlags',
    'setting', 'beat', 'dialogue', 'prompt', 'leftLabel', 'rightLabel',
    'leftEffects', 'rightEffects', 'timeCostMonths'],
  // `pattern` for a rejected library draft, `scenario` for a rejected seed
  // draft - the rejector writes whichever key its content type uses.
  rejection: ['id', 'rejectedAt', 'reason', 'pattern', 'scenario'],
  thread: ['id', 'beats'],
  namePoolEntry: ['name', 'category', 'gender_assoc', 'active', 'era_start', 'era_end', 'region_frequency'],
  // The controls file is one object, not a list of records - `ordered()`
  // handles that shape too (see below).
  nameControls: ['deactivatedCategories', 'deactivatedRegions', 'deactivatedGenderAssocs'],
};

export class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
    this.details = details;
  }
}

const resolve = (name) => {
  const entry = FILES[name];
  if (!entry) throw new Error(`unknown content file: ${name}`);
  return entry;
};

export const versionOf = (text) =>
  crypto.createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);

/** Order one object's keys, recursing is deliberately NOT done - only the top
 *  level of each record is canonicalised, so nested effects keep their shape. */
function ordered(record, kind) {
  const order = KEY_ORDER[kind];
  if (!order || !record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out = {};
  for (const key of order) if (key in record) out[key] = record[key];
  for (const key of Object.keys(record)) if (!(key in out)) out[key] = record[key];
  return out;
}

export function serialise(data, kind) {
  const shaped = Array.isArray(data) ? data.map((r) => ordered(r, kind)) : ordered(data, kind);
  return JSON.stringify(shaped, null, 2) + '\n';
}

/**
 * Read one content file.
 * A missing file is not an error - it reads as `fallback` with version ''.
 * That is how thread-templates.json and an untouched draft queue behave.
 */
export function read(name, fallback = []) {
  const { file } = resolve(name);
  if (!fs.existsSync(file)) return { data: fallback, version: '', exists: false, file };
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const wrapped = new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
    wrapped.status = 500;
    throw wrapped;
  }
  return { data, version: versionOf(text), exists: true, file };
}

/**
 * Write one content file: check version, back up, write atomically.
 *
 * @param {string} name        key in FILES
 * @param {*} data             the value to serialise
 * @param {object} [opts]
 * @param {string} [opts.version]  the version the caller last read
 * @param {boolean} [opts.force]   overwrite despite a version mismatch
 * @returns {{ version: string, backup: string|null, forced: boolean }}
 */
export function write(name, data, { version = null, force = false } = {}) {
  const { file, kind } = resolve(name);
  const exists = fs.existsSync(file);
  const current = exists ? fs.readFileSync(file, 'utf8') : null;
  const currentVersion = exists ? versionOf(current) : '';

  if (!force && version !== null && version !== currentVersion) {
    throw new ConflictError(
      `${path.basename(file)} changed on disk since you loaded it. Your edit was NOT saved.`,
      { expected: version, actual: currentVersion },
    );
  }

  const text = serialise(data, kind);
  let backup = null;
  if (exists) {
    backup = file + '.bak';
    fs.copyFileSync(file, backup);
  }

  // Same directory, so the rename stays on one filesystem and is atomic.
  const tmp = file + '.tmp-' + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);

  return {
    version: versionOf(text),
    backup: backup ? path.basename(backup) : null,
    forced: Boolean(force && version !== null && version !== currentVersion),
  };
}

/** Read, mutate the parsed value, write it back under the same version check. */
export function update(name, mutate, { version = null, force = false, fallback = [] } = {}) {
  const { data, version: onDisk } = read(name, fallback);
  const next = mutate(data);
  const result = write(name, next, { version: version ?? onDisk, force });
  return { data: next, ...result };
}

export const exists = (name) => fs.existsSync(resolve(name).file);
export const fileOf = (name) => resolve(name).file;
