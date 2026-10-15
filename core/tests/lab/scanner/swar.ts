/**
 * @fileoverview Variant (b): RecordScanner whose inner loops read four bytes
 * at a time through an Int32Array, SWAR style ("SIMD within a register").
 *
 * The Int32Array covers the aligned middle of the chunk; the at most three
 * bytes before it and three after it are read a byte at a time. A word is
 * tested for an LF or a quote with a zero-byte test: XOR with the byte
 * repeated four times turns a match into a zero byte, and zeroBytes flags
 * exactly the zero bytes, with no carry between bytes. Because no flag is
 * ever false, a search that starts partway into a word masks off the flags
 * of the bytes before it instead of stepping to the next word boundary.
 * On a little-endian machine the lowest flag is the first match.
 *
 * The finders are exported for the batch variant, which shares them.
 */

import {
  BARE,
  CR,
  FIELD,
  LF,
  LINE,
  LINE_CR,
  QUOTE,
  QUOTED,
  QUOTE_CR,
  QUOTE_SEEN,
  separatorByte,
} from './common.ts';
import type { Begin, LabScanner, State } from './common.ts';
import { unreachable } from '@never';

/** Bytes per Int32Array element. */
const WORD_BYTES = Int32Array.BYTES_PER_ELEMENT;
/** log2 of WORD_BYTES, to turn a word index into a byte offset. */
const WORD_SHIFT = 2;
/** The low bits of a byte offset within its word. */
const WORD_MASK = WORD_BYTES - 1;
/** Bits per byte, to turn a bit index into a byte index. */
const BYTE_SHIFT = 3;
/** The highest bit index in a 32-bit word. */
const TOP_BIT = 31;

/** 0x01 in every byte. */
const ONES = 0x01010101;
/** 0x7f in every byte: each byte's low seven bits. */
const LOW_SEVEN = 0x7f7f7f7f;
/** LF in every byte. */
const LF_WORD = LF * ONES;
/** A quote in every byte. */
const QUOTE_WORD = QUOTE * ONES;
/** Every bit set, as the int32 bitwise operators see it. */
const ALL = -1;

/** Whether the first byte of a word in memory is its lowest-order byte. */
export const LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * zeroBytes sets the high bit of each byte of `x` that is zero, and no other
 * bit. Adding 0x7f to a byte's low seven bits sets its high bit unless they
 * are all clear and never carries into the next byte; OR-ing in `x` then
 * catches a set high bit.
 */
function zeroBytes(x: number): number {
  return ~(((x & LOW_SEVEN) + LOW_SEVEN) | x | LOW_SEVEN);
}

/** fromByte masks off the flags of the first `skip` bytes of a word. */
function fromByte(skip: number): number {
  return ALL << (skip << BYTE_SHIFT);
}

/**
 * firstByte is the byte index, 0 to 3, of the lowest bit set in `flags`.
 * `flags ^ (flags - 1)` sets every bit up to the lowest set one; unlike
 * `flags & -flags` it never leaves int32 range in a way that matters,
 * because the XOR truncates it.
 */
function firstByte(flags: number): number {
  return (TOP_BIT - Math.clz32(flags ^ (flags - 1))) >> BYTE_SHIFT;
}

/**
 * Words is a chunk seen as aligned 32-bit words: `words[w]` holds the bytes
 * from `head + 4w`. Bytes before `head` and from `tail` on are outside it.
 */
export interface Words {
  readonly words: Int32Array;
  readonly head: number;
  readonly tail: number;
}

/** No words, for a chunk that ends before its first word boundary. */
const NO_WORDS = new Int32Array(0);

/** wordsOf views the aligned middle of `chunk` as words. */
export function wordsOf(chunk: Uint8Array): Words {
  const end = chunk.length;
  const head = (WORD_BYTES - (chunk.byteOffset & WORD_MASK)) & WORD_MASK;
  if (head >= end) return { words: NO_WORDS, head: end, tail: end };
  const count = (end - head) >> WORD_SHIFT;
  const words = new Int32Array(chunk.buffer, chunk.byteOffset + head, count);
  return { words, head, tail: head + (count << WORD_SHIFT) };
}

/** lineOrQuote flags the LF and quote bytes of a word. */
function lineOrQuote(x: number): number {
  return zeroBytes(x ^ LF_WORD) | zeroBytes(x ^ QUOTE_WORD);
}

/** quotes flags the quote bytes of a word. */
function quotes(x: number): number {
  return zeroBytes(x ^ QUOTE_WORD);
}

/** findLineOrQuote is the offset of the first LF or quote from `from`, or `end`. */
export function findLineOrQuote(
  chunk: Uint8Array,
  view: Words,
  from: number,
  end: number,
): number {
  const { words, head, tail } = view;
  let j = from;
  for (; j < head; j++) {
    const c = chunk[j]!;
    if (c === LF || c === QUOTE) return j;
  }
  if (j < tail) {
    let w = (j - head) >> WORD_SHIFT;
    let hits = lineOrQuote(words[w]!) & fromByte((j - head) & WORD_MASK);
    while (hits === 0 && ++w < words.length) hits = lineOrQuote(words[w]!);
    if (hits !== 0) return head + (w << WORD_SHIFT) + firstByte(hits);
    j = tail;
  }
  for (; j < end; j++) {
    const c = chunk[j]!;
    if (c === LF || c === QUOTE) return j;
  }
  return end;
}

/** findQuote is the offset of the first quote from `from`, or `end`. */
export function findQuote(
  chunk: Uint8Array,
  view: Words,
  from: number,
  end: number,
): number {
  const { words, head, tail } = view;
  let j = from;
  for (; j < head; j++) {
    if (chunk[j] === QUOTE) return j;
  }
  if (j < tail) {
    let w = (j - head) >> WORD_SHIFT;
    let hits = quotes(words[w]!) & fromByte((j - head) & WORD_MASK);
    while (hits === 0 && ++w < words.length) hits = quotes(words[w]!);
    if (hits !== 0) return head + (w << WORD_SHIFT) + firstByte(hits);
    j = tail;
  }
  for (; j < end; j++) {
    if (chunk[j] === QUOTE) return j;
  }
  return end;
}

/** SwarScanner finds record starts four bytes at a time. */
export class SwarScanner implements LabScanner {
  private readonly begin: Begin;

  state: State = LINE;
  crAt = 0;
  private readonly sep: number;

  constructor(comma: string, begin: Begin) {
    this.begin = begin;
    if (!LITTLE_ENDIAN)
      throw new Error('SwarScanner needs a little-endian machine');
    this.sep = separatorByte(comma);
  }

  push(chunk: Uint8Array, base: number): void {
    const sep = this.sep;
    const end = chunk.length;
    const view = wordsOf(chunk);
    let s = this.state;
    let i = 0;

    while (i < end) {
      switch (s) {
        case LINE: {
          const b = chunk[i]!;
          if (b === LF) break;
          if (b === CR) {
            s = LINE_CR;
            this.crAt = base + i;
            break;
          }
          this.begin(base + i);
          s = b === QUOTE ? QUOTED : b === sep ? FIELD : BARE;
          break;
        }

        case LINE_CR: {
          const b = chunk[i]!;
          if (b === LF) {
            s = LINE;
            break;
          }
          this.begin(this.crAt);
          s = b === sep ? FIELD : BARE;
          break;
        }

        case FIELD:
        case BARE: {
          const j = findLineOrQuote(chunk, view, i, end);
          if (j === end) {
            s = chunk[end - 1] === sep ? FIELD : BARE;
            i = end;
            continue;
          }
          if (chunk[j] === LF) s = LINE;
          else if (j === i ? s === FIELD : chunk[j - 1] === sep) s = QUOTED;
          else s = BARE;
          i = j;
          break;
        }

        case QUOTED: {
          const j = findQuote(chunk, view, i, end);
          if (j === end) {
            i = end;
            continue;
          }
          s = QUOTE_SEEN;
          i = j;
          break;
        }

        case QUOTE_SEEN: {
          const b = chunk[i]!;
          if (b === QUOTE) s = QUOTED;
          else if (b === sep) s = FIELD;
          else if (b === LF) s = LINE;
          else if (b === CR) s = QUOTE_CR;
          else s = QUOTED;
          break;
        }

        case QUOTE_CR: {
          const b = chunk[i]!;
          if (b === LF) s = LINE;
          else s = b === QUOTE ? QUOTE_SEEN : QUOTED;
          break;
        }
        default:
          return unreachable(s);
      }
      i++;
    }

    this.state = s;
  }
}
