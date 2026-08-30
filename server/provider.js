// The provider seam. Every server-side caller that used to import
// server/anthropic.js imports this instead; nothing but this file ever chooses
// which backend runs. Selection is LLM_PROVIDER ("anthropic", the default, or
// "ollama"), read once at startup and server-wide for the whole process -
// per-player provider selection is future work, deliberately not built (see
// CLAUDE.md's "LLM provider abstraction" section).
//
// `complete` keeps the exact call signature anthropic.js established and
// normalizes the return to { text, usage: { input, output }, stopReason,
// provider, model }, so nothing downstream - validators, logging, harvesting -
// needs to know which provider ran. The storyteller/referee split is untouched
// either way: whichever model writes the proposals, the engine still owns
// every number.

import * as anthropic from './anthropic.js';
import * as ollama from './ollama.js';

// Pure text helper and the error types, re-exported so callers need only this
// module. AnthropicError keeps its name and shape: server/index.js's
// retry-abort check (401/429) is Anthropic-specific by design, and an
// OllamaError deliberately does not match it.
export { extractJson, AnthropicError } from './anthropic.js';
export { OllamaError } from './ollama.js';

const VALID_PROVIDERS = new Set(['anthropic', 'ollama']);

export const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();

// Both of these are configuration mistakes worth dying loudly over at startup,
// not generation-time surprises: an unknown provider would otherwise silently
// mean "anthropic", and an unset OLLAMA_MODEL has no sane guess - a model name
// picked for the user may simply not be pulled. (Whether the configured model
// IS pulled needs a network call, so ollama.js checks that on first use.)
if (!VALID_PROVIDERS.has(PROVIDER)) {
  throw new Error(`LLM_PROVIDER must be "anthropic" or "ollama", got "${process.env.LLM_PROVIDER}"`);
}
if (PROVIDER === 'ollama' && !ollama.MODEL) {
  throw new Error(
    'LLM_PROVIDER=ollama but OLLAMA_MODEL is not set. There is deliberately no ' +
    'default model: set OLLAMA_MODEL to one you have pulled (see `ollama list`).',
  );
}

export const MODEL = PROVIDER === 'ollama' ? ollama.MODEL : anthropic.MODEL;

// "Is the LLM configured at all" - the gate every endpoint checks before
// falling back to seed content. For ollama the startup check above makes this
// always true; kept as a function so the anthropic path stays live-readable.
export const hasKey = () => (PROVIDER === 'ollama' ? Boolean(ollama.MODEL) : anthropic.hasKey());

export async function complete(opts) {
  if (PROVIDER === 'ollama') {
    const result = await ollama.complete(opts);
    return { ...result, provider: 'ollama', model: ollama.MODEL };
  }
  const result = await anthropic.complete(opts);
  return {
    text: result.text,
    usage: result.usage
      ? { input: result.usage.input_tokens ?? null, output: result.usage.output_tokens ?? null }
      : null,
    stopReason: result.stopReason,
    provider: 'anthropic',
    model: anthropic.MODEL,
  };
}
