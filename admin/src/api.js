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

// A generation run is many sequential LLM calls (minutes, for a large or
// forced batch), so this reads the response as NDJSON instead of one JSON
// blob at the end - each line is a `{type: 'bucket'|'batch'}` progress event,
// reported to `onEvent` as it arrives, until a `{type: 'done', ...}` line
// carries the same summary the old single-response version returned (or
// `{type: 'error'}` if the run failed partway through).
export async function generateSeeds(mode, target, force = false, onEvent = () => {}, signal = undefined) {
  let res;
  try {
    res = await fetch(`${base}/generate-seeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, target, force }),
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
    const err = new Error(data.error || `${base}/generate-seeds responded ${res.status}`);
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

  if (!done) throw new Error('the generation run ended without a result - check the server log');
  return done;
}

export const preview = (body) => json(`${base}/preview`, { method: 'POST', body });

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
