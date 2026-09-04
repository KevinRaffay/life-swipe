// The provider seam. Every server-side caller that used to import
// server/anthropic.js imports this instead; nothing but this file ever chooses
// which backend runs. Selection is LLM_PROVIDER ("anthropic", the default, or
// "ollama") at boot, switchable at runtime through the admin's storyteller
// toggle (setProvider) - either way it is server-wide for the whole process.
// Per-player provider selection is future work, deliberately not built (see
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

// What LLM_PROVIDER says. The ACTIVE provider starts here and can be switched
// at runtime (the admin's storyteller toggle, via setProvider below); a
// restart always reverts to this.
const BOOT_PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();

// Both of these are configuration mistakes worth dying loudly over at startup,
// not generation-time surprises: an unknown provider would otherwise silently
// mean "anthropic", and an unset OLLAMA_MODEL has no sane guess - a model name
// picked for the user may simply not be pulled. (Whether the configured model
// IS pulled needs a network call, so ollama.js checks that on first use.)
if (!VALID_PROVIDERS.has(BOOT_PROVIDER)) {
  throw new Error(`LLM_PROVIDER must be "anthropic" or "ollama", got "${process.env.LLM_PROVIDER}"`);
}
if (BOOT_PROVIDER === 'ollama' && !ollama.MODEL) {
  throw new Error(
    'LLM_PROVIDER=ollama but OLLAMA_MODEL is not set. There is deliberately no ' +
    'default model: set OLLAMA_MODEL to one you have pulled (see `ollama list`).',
  );
}

const modelFor = (provider) => (provider === 'ollama' ? ollama.MODEL : anthropic.MODEL);

// `let`, deliberately: these are LIVE BINDINGS. Every importer of PROVIDER or
// MODEL sees the reassignment in setProvider the moment it happens, so a
// runtime switch is reflected in responses, logs and the /api/config line
// without any caller re-reading anything.
export let PROVIDER = BOOT_PROVIDER;
export let MODEL = modelFor(BOOT_PROVIDER);

/**
 * Switch the active provider at runtime - the admin's storyteller toggle.
 * Still server-wide (one storyteller for every life this process serves; this
 * is NOT per-player selection) and in memory only: LLM_PROVIDER stays the
 * boot default and a restart reverts to it.
 *
 * Refuses to switch to a provider that could not serve the next call - no key,
 * no configured model, or (for Ollama, via the same handshake the first
 * completion runs) a model that is not actually pulled - so the toggle fails
 * loudly here instead of quietly turning every generation into a seed
 * fallback.
 */
export async function setProvider(name) {
  const next = String(name || '').trim().toLowerCase();
  if (!VALID_PROVIDERS.has(next)) {
    const err = new Error(`provider must be "anthropic" or "ollama", got "${name}"`);
    err.status = 400;
    throw err;
  }
  if (next === 'ollama') {
    if (!ollama.MODEL) {
      const err = new Error('OLLAMA_MODEL is not set, so there is nothing to switch to. Set it and restart.');
      err.status = 400;
      throw err;
    }
    await ollama.verifyReady();
  } else if (!anthropic.hasKey()) {
    const err = new Error('ANTHROPIC_API_KEY is not set, so there is nothing to switch to.');
    err.status = 400;
    throw err;
  }
  PROVIDER = next;
  MODEL = modelFor(next);
  return providerStatus();
}

/** What is running now, what it boots as, and what a switch could target. */
export const providerStatus = () => ({
  provider: PROVIDER,
  model: MODEL,
  bootProvider: BOOT_PROVIDER,
  available: {
    anthropic: { configured: anthropic.hasKey(), model: anthropic.MODEL },
    ollama: { configured: Boolean(ollama.MODEL), model: ollama.MODEL },
  },
});

// "Is the LLM configured at all" - the gate every endpoint checks before
// falling back to seed content. For ollama the boot check (or setProvider's
// refusal) makes this always true while ollama is active; kept as a function
// so the anthropic path stays live-readable.
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
