// Thin Anthropic client. Lives on the server so the API key never ships to the
// browser. No SDK dependency - the Messages API is one POST.

// Overridable so the endpoint can be pointed at a gateway, or at a mock in tests.
const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const API_VERSION = '2023-06-01';

export const MODEL = process.env.LIFESWIPE_MODEL || 'claude-sonnet-4-6';

export const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

export class AnthropicError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

/**
 * One Messages API call. `prefill` seeds the assistant turn, which is how we
 * force raw JSON: prefilling "[" makes a markdown fence syntactically awkward
 * for the model to produce.
 */
function buildMessages(user, prefill) {
  const messages = [{ role: 'user', content: user }];
  if (prefill) messages.push({ role: 'assistant', content: prefill });
  return messages;
}

export async function complete({
  system,
  user,
  prefill = '',
  maxTokens = 3000,
  temperature = 1,
  timeoutMs = 30000,
}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new AnthropicError('ANTHROPIC_API_KEY is not set', 401);
  const usePrefill = Boolean(prefill);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: buildMessages(user, usePrefill ? prefill : ''),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new AnthropicError('Anthropic API timed out', 504);
    throw new AnthropicError('Network error calling Anthropic: ' + err.message, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Not every model accepts an assistant prefill. When one refuses, drop the
    // prefill and ask again rather than burning a validation attempt on it -
    // extractJson already copes with prose and code fences.
    if (res.status === 400 && usePrefill && /prefill/i.test(body)) {
      return complete({ system, user, prefill: '', maxTokens, temperature, timeoutMs });
    }
    throw new AnthropicError(`Anthropic API ${res.status}: ${body.slice(0, 300)}`, res.status);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return { text: (usePrefill ? prefill : '') + text, usage: data.usage, stopReason: data.stop_reason };
}

// Models sometimes wrap JSON in prose or a fence despite instructions. Dig it out.
export function extractJson(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(body);
  } catch {
    // Fall back to the outermost bracketed span.
    for (const [open, close] of [['[', ']'], ['{', '}']]) {
      const start = body.indexOf(open);
      const end = body.lastIndexOf(close);
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(body.slice(start, end + 1));
        } catch { /* keep trying */ }
      }
    }
    return null;
  }
}
