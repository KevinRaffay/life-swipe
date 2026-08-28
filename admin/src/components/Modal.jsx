import React, { useEffect, useRef } from 'react';

/**
 * Centered dialog over a dimmed backdrop. The caller owns open/closed state
 * by mounting/unmounting this - unmounting is what discards whatever the
 * child form was holding, so there is no separate "reset" path to keep in
 * sync. Esc, a backdrop click, and Cancel (inside the form) all just call
 * onClose.
 */
export default function Modal({ title, onClose, children }) {
  const panelRef = useRef(null);
  const previousFocus = useRef(null);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.querySelector('input, textarea, select, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={panelRef}>
        <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>&times;</button>
        {children}
      </div>
    </div>
  );
}
