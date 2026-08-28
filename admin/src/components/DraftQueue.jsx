import React, { useState } from 'react';
import Modal from './Modal.jsx';

/**
 * One draft-review queue, shared by pattern extraction and seed generation:
 * approve as-is, edit then approve, or reject with an optional reason. The
 * two draft types differ only in how a row summarises itself and which form
 * edits it - the approve/reject/edit control flow is identical, so it lives
 * here once instead of twice.
 *
 * `onApprove(draft, record)` must resolve to `true` on success and `false` on
 * a handled failure (already reported by the caller, e.g. via its own error
 * state) - that is how the edit modal knows whether to close itself or stay
 * open so the person can fix what the server rejected.
 */
export default function DraftQueue({
  drafts, busy, title, emptyText = 'No drafts awaiting review.',
  renderSummary, renderExtra, FormComponent, formProps = {},
  onApprove, onReject,
}) {
  const [editing, setEditing] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const doApprove = async (draft, record, closeEditorOnSuccess) => {
    const ok = await onApprove(draft, record);
    if (ok && closeEditorOnSuccess) setEditing(null);
  };

  const doReject = async (draft) => {
    await onReject(draft, reason);
    setRejecting(null);
    setReason('');
  };

  return (
    <section className="card">
      <h2>{title} <span className="muted">({drafts.length})</span></h2>
      {drafts.length === 0 && <p className="muted">{emptyText}</p>}

      {/* Its own block, not a direct child of .card: each .draft row spaces
          itself with padding + a top border, and that rhythm would fight the
          card's own flex gap if the rows sat directly inside it. */}
      <div className="draft-list">
        {drafts.map((d) => (
          <div key={d.id} className="draft">
            {renderSummary(d)}
            {renderExtra && renderExtra(d)}

            {rejecting === d.id ? (
              <div className="actions">
                <input placeholder="why? (optional, logged)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="btn btn--danger" onClick={() => doReject(d)} disabled={busy}>Confirm reject</button>
                <button className="btn" onClick={() => { setRejecting(null); setReason(''); }}>Cancel</button>
              </div>
            ) : (
              <div className="actions">
                <button className="btn btn--primary" onClick={() => doApprove(d, d, false)} disabled={busy}>Approve</button>
                <button className="btn" onClick={() => setEditing(d.id)}>Edit &amp; approve</button>
                <button className="btn btn--danger" onClick={() => setRejecting(d.id)}>Reject</button>
              </div>
            )}

            {editing === d.id && (
              <Modal title={`Review ${d.id}`} onClose={() => setEditing(null)}>
                <FormComponent
                  value={d}
                  busy={busy}
                  onSave={(record) => doApprove(d, record, true)}
                  onCancel={() => setEditing(null)}
                  onDelete={() => { setEditing(null); setRejecting(d.id); }}
                  {...formProps}
                />
                <p className="muted small">Saving here approves the draft and merges it in.</p>
              </Modal>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
