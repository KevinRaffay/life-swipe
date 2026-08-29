// Where a piece of content came from, as a vocabulary rather than four
// separate string literals scattered across the writers.
//
// This is an AUTHORING fact, recorded once when a record is created and never
// touched again. It is not the runtime `source` on a dealt card - `shared/
// deck.js` stamps that ('seed' | 'llm' | 'fallback' | 'library') to say which
// pipe a card arrived through this turn, and it overwrites whatever the record
// carried on disk. The two never meet: nothing in the game loop reads the
// authoring value, and nothing in the admin reads the runtime one.
//
// The point of tracking this at all is the harvest loop. Content harvested
// from the game's own output narrows toward the model's most common shapes -
// the deck starts feeding on itself. Knowing what fraction of the library and
// the seed deck is 'harvested' turns that from a suspicion into a number the
// stats view can show. It is a signal to watch, never a limit anything
// enforces.

export const SOURCES = ['hand-authored', 'extracted', 'generated', 'harvested'];

/** Written by a person, in the admin forms or straight into the JSON file. */
export const HAND_AUTHORED = 'hand-authored';
/** server/extraction.js, from pasted external source text. */
export const EXTRACTED = 'extracted';
/** server/seed-generation.js, bulk drafting against a generic sample state. */
export const GENERATED = 'generated';
/** server/harvest.js, mined from the LLM request log after live play. */
export const HARVESTED = 'harvested';

export const isSource = (value) => SOURCES.includes(value);

/**
 * The provenance of one record, for counting.
 *
 * Content that predates this field is treated as hand-authored, which is what
 * it actually is: the seed deck and the situation library were both written by
 * hand before anything else could write to them. Guessing "unknown" instead
 * would put every existing record into a bucket that means nothing and make
 * the harvested share look smaller than it is.
 */
export const sourceOf = (record) =>
  (record && isSource(record.source) ? record.source : HAND_AUTHORED);

/**
 * How much of a content set came from harvesting its own output, 0..1.
 * @param {Array} records
 */
export function harvestedShare(records) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return 0;
  return list.filter((r) => sourceOf(r) === HARVESTED).length / list.length;
}

/** Every source present in a content set, as { source: count }. */
export function tallySources(records) {
  const out = {};
  for (const record of Array.isArray(records) ? records : []) {
    const key = sourceOf(record);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
