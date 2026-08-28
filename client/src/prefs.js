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
