/**
 * @fileoverview A quick, independent look at Format.decode's throughput on
 * sales rows, next to a scanner that cuts fields straight out of the block
 * text by index. Taken on a busy machine: compare the two, not the numbers
 * with the lab's.
 *
 * Usage, from core/:
 *   node --experimental-transform-types --import ../paths.js \
 *     tests/lab/verify/cache/decode.ts
 */

import { collector, layoutOf } from '../../cache/layout.ts';
import { memorySource, shapeBytes } from '../../cache/shapes.ts';

const MB = 1 << 20;
const SAMPLE_BYTES = 16 * MB;
const REPS = 3;
const QUOTE = 0x22;
const COMMA = 0x2c;
const LF = 0x0a;
const CR = 0x0d;
const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * byIndex parses comma-separated records with quoted fields and doubled
 * quotes, cutting each field out of the text once. Enough for sales rows.
 */
function byIndex(text: string): string[][] {
  const out: string[][] = [];
  let rec: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let field: string;
    if (text.charCodeAt(i) === QUOTE) {
      let buf = '';
      let from = ++i;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) {
          buf += text.slice(from);
          i = n;
          break;
        }
        if (text.charCodeAt(q + 1) === QUOTE) {
          buf += text.slice(from, q + 1);
          i = from = q + 2;
          continue;
        }
        buf += text.slice(from, q);
        i = q + 1;
        break;
      }
      field = buf;
    } else {
      let j = i;
      for (; j < n; j++) {
        const c = text.charCodeAt(j);
        if (c === COMMA || c === LF) break;
      }
      const end = j > i && text.charCodeAt(j - 1) === CR ? j - 1 : j;
      field = text.slice(i, end);
      i = j;
    }
    rec.push(field);
    const c = text.charCodeAt(i);
    i++;
    if (c !== COMMA) {
      out.push(rec);
      rec = [];
    }
  }
  return out;
}

const gc = collector();
const bytes = shapeBytes('sales', SAMPLE_BYTES);
const layout = await layoutOf('sales.csv', memorySource(bytes));
const chunks: Uint8Array[] = [];
for (let b = 0; b < layout.blocks; b++) {
  const [start, end] = layout.index.bytesOf(b);
  chunks.push(bytes.subarray(start, end));
}
const total = chunks.reduce((n, c) => n + c.length, 0);

// The two parsers must agree on every cell before either is timed.
for (const chunk of chunks) {
  const a = layout.format.decode(chunk);
  const b = byIndex(UTF8.decode(chunk));
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error('parsers differ');
}

const results: Record<string, number[]> = { readAll: [], byIndex: [] };
for (let r = 0; r < REPS; r++) {
  gc();
  let t = performance.now();
  let rows = 0;
  for (const chunk of chunks) rows += layout.format.decode(chunk).length;
  results.readAll!.push(total / MB / ((performance.now() - t) / 1000));
  gc();
  t = performance.now();
  for (const chunk of chunks) rows -= byIndex(UTF8.decode(chunk)).length;
  results.byIndex!.push(total / MB / ((performance.now() - t) / 1000));
  if (rows !== 0) throw new Error('row counts differ');
}
const mbps = (xs: number[]): number[] => xs.map((x) => Math.round(x));
process.stdout.write(
  `${JSON.stringify({ mb: Math.round(total / MB), readAllMBps: mbps(results.readAll!), byIndexMBps: mbps(results.byIndex!) })}\n`,
);
