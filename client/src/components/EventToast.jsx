import React, { useEffect, useState } from 'react';

// Whatever the engine did to you after the last swipe, said plainly.
export default function EventToast({ events, deltas }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!events || !events.length) { setVisible(false); return undefined; }
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 4200);
    return () => clearTimeout(t);
  }, [events]);

  if (!visible || !events || !events.length) {
    return <div className="toast-slot" aria-hidden="true">{deltas}</div>;
  }

  return (
    <div className="toast-slot">
      <div className="toast" role="status">
        {events.map((e, i) => (
          <p key={i} className={`toast__line toast__line--${e.outcome || e.type}`}>{e.text}</p>
        ))}
      </div>
    </div>
  );
}
