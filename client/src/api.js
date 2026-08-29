// Client half of the LLM wiring. Everything here is best-effort: if the server
// or the model is unavailable the deck falls back to seed content and the game
// carries on without telling the player anything is wrong.

const jsonPost = async (url, body, timeoutMs = 35000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

export async function getConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('config unavailable');
    return await res.json();
  } catch {
    return { llmEnabled: false, model: null };
  }
}

/**
 * Ask the server which region this player appears to be in. Best-effort in the
 * strongest sense: any failure returns null and the game runs with no regional
 * name weighting at all. Only a region code ever comes back - the server does
 * the IP lookup offline and discards the address (server/geo.js).
 */
export async function fetchRegion() {
  try {
    const res = await fetch('/api/region');
    if (!res.ok) throw new Error('region unavailable');
    const data = await res.json();
    return typeof data.region === 'string' ? data.region : null;
  } catch {
    return null;
  }
}

export async function fetchScenarios({ summary, recent, count = 5, librarySlot = null }) {
  const data = await jsonPost('/api/scenarios', { summary, recent, count, librarySlot });
  return data.scenarios || [];
}

/**
 * The one-off establishing scene between the two identity choices and the
 * first deck.draw() card (shared/intro.js). Best-effort like everything else
 * here: a shorter timeout than the scenario/obituary calls, because this one
 * blocks a screen the player is looking at rather than a background refill,
 * and null on any failure so the caller can fall back to
 * shared/intro.js's authored beat - the intro never waits on the network any
 * longer than this.
 */
export async function fetchIntroBeat({ financialTier, personality, region }) {
  try {
    const data = await jsonPost('/api/intro', { financialTier, personality, region }, 15000);
    return data.source === 'llm' && data.setting && data.beat
      ? { setting: data.setting, beat: data.beat }
      : null;
  } catch {
    return null;
  }
}

export async function fetchObituary(stats, history) {
  try {
    const data = await jsonPost('/api/obituary', { stats, history }, 40000);
    return data.source === 'llm' ? data : null;
  } catch {
    return null;
  }
}
