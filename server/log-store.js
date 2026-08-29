// Storage and retrieval for the LLM request/response log.
//
// One JSON object per line, appended to server/logs/llm-requests.jsonl - simple,
// greppable, matches the file-based approach the content admin already uses.
// This module owns three things: writing (fire-and-forget, never throws to the
// caller), rotation (by size or entry count, whichever comes first), and
// reading (paginated queries and summary stats, across the active file and any
// rotated .jsonl.gz files).
//
// This is a single-process, localhost-only admin tool at modest scale (a few
// thousand entries), so reads simply scan the files on every call rather than
// maintaining an index. That trade only stops being fine at a scale this
// project does not operate at.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOG_DIR = path.join(ROOT, 'server', 'logs');
const ACTIVE_FILE = path.join(LOG_DIR, 'llm-requests.jsonl');
const ROTATED_RE = /^llm-requests\.(\d+)\.jsonl\.gz$/;

const MAX_BYTES = Number(process.env.LIFESWIPE_LOG_MAX_BYTES) || 10 * 1024 * 1024;
const MAX_ENTRIES = Number(process.env.LIFESWIPE_LOG_MAX_ENTRIES) || 5000;
const MAX_ROTATED_FILES = 5;

const ensureDir = () => fs.mkdirSync(LOG_DIR, { recursive: true });

// In-memory counters for the active file, so a decision to rotate never has to
// re-read the whole file first. Seeded once from disk at startup.
let activeBytes = 0;
let activeEntries = 0;

function seedCounters() {
  ensureDir();
  if (!fs.existsSync(ACTIVE_FILE)) return;
  const text = fs.readFileSync(ACTIVE_FILE, 'utf8');
  activeBytes = Buffer.byteLength(text);
  activeEntries = text ? text.split('\n').filter(Boolean).length : 0;
}
seedCounters();

function rotatedFilesNewestFirst() {
  ensureDir();
  return fs.readdirSync(LOG_DIR)
    .filter((f) => ROTATED_RE.test(f))
    .sort((a, b) => Number(b.match(ROTATED_RE)[1]) - Number(a.match(ROTATED_RE)[1]));
}

function pruneOldRotations() {
  for (const f of rotatedFilesNewestFirst().slice(MAX_ROTATED_FILES)) {
    fs.unlinkSync(path.join(LOG_DIR, f));
  }
}

// Compress the active file, start a fresh one, and drop anything past the
// retention cap. Runs synchronously, but only ever from inside the fs.appendFile
// callback below - after the request that triggered the write has already
// gotten its response, so this never adds latency to gameplay.
function rotate() {
  if (!fs.existsSync(ACTIVE_FILE)) return;
  const raw = fs.readFileSync(ACTIVE_FILE);
  if (!raw.length) return;
  const rotatedPath = path.join(LOG_DIR, `llm-requests.${Date.now()}.jsonl.gz`);
  fs.writeFileSync(rotatedPath, zlib.gzipSync(raw));
  fs.writeFileSync(ACTIVE_FILE, '');
  activeBytes = 0;
  activeEntries = 0;
  pruneOldRotations();
}

const redact = (text) => {
  const key = process.env.ANTHROPIC_API_KEY;
  return key && text ? text.split(key).join('[REDACTED]') : text;
};

/**
 * Append one log entry. Fire-and-forget: the caller never awaits this, so a
 * slow disk (or a full one) never delays the response already sent to the
 * player. Failures are swallowed - a logging bug must never become a gameplay
 * bug.
 */
export function appendLog(entry) {
  try {
    ensureDir();
    const safe = {
      ...entry,
      rawResponse: redact(entry.rawResponse),
      apiError: redact(entry.apiError),
    };
    const line = JSON.stringify(safe) + '\n';
    fs.appendFile(ACTIVE_FILE, line, (err) => {
      if (err) { console.warn('[llm-log] append failed:', err.message); return; }
      activeBytes += Buffer.byteLength(line);
      activeEntries += 1;
      if (activeBytes >= MAX_BYTES || activeEntries >= MAX_ENTRIES) rotate();
    });
  } catch (err) {
    console.warn('[llm-log] append failed:', err.message);
  }
}

function readFileText(file) {
  if (!fs.existsSync(file)) return '';
  return file.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
    : fs.readFileSync(file, 'utf8');
}

// Yields every entry, most-recent-first. The active file's own lines are
// newest-first within it, and every rotated file predates the current active
// file entirely, so (active, then rotated newest-to-oldest) is already in
// overall order - callers still re-sort defensively before paginating.
function* iterEntries() {
  for (const file of [ACTIVE_FILE, ...rotatedFilesNewestFirst().map((f) => path.join(LOG_DIR, f))]) {
    const text = readFileText(file);
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch { /* a torn line from a crash mid-write - skip it */ }
    }
  }
}

// A bare "YYYY-MM-DD" `to` value should mean "through the end of that day".
const endOfDayIfBareDate = (value) =>
  (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) ? `${value}T23:59:59.999Z` : value;

function matchesFilters(e, { from, to, outcome, contentMode, keySource, hasLibrarySlot, search }) {
  if (from && e.timestamp < from) return false;
  if (to && e.timestamp > to) return false;
  if (outcome && e.validationResult !== outcome) return false;
  if (contentMode && e.contentMode !== contentMode) return false;
  // Entries written before keySource existed have no field at all, so an
  // explicit "server" filter must not match them - that absence is the whole
  // point of the field (see server/llm.js).
  if (keySource && e.keySource !== keySource) return false;
  if (hasLibrarySlot === true && !e.librarySlotUsed) return false;
  if (hasLibrarySlot === false && e.librarySlotUsed) return false;
  if (search) {
    const hay = `${e.assembledPrompt || ''}\n${e.rawResponse || ''}`.toLowerCase();
    if (!hay.includes(search.toLowerCase())) return false;
  }
  return true;
}

// The list view never needs the two big text blobs - keeps a page of results
// small even though the full record can run to several KB of prompt text.
const toListRow = ({ assembledPrompt, rawResponse, ...rest }) => rest;

/**
 * Paginated, filtered, most-recent-first. Spans rotated .jsonl.gz files
 * automatically whenever the requested date range reaches back past the
 * active file's oldest entry.
 */
export function queryLogs({
  from = null, to = null, outcome = null, contentMode = null, keySource = null,
  hasLibrarySlot = null, search = null, page = 1, pageSize = 50,
} = {}) {
  const filters = { from, to: endOfDayIfBareDate(to), outcome, contentMode, keySource, hasLibrarySlot, search };
  const matches = [];
  for (const entry of iterEntries()) {
    if (matchesFilters(entry, filters)) matches.push(entry);
  }
  matches.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const total = matches.length;
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const p = Math.max(1, Number(page) || 1);
  const start = (p - 1) * size;

  return { rows: matches.slice(start, start + size).map(toListRow), total, page: p, pageSize: size };
}

/**
 * FULL entries - prompt and response text included - most-recent-first, capped
 * at `limit`. The list view deliberately strips those two blobs (toListRow);
 * the content harvester needs them, because the response text IS the content
 * it mines and the prompt text is the only record of the state it was written
 * against.
 *
 * Same filters as queryLogs, minus pagination: a harvest run is a one-shot
 * scan over a bounded window, not a browsable list.
 */
export function queryEntries({
  from = null, to = null, outcome = null, contentMode = null, keySource = null,
  hasLibrarySlot = null, search = null, limit = 200,
} = {}) {
  const filters = { from, to: endOfDayIfBareDate(to), outcome, contentMode, keySource, hasLibrarySlot, search };
  const matches = [];
  for (const entry of iterEntries()) {
    if (matchesFilters(entry, filters)) matches.push(entry);
  }
  matches.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  const cap = Math.max(1, Math.min(2000, Number(limit) || 200));
  return { entries: matches.slice(0, cap), total: matches.length, limit: cap };
}

/** One full entry (including the prompt and response text), by id. */
export function getLogEntry(id) {
  for (const entry of iterEntries()) {
    if (entry.id === id) return entry;
  }
  return null;
}

const emptyBucket = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, failed: 0, fellBack: 0 });

function addTo(bucket, e) {
  bucket.calls += 1;
  if (e.tokenUsage) {
    bucket.inputTokens += e.tokenUsage.input || 0;
    bucket.outputTokens += e.tokenUsage.output || 0;
  }
  if (e.validationResult === 'failed') bucket.failed += 1;
  if (e.validationResult === 'fell_back_to_seed') bucket.fellBack += 1;
}

const finalizeBucket = ({ calls, inputTokens, outputTokens, failed, fellBack }) => ({
  calls,
  inputTokens,
  outputTokens,
  failureRate: calls ? failed / calls : 0,
  fallbackRate: calls ? fellBack / calls : 0,
});

/**
 * "is this actually calling the LLM and how many tokens is it using" - today
 * (UTC) and all-time, plus the two rates that matter for noticing a broken
 * prompt or a runaway retry loop.
 */
export function getLogSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const todayBucket = emptyBucket();
  const allTimeBucket = emptyBucket();
  for (const entry of iterEntries()) {
    addTo(allTimeBucket, entry);
    if ((entry.timestamp || '').slice(0, 10) === today) addTo(todayBucket, entry);
  }
  return { today: finalizeBucket(todayBucket), allTime: finalizeBucket(allTimeBucket) };
}
