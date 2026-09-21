/**
 * @fileoverview Every scanner variant by name, built against a Consumer that
 * takes begins one at a time or in runs, so the property test and the
 * benchmark drive them all the same way.
 *
 * A variant whose name ends in "-bulk" hands begins over in runs; the rest
 * call Begin once per record, as RecordScanner does.
 */

import { BaselineScanner } from './baseline.ts';
import { BatchScanner } from './batch.ts';
import type { Consumer, LabScanner } from './common.ts';
import { IndexOfScanner } from './indexof.ts';
import { SwarScanner } from './swar.ts';
import { TableScanner } from './table.ts';
import { WasmScanner } from './wasm.ts';

/** Variant is one way of scanning. */
export interface Variant {
  readonly name: string;
  readonly about: string;
  make(comma: string, consumer: Consumer): LabScanner;
}

/** The name of RecordScanner as a variant, the one the rest are timed against. */
export const BASELINE = 'record';

export const VARIANTS: readonly Variant[] = [
  {
    name: BASELINE,
    about: 'RecordScanner from core/src/ingest/scan.ts, unchanged',
    make: (comma, consumer) => new BaselineScanner(comma, consumer.begin),
  },
  {
    name: 'indexof',
    about:
      '(a) Uint8Array.prototype.indexOf in the inner loops, positions remembered',
    make: (comma, consumer) => new IndexOfScanner(comma, consumer.begin),
  },
  {
    name: 'swar',
    about: '(b) four bytes at a time through an Int32Array, zero-byte test',
    make: (comma, consumer) => new SwarScanner(comma, consumer.begin),
  },
  {
    name: 'swar-bulk',
    about:
      '(c) swar writing begins to a Float64Array, handed over 4096 at a time',
    make: (comma, consumer) => new BatchScanner(comma, consumer.many),
  },
  {
    name: 'table',
    about: '(c) one transition-table lookup per byte, no inner loops',
    make: (comma, consumer) => new TableScanner(comma, consumer.begin),
  },
  {
    name: 'wasm',
    about:
      'WebAssembly SIMD128 (wasm/scan.c): RecordScanner with 16-byte inner loops, chunk copied in 256 KB pieces',
    make: (comma, consumer) =>
      new WasmScanner(comma, consumer, 'vectors', 'each'),
  },
  {
    name: 'wasm-bulk',
    about: 'wasm, handing each piece of begins over as one run',
    make: (comma, consumer) =>
      new WasmScanner(comma, consumer, 'vectors', 'many'),
  },
  {
    name: 'wasm-blocks',
    about:
      'WebAssembly SIMD128: 64-byte LF, quote and CR masks; begins straight from the masks where no quote is near',
    make: (comma, consumer) =>
      new WasmScanner(comma, consumer, 'blocks', 'each'),
  },
  {
    name: 'wasm-blocks-bulk',
    about: 'wasm-blocks, handing each piece of begins over as one run',
    make: (comma, consumer) =>
      new WasmScanner(comma, consumer, 'blocks', 'many'),
  },
];

/** variantNamed returns the variant called `name`, or throws. */
export function variantNamed(name: string): Variant {
  const variant = VARIANTS.find((v) => v.name === name);
  if (variant === undefined) throw new Error(`no variant ${name}`);
  return variant;
}
