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
export const saveDraft = (id, record, version) =>
  json(`${base}/drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: { record, version } });
export const approveDraft = (id, record, libraryVersion, force = false) =>
  json(`${base}/drafts/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { record, libraryVersion, force } });
export const rejectDraft = (id, reason) =>
  json(`${base}/drafts/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason } });

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
