/**
 * @fileoverview Feeds a file to a scanner in chunks, and decodes it in runs
 * cut at the records the scanner found, as the engine does. The ingest tests
 * that hold a scanner to the splitter it stands in for share it.
 */

import type { Scanner } from '@ingest/format';
import { bomLength } from '@ingest/scan';

/** Decodes the first run, which drops a byte order mark. */
const first = new TextDecoder('utf-8');
/** Decodes every later run, where a U+FEFF is data. */
const later = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * starts returns the record start offsets a scanner made by `scanner`
 * reports when fed `bytes` past their byte order mark, `chunk` bytes at a
 * time.
 */
export function starts(
  scanner: (begin: (offset: number) => void) => Scanner,
  bytes: Uint8Array,
  chunk: number,
): number[] {
  const out: number[] = [];
  const s = scanner((offset) => out.push(offset));
  for (let at = bomLength(bytes); at < bytes.length; at += chunk) {
    s.push(bytes.subarray(at, Math.min(at + chunk, bytes.length)), at);
  }
  return out;
}

/**
 * piecewise reads `bytes` the way the engine does: it cuts them at every
 * `every`th of the record starts `begins`, decodes and splits each run on
 * its own with `split`, and returns the records of every run in order.
 */
export function piecewise<T>(
  bytes: Uint8Array,
  begins: readonly number[],
  every: number,
  split: (text: string) => T[],
): T[] {
  const cuts = [0];
  for (let i = every; i < begins.length; i += every) cuts.push(begins[i]!);
  cuts.push(bytes.length);

  const records: T[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const decoder = i === 0 ? first : later;
    records.push(
      ...split(decoder.decode(bytes.subarray(cuts[i], cuts[i + 1]))),
    );
  }
  return records;
}
