import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../api.js';

const PAGE_SIZE = 50;

const OUTCOME_LABEL = { passed: 'passed', failed: 'failed', fell_back_to_seed: 'fell back' };

// Whose key paid for the call. Only 'server' calls may be harvested, and a
// call logged before the field existed has none at all - which is a real
// answer worth showing, not a gap to paper over with a dash.
const KEY_SOURCE_LABEL = { server: 'server', byok: 'player key' };
const keySourceOf = (r) => KEY_SOURCE_LABEL[r.keySource] || 'not recorded';

const fmtTokens = (n) => (n == null ? '—' : n.toLocaleString('en-US'));
const fmtPct = (n) => `${Math.round((n || 0) * 100)}%`;

/**
 * Read-only viewer over server/logs/llm-requests.jsonl (written by
 * server/llm.js). Answers one question above all others: is this actually
 * calling the model, and what is it costing.
 */
export default function Logs() {
  const [summary, setSummary] = useState(null);
  const [filters, setFilters] = useState({
    from: '', to: '', outcome: '', contentMode: '', keySource: '', hasLibrarySlot: '', search: '',
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], total: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await api.getLogs({ ...filters, page, pageSize: PAGE_SIZE }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [filters, page]);

  useEffect(() => { load(); }, [load]);
  // Refreshed whenever the list reloads, so the header stays current without
  // a separate poll.
  useEffect(() => { api.getLogSummary().then(setSummary).catch(() => {}); }, [data]);

  const setFilter = (k, v) => { setPage(1); setFilters((f) => ({ ...f, [k]: v })); };

  const selectRow = async (row) => {
    setSelectedId(row.id);
    setDetail(null);
    try {
      setDetail(await api.getLogEntry(row.id));
    } catch (err) {
      setDetail({ error: err.message });
    }
  };

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="pane">
      <section className="card">
        <h2>LLM request log</h2>
        {summary ? (
          <div className="tiles">
            <div className="tile"><b>{summary.today.calls}</b><span>calls today</span></div>
            <div className="tile"><b>{summary.allTime.calls}</b><span>calls all-time</span></div>
            <div className="tile"><b>{fmtTokens(summary.today.inputTokens + summary.today.outputTokens)}</b><span>tokens today</span></div>
            <div className="tile"><b>{fmtTokens(summary.allTime.inputTokens + summary.allTime.outputTokens)}</b><span>tokens all-time</span></div>
            <div className={`tile ${summary.allTime.failureRate > 0.2 ? 'tile--warn' : ''}`}>
              <b>{fmtPct(summary.allTime.failureRate)}</b><span>validation failure rate</span>
            </div>
            <div className={`tile ${summary.allTime.fallbackRate > 0.1 ? 'tile--warn' : ''}`}>
              <b>{fmtPct(summary.allTime.fallbackRate)}</b><span>fallback rate</span>
            </div>
          </div>
        ) : <p className="muted">Loading…</p>}
      </section>

      <section className="card">
        <div className="toolbar">
          <input
            className="search"
            placeholder="search prompt or response..."
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
          />
          <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} title="from date" />
          <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} title="to date" />
          <select value={filters.outcome} onChange={(e) => setFilter('outcome', e.target.value)}>
            <option value="">all outcomes</option>
            <option value="passed">passed</option>
            <option value="failed">failed</option>
            <option value="fell_back_to_seed">fell back to seed</option>
          </select>
          <select value={filters.contentMode} onChange={(e) => setFilter('contentMode', e.target.value)}>
            <option value="">all modes</option>
            <option value="safe">safe</option>
            <option value="mature">mature</option>
          </select>
          <select value={filters.keySource} onChange={(e) => setFilter('keySource', e.target.value)} title="which API key paid for the call">
            <option value="">any key source</option>
            <option value="server">server key</option>
            <option value="byok">player key</option>
          </select>
          <select value={filters.hasLibrarySlot} onChange={(e) => setFilter('hasLibrarySlot', e.target.value)}>
            <option value="">library slot: any</option>
            <option value="yes">library slot: yes</option>
            <option value="no">library slot: no</option>
          </select>
          <span className="spacer" />
          <span className="muted small">{data.total} matching</span>
        </div>

        {error && <p className="error">{error}</p>}

        {data.rows.length === 0 ? (
          <p className="muted">{busy ? 'Loading…' : 'No calls logged yet.'}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>time</th><th>outcome</th><th>age</th><th>mode</th><th>key</th>
                <th>library slot</th><th>tokens (in/out)</th><th>latency</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} onClick={() => selectRow(r)} className={selectedId === r.id ? 'is-selected' : ''}>
                  <td>{new Date(r.timestamp).toLocaleString()}</td>
                  <td>
                    <span className={`pill pill--${r.validationResult || 'unknown'}`}>
                      {OUTCOME_LABEL[r.validationResult] || r.validationResult || 'unknown'}
                    </span>
                    {r.validationWarnings && r.validationWarnings.length > 0 && (
                      <span className="pill pill--craft" title="craft warnings — logged, not rejected">
                        {r.validationWarnings.length} ⚠
                      </span>
                    )}
                  </td>
                  <td>{r.age ?? '—'}</td>
                  <td>{r.contentMode || '—'}</td>
                  <td className={r.keySource ? '' : 'muted'}>{keySourceOf(r)}</td>
                  <td>{r.librarySlotUsed || '—'}</td>
                  <td>{r.tokenUsage ? `${fmtTokens(r.tokenUsage.input)} / ${fmtTokens(r.tokenUsage.output)}` : '—'}</td>
                  <td>{r.latencyMs != null ? `${r.latencyMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="actions">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← prev</button>
          <span className="muted small">page {page} of {totalPages}</span>
          <button className="btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>next →</button>
        </div>
      </section>

      {selectedId && (
        <section className="card">
          <h2>Call detail</h2>
          {!detail ? <p className="muted">Loading…</p> : detail.error ? <p className="error">{detail.error}</p> : (
            <>
              <div className="row">
                <span className={`pill pill--${detail.validationResult || 'unknown'}`}>
                  {OUTCOME_LABEL[detail.validationResult] || detail.validationResult || 'unknown'}
                </span>
                <span className="pill">key: {keySourceOf(detail)}</span>
                {detail.librarySlotUsed && <span className="pill">slot: {detail.librarySlotUsed}</span>}
                <span className="muted small">
                  {detail.latencyMs} ms · {detail.tokenUsage
                    ? `${fmtTokens(detail.tokenUsage.input)} in / ${fmtTokens(detail.tokenUsage.output)} out`
                    : 'no usage reported'}
                </span>
              </div>
              {detail.apiError && <p className="error">API error: {detail.apiError}</p>}
              {detail.validationErrors && detail.validationErrors.length > 0 && (
                <ul className="problems">{detail.validationErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              )}
              {detail.validationWarnings && detail.validationWarnings.length > 0 && (
                <>
                  <p className="muted small">craft warnings — logged, not rejected:</p>
                  <ul className="craft-warnings">{detail.validationWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </>
              )}
              <details open>
                <summary>assembled prompt</summary>
                <pre className="raw">{detail.assembledPrompt}</pre>
              </details>
              <details open>
                <summary>raw response</summary>
                <pre className="raw">{detail.rawResponse || '(no response)'}</pre>
              </details>
            </>
          )}
        </section>
      )}
    </div>
  );
}
