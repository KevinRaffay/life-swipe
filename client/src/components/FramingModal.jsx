import React, { useCallback, useEffect, useRef, useState } from 'react';

const EXIT_MS = 220;
const CONTINUE_KEYS = ['Enter', ' ', 'Spacebar', 'Escape', 'ArrowLeft', 'ArrowRight'];

export default function FramingModal({ framing, onContinue }) {
  const [exiting, setExiting] = useState(false);
  const pointer = useRef(null);
  const dialogRef = useRef(null);
  const ready = !exiting;

  const commit = useCallback(() => {
    if (!ready) return;
    setExiting(true);
    window.setTimeout(onContinue, EXIT_MS);
  }, [ready, onContinue]);

  // Focus the dialog so keyboard events work
  useEffect(() => { dialogRef.current?.focus(); }, []);

  // Keyboard handlers
  useEffect(() => {
    const onKey = (e) => {
      if (!CONTINUE_KEYS.includes(e.key)) return;
      e.preventDefault();
      commit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit]);

  // Pointer handlers with capture
  const onPointerDown = (e) => {
    if (!ready) return;
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerUp = (e) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    commit();
  };

  return (
    <div
      className={`grounding-backdrop${exiting ? ' is-exiting' : ''}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { pointer.current = null; }}
    >
      <article
        className="grounding-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Opening frame"
        ref={dialogRef}
        tabIndex={-1}
      >
        <p style={{ margin: 0, textAlign: 'center', fontSize: '14px', fontWeight: 500, letterSpacing: '0.02em', lineHeight: 1.5 }}>
          {framing}
        </p>
        <p className="grounding-modal__hint">tap, swipe, or press a key to continue</p>
      </article>
    </div>
  );
}
