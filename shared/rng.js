// Deterministic, serializable PRNG (mulberry32).
// The engine stores `rngState` as a plain uint32 inside the game state, so a
// whole run can be JSON round-tripped and replayed exactly.

export function seedFrom(input) {
  const str = String(input ?? Date.now());
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Advances `holder.rngState` in place and returns a float in [0, 1).
export function nextRandom(holder) {
  holder.rngState = (holder.rngState + 0x6d2b79f5) >>> 0;
  let t = holder.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const chance = (holder, p) => nextRandom(holder) < p;
export const range = (holder, lo, hi) => lo + nextRandom(holder) * (hi - lo);
export const intRange = (holder, lo, hi) => Math.floor(range(holder, lo, hi + 1));
export const pick = (holder, arr) => arr[Math.floor(nextRandom(holder) * arr.length) % arr.length];

// Standard normal via Box-Muller, used for market noise.
export function gauss(holder) {
  const u = Math.max(1e-9, nextRandom(holder));
  const v = nextRandom(holder);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
