import React, { useEffect, useRef, useState } from 'react';

/**
 * A major-tier consequence (a resolved pending event, a significant new
 * flag, or a large stat swing - see ../severity.js) gets this instead of the
 * transient toast: it only goes away when the player taps to close it. Same
 * centered-dialog pattern as admin/src/components/Modal.jsx, reimplemented
 * here because the admin app is a separate Vite root that never ships to
 * players.
 */
export default function ConsequenceModal({ events }) {
  const [open, setOpen] = useState(true);
  const panelRef = useRef(null);

  // A fresh batch of major events (a new `events` array from the next turn)
  // reopens the dialog even if the player left the last one closed.
  useEffect(() => { setOpen(true); }, [events]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open || !events || !events.length) {
    return <div className="toast-slot" aria-hidden="true" />;
  }

  return (
    <div
      className="consequence-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div
        className="consequence-modal"
        role="dialog"
        aria-modal="true"
        aria-label="What just happened"
        ref={panelRef}
        tabIndex={-1}
      >
        {events.map((e, i) => (
          <p key={i} className={`consequence-modal__line consequence-modal__line--${e.outcome || e.type}`}>
            {e.text}
          </p>
        ))}
        <button type="button" className="btn btn--primary consequence-modal__close" onClick={() => setOpen(false)}>
          Okay
        </button>
      </div>
    </div>
  );
}
