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

/* ------------------------------------------------------------- region ---- */

// The player's region, used only to weight which names the engine hands out.
//
// PRIVACY: what is stored here is a region CODE and nothing else - "US-MN", or
// a bare country like "DE". Never an IP address, never coordinates, never a
// city. The server derives the code offline from the request IP and discards
// the address (server/geo.js); this is where the result comes to rest.
//
// Two keys, on purpose. CHOICE_KEY is what the player picked and is the
// authority: 'auto' to accept detection, 'none' to switch weighting off, or a
// region code to pin it. DETECTED_KEY only caches what the server guessed, so
// a returning player does not re-ask on every load. IP geolocation is wrong
// for anyone on a VPN, a mobile carrier or a corporate network, which is why
// the override exists and why it always wins.
const REGION_CHOICE_KEY = 'lifeswipe.regionChoice';
const REGION_DETECTED_KEY = 'lifeswipe.regionDetected';

export const getRegionChoice = () => read(REGION_CHOICE_KEY) || 'auto';
export const setRegionChoice = (value) => write(REGION_CHOICE_KEY, String(value || 'auto'));
export const getDetectedRegion = () => read(REGION_DETECTED_KEY) || null;
export const setDetectedRegion = (code) => write(REGION_DETECTED_KEY, String(code || ''));

/**
 * The region actually in force: the player's pin, or the detected default, or
 * null. Null is a complete answer - names simply fall back to era-only
 * selection, which is how the game worked before regions existed.
 */
export function getActiveRegion() {
  const choice = getRegionChoice();
  if (choice === 'none') return null;
  if (choice !== 'auto') return choice;
  return getDetectedRegion() || null;
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

/* ------------------------------------------------------------- theme ---- */

// The player's theme, persisted like other preferences.
// null = never chosen, which means DARK - see getActiveTheme
// 'light' = light theme
// 'dark' = dark theme
const THEME_KEY = 'lifeswipe.theme';

export function getTheme() {
  const stored = read(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return null; // null = auto (follow OS)
}

export function setTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    write(THEME_KEY, theme);
  } else {
    // null or undefined = forget the choice, i.e. back to the dark default
    try { window.localStorage.removeItem(THEME_KEY); } catch { /* ignore */ }
  }
}

/**
 * The theme actually in force: what the player picked, or DARK.
 *
 * Dark is the default rather than the OS's `prefers-color-scheme`, which is
 * what this used to follow. Two reasons it is worth the departure from the
 * usual courtesy: the game is a dark comedy read one card at a time, and the
 * card is the whole screen, so the surround is the mood rather than chrome
 * around content; and the deployed demo is somebody's ten-second first
 * impression, where an OS-dependent look means half the audience sees a
 * design nobody chose for them.
 *
 * The player's own choice still wins outright and still persists. There is
 * deliberately no third "follow the OS" state any more: with dark as the
 * default it would render identically to 'dark', so the toggle would have had
 * a press that visibly did nothing.
 */
export function getActiveTheme() {
  return getTheme() || 'dark';
}

/**
 * Put the active theme on the document. The single place the class is
 * applied, because it was previously hand-rolled in two - App.jsx's mount
 * effect and StartScreen's toggle - and the toggle's copy removed
 * `.dark-theme` for any value that was not exactly 'dark'. That was already
 * wrong for a dark-preferring OS on the "auto" setting, and the dark default
 * would have made it wrong on every press through that state.
 */
export function applyTheme(theme = getActiveTheme()) {
  const root = document.documentElement;
  root.classList.toggle('dark-theme', theme === 'dark');
  return theme;
}
