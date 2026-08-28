import React, { useMemo, useState } from 'react';

/** Sortable, searchable table. Columns are { key, label, render?, value? }. */
export default function Table({ columns, rows, onSelect, selectedId, empty = 'Nothing here yet.' }) {
  const [sort, setSort] = useState({ key: columns[0].key, dir: 1 });

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key) || columns[0];
    const value = (r) => (col.value ? col.value(r) : r[col.key]);
    return [...rows].sort((a, b) => {
      const av = value(a); const bv = value(b);
      const as = Array.isArray(av) ? av.join() : (av ?? '');
      const bs = Array.isArray(bv) ? bv.join() : (bv ?? '');
      return String(as).localeCompare(String(bs), undefined, { numeric: true }) * sort.dir;
    });
  }, [rows, sort, columns]);

  if (!rows.length) return <p className="muted">{empty}</p>;

  return (
    <table className="table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }))}
              className={sort.key === c.key ? 'is-sorted' : ''}
            >
              {c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr
            key={r.id}
            onClick={() => onSelect && onSelect(r)}
            className={selectedId === r.id ? 'is-selected' : ''}
          >
            {columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : String(r[c.key] ?? '')}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
