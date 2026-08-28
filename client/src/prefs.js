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

// Seed scenarios this player has been shown, remembered PER LIFE.
//
// The window is measured in lives, not cards, and that distinction is the whole
// fix. Two earlier attempts both failed on it:
//   - a fixed 120-card window never rolled (larger than the 57-card corpus), so
//     every card ended up permanently excluded and the deck spent each life
//     repeating cards and warning about it;
//   - a corpus-derived 23-card window rolled far too fast, because a life draws
//     ~50 cards, so the opening of the previous life was always forgiven and
//     the repeat rate went straight back to 50%.
// Counting lives is immune to both corpus size and life length.
const SEED_STORE_KEY = 'lifeswipe.seenSeeds';
export const LOOKBACK_LIVES = 2;

function readSeedStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEED_STORE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || typeof parsed.ids !== 'object') {
      return { life: 0, ids: {} };
    }
    return { life: Number(parsed.life) || 0, ids: parsed.ids || {} };
  } catch {
    return { life: 0, ids: {} };
  }
}

function writeSeedStore(store) {
  try { window.localStorage.setItem(SEED_STORE_KEY, JSON.stringify(store)); } catch { /* private mode */ }
}

/** Call once when a life starts. Returns the new life index. */
export function beginLife() {
  const store = readSeedStore();
  store.life += 1;
  // Forget anything older than the lookback so the store cannot grow forever.
  const cutoff = store.life - LOOKBACK_LIVES;
  for (const [id, seenAt] of Object.entries(store.ids)) {
    if (seenAt < cutoff) delete store.ids[id];
  }
  writeSeedStore(store);
  return store.life;
}

/** Ids shown within the last LOOKBACK_LIVES lives. */
export function getSeenSeedIds() {
  const store = readSeedStore();
  const cutoff = store.life - LOOKBACK_LIVES;
  return Object.entries(store.ids)
    .filter(([, seenAt]) => seenAt > cutoff)
    .map(([id]) => id);
}

export function markSeedSeen(id) {
  if (!id) return;
  const store = readSeedStore();
  store.ids[id] = store.life;
  writeSeedStore(store);
}

export function resetSeenSeedIds() {
  try { window.localStorage.removeItem(SEED_STORE_KEY); } catch { /* ignore */ }
}
