// Wraps the raw LLM call (server/provider.js, which dispatches to Anthropic
// or Ollama) with request/response logging. Every call made through here is
// written to
// server/logs/llm-requests.jsonl exactly once, regardless of outcome - success,
// validation failure, fallback, or an API error.
//
// The LLM call itself has no idea whether its output will be accepted; that is
// decided by the caller after validating the response. So `callLLM` returns a
// `finalizeLog(validationResult, validationErrors, validationWarnings)`
// function instead of writing
// immediately - the caller invokes it once, after validation, and that write is
// what actually appends the line. It is fire-and-forget (see log-store.js), so
// it never adds latency to the response already on its way to the player.
//
// Nothing about generation, validation or the referee lives here - this only
// wraps the existing provider call.

import crypto from 'node:crypto';
import { complete, AnthropicError, PROVIDER } from './provider.js';
import { appendLog } from './log-store.js';

export { AnthropicError };

// The only two answers to "whose key was this". Anything else - including the
// absence of an answer - is recorded as null; see `keySource` below.
const KEY_SOURCES = new Set(['server', 'byok']);

function assemblePromptText(system, user, prefill) {
  const parts = [`--- SYSTEM ---\n${system || ''}`, `--- USER ---\n${user || ''}`];
  if (prefill) parts.push(`--- PREFILL ---\n${prefill}`);
  return parts.join('\n\n');
}

/**
 * Same contract as provider.js's `complete`, plus `meta` describing why this
 * call happened (age, contentMode, triggeredBy, librarySlotUsed, threadBeat,
 * playerId, keySource - all optional). Never throws: an API error comes back as
 * `.error` so the caller's existing retry/fallback logic doesn't have to change
 * shape.
 *
 * @returns {{ text, usage, stopReason, error, finalizeLog }}
 */
export async function callLLM({
  system, user, prefill = '', maxTokens = 3000, temperature = 1, timeoutMs = 30000, meta = {},
}) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const t0 = Date.now();

  let result = null;
  let apiError = null;
  try {
    result = await complete({ system, user, prefill, maxTokens, temperature, timeoutMs });
  } catch (err) {
    apiError = err;
  }
  const latencyMs = Date.now() - t0;

  const record = {
    id,
    timestamp,
    playerId: meta.playerId ?? null,
    age: meta.age ?? null,
    contentMode: meta.contentMode ?? null,
    triggeredBy: meta.triggeredBy ?? null,
    librarySlotUsed: meta.librarySlotUsed ?? null,
    threadBeat: meta.threadBeat ?? null,
    // WHICH BACKEND RAN THIS CALL. Not a keySource value: keySource answers
    // "whose key paid" (a server-run Ollama instance is still the server's
    // resource, so its calls stay 'server'), this answers "which model wrote
    // it". Recorded even when the call errored - the provider was still asked.
    provider: PROVIDER,
    // WHOSE KEY PAID FOR THIS CALL. Today every backend is a server-owned
    // resource - anthropic.js reads process.env.ANTHROPIC_API_KEY and nothing
    // else, and a server-run Ollama instance is the server's compute even
    // though no key exists - so every live call declares 'server' regardless
    // of provider. The field exists because the content
    // harvester (server/harvest.js) may only ever mine generations paid for by
    // the server's own key: a player's BYOK session is their content, not the
    // project's, and harvesting it would be taking something that was not
    // offered.
    //
    // Undeclared is deliberately NOT 'server'. A caller that does not say
    // records null, and null is ineligible for harvesting - so if a BYOK path
    // is ever added and forgets to declare itself here, its calls are excluded
    // by default rather than silently swept into the seed deck. Every entry
    // written before this field existed is null for the same reason.
    keySource: KEY_SOURCES.has(meta.keySource) ? meta.keySource : null,
    assembledPrompt: assemblePromptText(system, user, prefill),
    rawResponse: result ? result.text : null,
    // provider.js already normalized usage to { input, output }, whichever
    // backend ran.
    tokenUsage: result?.usage
      ? { input: result.usage.input ?? null, output: result.usage.output ?? null }
      : null,
    latencyMs,
    apiError: apiError ? apiError.message : null,
  };

  return {
    text: result ? result.text : null,
    usage: result ? result.usage : null,
    stopReason: result ? result.stopReason : null,
    error: apiError,
    // Call exactly once, after inspecting the response, to write the one log
    // line for this call. Warnings are advisory craft observations and can
    // accompany any result, including 'passed'.
    finalizeLog(validationResult, validationErrors = null, validationWarnings = null) {
      appendLog({
        ...record,
        validationResult: validationResult ?? null,
        validationErrors: validationErrors && validationErrors.length ? validationErrors : null,
        validationWarnings: validationWarnings && validationWarnings.length ? validationWarnings : null,
      });
    },
  };
}
