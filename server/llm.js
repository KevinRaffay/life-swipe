// Wraps the raw Anthropic call (server/anthropic.js) with request/response
// logging. Every call made through here is written to
// server/logs/llm-requests.jsonl exactly once, regardless of outcome - success,
// validation failure, fallback, or an API error.
//
// The LLM call itself has no idea whether its output will be accepted; that is
// decided by the caller after validating the response. So `callLLM` returns a
// `finalizeLog(validationResult, validationErrors)` function instead of writing
// immediately - the caller invokes it once, after validation, and that write is
// what actually appends the line. It is fire-and-forget (see log-store.js), so
// it never adds latency to the response already on its way to the player.
//
// Nothing about generation, validation or the referee lives here - this only
// wraps the existing Anthropic call.

import crypto from 'node:crypto';
import { complete, AnthropicError } from './anthropic.js';
import { appendLog } from './log-store.js';

export { AnthropicError };

function assemblePromptText(system, user, prefill) {
  const parts = [`--- SYSTEM ---\n${system || ''}`, `--- USER ---\n${user || ''}`];
  if (prefill) parts.push(`--- PREFILL ---\n${prefill}`);
  return parts.join('\n\n');
}

/**
 * Same contract as anthropic.js's `complete`, plus `meta` describing why this
 * call happened (age, contentMode, triggeredBy, librarySlotUsed, threadBeat,
 * playerId - all optional). Never throws: an API error comes back as `.error`
 * so the caller's existing retry/fallback logic doesn't have to change shape.
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
    assembledPrompt: assemblePromptText(system, user, prefill),
    rawResponse: result ? result.text : null,
    tokenUsage: result?.usage
      ? { input: result.usage.input_tokens ?? null, output: result.usage.output_tokens ?? null }
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
    // line for this call.
    finalizeLog(validationResult, validationErrors = null) {
      appendLog({
        ...record,
        validationResult: validationResult ?? null,
        validationErrors: validationErrors && validationErrors.length ? validationErrors : null,
      });
    },
  };
}
