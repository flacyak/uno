// The pseudo-locale: English a person can still read, that no one could
// mistake for English.
//
// Every letter wears an accent, every message is about a third longer, and
// each one sits in brackets. Text on screen without accents is text that never
// went through a message. Text with a bracket missing has been cut short by a
// layout that only fitted the English. Text with accents and both brackets is
// what a translation will look like before there is one.
//
// It is en-XA, the tag Android and ICU already use for exactly this.

/** The locale the pseudo-messages are compiled as. */
export const PSEUDO_LOCALE = "en-XA";

/** What opens and closes every pseudo-message. */
export const PSEUDO_OPEN = "⟦";
export const PSEUDO_CLOSE = "⟧";

/** How much longer than its English a pseudo-message is, as a share of its letters. */
const GROWTH = 0.3;

/** What a message is padded with, to the length a longer language would run to. */
const PAD = "·";

const PLAIN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ACCENTED = "åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ";

/** The accented letter for each plain one. Each is one UTF-16 unit, so they pair by index. */
const ACCENTS = new Map(PLAIN.split("").map((letter, i) => [letter, ACCENTED.charAt(i)]));

/**
 * pseudo is one message pattern in the pseudo-locale.
 *
 * What a pattern holds in braces is the compiler's and is left as it is: a
 * variable, a piece of markup, and a brace the message escaped to keep.
 *
 * @param {string} pattern
 * @returns {string}
 */
export function pseudo(pattern) {
  let out = "";
  let letters = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      // An escaped character is the message's own, and stays escaped.
      out += c + (pattern[i + 1] ?? "");
      i++;
    } else if (c === "{") {
      const close = pattern.indexOf("}", i);
      const end = close === -1 ? pattern.length - 1 : close;
      out += pattern.slice(i, end + 1);
      i = end;
    } else {
      const accented = ACCENTS.get(c);
      if (accented !== undefined) letters++;
      out += accented ?? c;
    }
  }
  const padding = PAD.repeat(Math.ceil(letters * GROWTH));
  return `${PSEUDO_OPEN}${out}${padding === "" ? "" : ` ${padding}`}${PSEUDO_CLOSE}`;
}

/**
 * pseudoMessages is a whole message file in the pseudo-locale: every pattern
 * through pseudo, and everything that is not a pattern as it was.
 *
 * A message with variants keeps its declarations and selectors, which are code,
 * and has each variant's pattern replaced.
 *
 * @param {Record<string, unknown>} messages  a parsed messages/<locale>.json
 * @returns {Record<string, unknown>}
 */
export function pseudoMessages(messages) {
  return Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      key,
      key.startsWith("$") ? value : pseudoValue(value),
    ]),
  );
}

/**
 * @param {unknown} value  a pattern, a message with variants, or a nest of messages
 * @returns {unknown}
 */
function pseudoValue(value) {
  if (typeof value === "string") return pseudo(value);
  if (Array.isArray(value)) return value.map(pseudoVariants);
  if (typeof value === "object" && value !== null) return pseudoMessages({ ...value });
  return value;
}

/**
 * @param {unknown} variants  one `{ declarations, selectors, match }` of a message
 * @returns {unknown}
 */
function pseudoVariants(variants) {
  if (typeof variants !== "object" || variants === null || !("match" in variants)) return variants;
  const match = /** @type {Record<string, string>} */ (variants.match);
  return {
    ...variants,
    match: Object.fromEntries(Object.entries(match).map(([when, p]) => [when, pseudo(p)])),
  };
}
