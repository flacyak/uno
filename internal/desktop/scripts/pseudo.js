// The pseudo-locale: English with every letter accented, about a third
// longer, and in brackets.
//
// Text on screen in plain letters came from outside the messages. Text with
// a bracket missing was cut short by the layout. The locale tag is en-XA.

/** The locale the pseudo-messages are compiled as. */
export const PSEUDO_LOCALE = "en-XA";

/** The brackets around every pseudo-message. */
export const PSEUDO_OPEN = "⟦";
export const PSEUDO_CLOSE = "⟧";

/** Extra length added to a message, as a share of its letters. */
const GROWTH = 0.3;

/** The character a message is padded with. */
const PAD = "·";

const PLAIN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ACCENTED = "åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ";

/** The accented letter for each plain one. Each is one UTF-16 unit, so they pair by index. */
const ACCENTS = new Map(PLAIN.split("").map((letter, i) => [letter, ACCENTED.charAt(i)]));

/**
 * pseudo converts one message pattern to the pseudo-locale. Text in braces
 * (variables, markup) and escaped characters are left as they are.
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
      // An escaped character stays escaped.
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
 * pseudoMessages converts a whole message file: every pattern through pseudo,
 * everything else as it was. A message with variants keeps its declarations
 * and selectors, and has each variant's pattern converted.
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
