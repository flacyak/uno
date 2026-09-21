/**
 * @fileoverview Random input for the parallel-exact checks: CSV-like text
 * heavy in runs of quotes and CRs, every separator RecordScanner accepts
 * that matters, multi-byte characters, and chunk lengths drawn fresh for
 * every chunk.
 */

/** mulberry32 random number generator. A failure reports its seed. */
export function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Separators tried, including a letter and NUL, which the scanner accepts. */
export const SEPARATORS = [',', ';', '\t', '|', 'a', '\0'];

/**
 * Tokens, some repeated in runs: every byte the scanner acts on, every
 * separator, and characters of two, three and four bytes plus U+FEFF.
 */
const TOKENS = [
  'a',
  'b',
  ',',
  ';',
  '\t',
  '|',
  '\0',
  '"',
  '""',
  '"""',
  '\n',
  '\r',
  '\r\n',
  '\r\r',
  '\n\r',
  ' ',
  'é',
  '日',
  '\u{1F600}',
  '﻿',
];
/** The longest run of one token. */
const MAX_RUN = 40;
/** Chance a token is repeated as a run rather than written once. */
const RUN_CHANCE = 0.2;
/** Chance a file starts with a byte order mark. */
const BOM_CHANCE = 0.15;

/** gnarly makes a CSV-like text of about `tokens` tokens. */
export function gnarly(rand: () => number, tokens: number): string {
  let s = rand() < BOM_CHANCE ? '﻿' : '';
  for (let i = 0; i < tokens; i++) {
    const token = TOKENS[Math.floor(rand() * TOKENS.length)]!;
    const times = rand() < RUN_CHANCE ? 1 + Math.floor(rand() * MAX_RUN) : 1;
    s += token.repeat(times);
  }
  return s;
}

/** randomLengths returns chunk lengths, each drawn fresh, that sum to `total`. */
export function randomLengths(rand: () => number, total: number): number[] {
  const lengths: number[] = [];
  let left = total;
  while (left > 0) {
    const pick = rand();
    let length: number;
    if (pick < 0.3) length = 1;
    else if (pick < 0.5) length = 2 + Math.floor(rand() * 3);
    else length = 1 + Math.floor(rand() * 64);
    length = Math.min(length, left);
    lengths.push(length);
    left -= length;
  }
  return lengths;
}
