// Player preferences that outlive a single life. Everything here is wrapped:
// localStorage throws outright in some privacy modes rather than returning null.

const MODE_KEY = 'lifeswipe.contentMode';
const AGE_KEY = 'lifeswipe.ageConfirmed';

const read = (key) => {
  try { return window.localStorage.getItem(key); } catch { return null; }
};
const write = (key, value) => {
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
};

export function getContentMode() {
  return read(MODE_KEY) === 'mature' ? 'mature' : 'safe';
}

export function setContentMode(mode) {
  write(MODE_KEY, mode === 'mature' ? 'mature' : 'safe');
}

// Asked once, then remembered - not every life.
export function hasConfirmedAge() {
  return read(AGE_KEY) === 'yes';
}

export function confirmAge() {
  write(AGE_KEY, 'yes');
}

/* -------------------------------------------------- cross-life memory ---- */

// Library patterns this player has already been shown, in ANY life. Kept out
// of game state on purpose: run #7 should not repeat run #2's library events.
const SEEN_KEY = 'lifeswipe.seenPatterns';
const SEEN_CAP = 200;

export function getSeenPatterns() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function markPatternSeen(id) {
  if (!id) return;
  const seen = getSeenPatterns();
  if (seen.includes(id)) return;
  seen.push(id);
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-SEEN_CAP)));
  } catch { /* private mode - the life still plays, it just forgets */ }
}

export function resetSeenPatterns() {
  try { window.localStorage.removeItem(SEEN_KEY); } catch { /* ignore */ }
}
