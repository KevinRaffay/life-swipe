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

export async function fetchScenarios({ summary, recent, count = 5 }) {
  const data = await jsonPost('/api/scenarios', { summary, recent, count });
  return data.scenarios || [];
}

export async function fetchObituary(stats, history) {
  try {
    const data = await jsonPost('/api/obituary', { stats, history }, 40000);
    return data.source === 'llm' ? data : null;
  } catch {
    return null;
  }
}
