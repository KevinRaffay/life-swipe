// Thin wrapper over the admin API. Every call goes to /admin/api/*, which only
// exists when the server is bound to loopback.

const json = async (url, options = {}) => {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${url} responded ${res.status}`);
    err.status = res.status;
    err.problems = data.problems || null;
    err.details = data.details || null;
    throw err;
  }
  return data;
};

const base = '/admin/api';

export const getBootstrap = () => json(`${base}/bootstrap`);
export const getValidation = () => json(`${base}/validate`);
export const getStats = () => json(`${base}/stats`);

export const createRecord = (kind, record, version, force = false) =>
  json(`${base}/${kind}`, { method: 'POST', body: { record, version, force } });
export const updateRecord = (kind, id, record, version, force = false) =>
  json(`${base}/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', body: { record, version, force } });
export const deleteRecord = (kind, id, version, force = false) =>
  json(`${base}/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE', body: { version, force } });

export const extract = (text) => json(`${base}/extract`, { method: 'POST', body: { text } });

// `kind` is the draft queue: 'drafts' for extracted library patterns,
// 'seedDrafts' for bulk-generated seed scenarios. Same three actions either
// way - edit inline (save = approve with the edited record), approve as-is,
// or reject - so one set of calls serves both admin/index.js's draftRoutes.
export const saveDraft = (kind, id, record, version) =>
  json(`${base}/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', body: { record, version } });
export const approveDraft = (kind, id, record, targetVersion, force = false) =>
  json(`${base}/${kind}/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { record, targetVersion, force } });
export const rejectDraft = (kind, id, reason) =>
  json(`${base}/${kind}/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason } });

// Some runs are many sequential LLM calls (minutes, for a large seed batch or
// a wide harvest), so those endpoints answer in NDJSON instead of one JSON
// blob at the end: each line is a progress event, reported to `onEvent` as it
// arrives, until a `{type: 'done', ...}` line carries the summary a plain JSON
// response would have returned - or `{type: 'error'}` if the run failed
// partway through, which cannot be an HTTP status because the headers went out
// with the first progress line.
//
// Written once and shared: /generate-seeds and /harvest differ only in their
// URL and their payload.
async function ndjson(path, body, onEvent = () => {}, signal = undefined) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const cancelled = new Error('Cancelled.');
      cancelled.aborted = true;
      throw cancelled;
    }
    throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `${base}${path} responded ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;

  const handleLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'done') done = event;
    else if (event.type === 'error') throw new Error(event.message);
    else onEvent(event);
  };

  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      const cancelled = new Error('Cancelled.');
      cancelled.aborted = true;
      throw cancelled;
    }
    throw err;
  }
  handleLine(buffer);

  if (!done) throw new Error(`the run at ${path} ended without a result - check the server log`);
  return done;
}

export const generateSeeds = (mode, target, force = false, onEvent = () => {}, signal = undefined) =>
  ndjson('/generate-seeds', { mode, target, force }, onEvent, signal);

// One on-demand harvest over a slice of the LLM request log. `seeds` and
// `patterns` pick which draft queues the run feeds; the library path is the
// only half that calls a model, so a seeds-only run works with no API key.
export const harvest = (options, onEvent = () => {}, signal = undefined) =>
  ndjson('/harvest', options, onEvent, signal);

export const preview = (body) => json(`${base}/preview`, { method: 'POST', body });

/* ------------------------------------------------------------- name pool */

export const createNamePoolEntry = (record, version, force = false) =>
  json(`${base}/name-pool`, { method: 'POST', body: { record, version, force } });
export const updateNamePoolEntry = (name, record, version, force = false) =>
  json(`${base}/name-pool/${encodeURIComponent(name)}`, { method: 'PUT', body: { record, version, force } });
export const deleteNamePoolEntry = (name, version, force = false) =>
  json(`${base}/name-pool/${encodeURIComponent(name)}`, { method: 'DELETE', body: { version, force } });
export const bulkSetNameActive = (names, active, version, force = false) =>
  json(`${base}/name-pool/bulk-active`, { method: 'POST', body: { names, active, version, force } });
export const getNamePoolHealth = () => json(`${base}/name-pool-health`);

// The three group-level controls (category / region / gender_assoc) share one
// shape: add with a required reason, remove by value to reactivate.
export const addGroupControl = (kind, value, reason, version, force = false) =>
  json(`${base}/name-pool-controls/${kind}`, { method: 'POST', body: { value, reason, version, force } });
export const removeGroupControl = (kind, value, version, force = false) =>
  json(`${base}/name-pool-controls/${kind}/${encodeURIComponent(value)}`, { method: 'DELETE', body: { version, force } });

const qs = (params) => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined && v !== '') usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
};

export const getLogs = (params) => json(`${base}/logs${qs(params)}`);
export const getLogSummary = () => json(`${base}/logs/summary`);
export const getLogEntry = (id) => json(`${base}/logs/${encodeURIComponent(id)}`);
