// Thin Ollama client, mirroring server/anthropic.js's external interface: one
// `complete({system, user, prefill, maxTokens, temperature, timeoutMs})` that
// resolves to `{ text, usage, stopReason }`. Callers never import this file
// directly - server/provider.js dispatches here when LLM_PROVIDER=ollama.
//
// Differences from the Anthropic client, all deliberate:
//
// - `usage` comes back ALREADY normalized as { input, output } (from Ollama's
//   prompt_eval_count / eval_count), because there is no reason to carry a
//   provider-specific shape one hop just to translate it in provider.js.
// - `prefill` is accepted but NOT sent. Anthropic uses an assistant prefill to
//   force raw JSON; Ollama has `format` (grammar-constrained decoding), which
//   is stronger. The prefill still tells us what the caller expects - "[" means
//   a top-level array, "{" an object - so it steers which format constraint we
//   send. The returned text is the model's complete output, never
//   prefill-prefixed.
// - OLLAMA_MODEL has NO default. A guessed model that isn't pulled fails as a
//   confusing generation error minutes in; an unset one fails at startup with
//   its name (see server/provider.js's boot check).

const BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');

export const MODEL = process.env.OLLAMA_MODEL || null;

export class OllamaError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
  }
}

// Schema-constrained `format` (an inline JSON schema instead of the bare
// string "json") shipped in Ollama 0.5.0.
const STRUCTURED_OUTPUT_MIN = [0, 5, 0];

function versionAtLeast(version, min) {
  const parts = String(version || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] || 0) > min[i]) return true;
    if ((parts[i] || 0) < min[i]) return false;
  }
  return true;
}

async function getJson(pathname, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(BASE_URL + pathname, { signal: controller.signal });
  } catch (err) {
    throw new OllamaError(
      `Cannot reach Ollama at ${BASE_URL} (${err.name === 'AbortError' ? 'timed out' : err.message}). ` +
      'Is the Ollama server running? Set OLLAMA_BASE_URL if it lives elsewhere.',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new OllamaError(`Ollama API ${res.status} on ${pathname}: ${body.slice(0, 300)}`, res.status);
  }
  return res.json();
}

// One startup handshake, run on first use and remembered on success: is the
// configured model actually pulled, and does this Ollama support
// schema-constrained output? Failure is NOT cached - a model pulled after the
// first failed call should start working without a server restart.
let readiness = null;

async function checkReadiness() {
  if (!MODEL) {
    throw new OllamaError(
      'OLLAMA_MODEL is not set. There is deliberately no default: set it to a model you have pulled (see `ollama list`).',
      503,
    );
  }

  const tags = await getJson('/api/tags');
  const names = (tags.models || []).map((m) => m.name);
  // "qwen3-coder:30b" is pulled as exactly that; a tagless OLLAMA_MODEL like
  // "qwen3-coder" matches its ":latest" (or any) tag, same as the CLI does.
  const present = names.some((n) => n === MODEL || n.split(':')[0] === MODEL);
  if (!present) {
    throw new OllamaError(
      `Ollama model "${MODEL}" is not pulled on ${BASE_URL}. ` +
      `Available: ${names.join(', ') || '(none)'}. Run: ollama pull ${MODEL}`,
      503,
    );
  }

  let structured = false;
  let version = 'unknown';
  try {
    ({ version } = await getJson('/api/version'));
    structured = versionAtLeast(version, STRUCTURED_OUTPUT_MIN);
  } catch {
    // A server that answers /api/tags but not /api/version predates 0.1.15,
    // let alone structured outputs - fall back to basic json mode.
  }
  console.log(
    `[ollama] model "${MODEL}" present on ${BASE_URL} (server ${version}); ` +
    `structured outputs: ${structured ? 'schema-constrained format' : 'basic "json" mode only'}`,
  );
  return { structured };
}

async function ensureReady() {
  if (!readiness) {
    readiness = checkReadiness().catch((err) => {
      readiness = null;
      throw err;
    });
  }
  return readiness;
}

// Exposed for provider.js's runtime switch: the same memoized handshake the
// first completion runs, so the admin's storyteller toggle fails loudly right
// there if Ollama is down or the model isn't pulled.
export const verifyReady = ensureReady;

// The strongest constraint the running server supports, given what the caller
// expects back. A minimal top-level schema is enough: shared/schema.js remains
// the real validator either way, this only stops prose and code fences.
function formatFor(prefill, structured) {
  if (!structured) return 'json';
  if (prefill.startsWith('[')) return { type: 'array', items: { type: 'object' } };
  return { type: 'object' };
}

export async function complete({
  system,
  user,
  prefill = '',
  maxTokens = 3000,
  temperature = 1,
  timeoutMs = 30000,
}) {
  const { structured } = await ensureReady();

  // Local inference is a different latency regime from a hosted API - a 30B
  // model can spend longer on prompt eval than Anthropic spends on the whole
  // call - so the caller's timeout is a floor here, never a cap.
  const timeout = Math.max(timeoutMs, Number(process.env.OLLAMA_TIMEOUT_MS) || 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(BASE_URL + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: formatFor(prefill, structured),
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        options: { temperature, num_predict: maxTokens },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new OllamaError(`Ollama timed out after ${timeout}ms`, 504);
    throw new OllamaError('Network error calling Ollama: ' + err.message, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new OllamaError(`Ollama API ${res.status}: ${body.slice(0, 300)}`, res.status);
  }

  const data = await res.json();
  return {
    text: data.message?.content ?? '',
    usage: {
      input: data.prompt_eval_count ?? null,
      output: data.eval_count ?? null,
    },
    stopReason: data.done_reason ?? null,
  };
}
