import React, { useEffect, useRef, useState } from 'react';

import ConsequenceModal from './ConsequenceModal.jsx';

// ~3-4s target read time; see severity.js for what routes to the modal
// instead of this timer entirely.
const TOAST_DURATION_MS = 3800;

// Whatever the engine did to you after the last swipe, said plainly. Major
// consequences (severity.js) skip this and go to ConsequenceModal instead.
export default function EventToast({ events, deltas, severity }) {
  const [visible, setVisible] = useState(false);
  const hasEvents = !!(events && events.length);
  const isMajor = severity === 'major';
  const showToast = hasEvents && !isMajor;

  const timerRef = useRef(null);
  const remainingRef = useRef(TOAST_DURATION_MS);
  const armedAtRef = useRef(0);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const arm = (ms) => {
    clearTimer();
    armedAtRef.current = performance.now();
    timerRef.current = setTimeout(() => setVisible(false), ms);
  };
  const dismiss = () => { clearTimer(); setVisible(false); };

  // A new batch of events (including a new major batch, which never sets
  // showToast) always resets whatever the previous toast was doing.
  useEffect(() => {
    if (!showToast) { setVisible(false); return undefined; }
    setVisible(true);
    remainingRef.current = TOAST_DURATION_MS;
    arm(TOAST_DURATION_MS);
    return clearTimer;
  }, [events, showToast]);

  // A finger/pointer down anywhere pauses the countdown - mid-swipe is not
  // the moment to have the toast vanish on its own - and lifting resumes it
  // with whatever time was left, rather than a fresh 3-4s.
  useEffect(() => {
    if (!showToast) return undefined;
    const onDown = () => {
      if (!timerRef.current) return;
      clearTimer();
      remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - armedAtRef.current));
    };
    const onUp = () => {
      if (remainingRef.current > 0) arm(remainingRef.current);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [showToast]);

  if (isMajor && hasEvents) {
    return <ConsequenceModal events={events} />;
  }

  if (!visible || !showToast) {
    return <div className="toast-slot" aria-hidden="true">{deltas}</div>;
  }

  return (
    <div className="toast-slot">
      <div className="toast" role="status" onClick={dismiss} title="Tap to dismiss">
        {events.map((e, i) => (
          <p key={i} className={`toast__line toast__line--${e.outcome || e.type}`}>{e.text}</p>
        ))}
      </div>
    </div>
  );
}
