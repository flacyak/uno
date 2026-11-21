/**
 * @fileoverview The words of a column's header, which say what it holds.
 */

// A header's words: runs of letters, split again where lower case turns
// upper, so `pickupLat` is `pickup` and `lat`.
const LETTERS = /\p{L}+/gu;
const CASE_TURN = /(\p{Ll})(\p{Lu})/gu;

/** headerWords is `header` split into its words, in lower case. */
export function headerWords(header: string): string[] {
  const words = header.replace(CASE_TURN, '$1 $2').match(LETTERS) ?? [];
  return words.map((w) => w.toLowerCase());
}
