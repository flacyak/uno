/**
 * @fileoverview Heap per source byte of a decoded block, through the cache
 * lab's own heapPerSourceByte, for the lab's sales shape and for shapes it
 * did not try. slack.ts measures spare array capacity. Measures memory only.
 *
 * Usage, from core/ (plain node, then Electron's runtime):
 *   node --experimental-transform-types --import ../paths.js \
 *     tests/lab/verify/cache/ratio.ts
 *   ELECTRON_RUN_AS_NODE=1 ../apps/desktop/node_modules/electron/dist/electron \
 *     --experimental-transform-types --import ../paths.js \
 *     tests/lab/verify/cache/ratio.ts
 */

import v8 from 'node:v8';

import { heapPerSourceByte } from '../../cache/heap.ts';
import { collector } from '../../cache/layout.ts';
import { shapeBytes } from '../../cache/shapes.ts';

const MB = 1 << 20;
const SAMPLE_BYTES = 8 * MB;
const encoder = new TextEncoder();

/** Rows of `row(i)` under `header` until SAMPLE_BYTES. */
function made(header: string, row: (i: number) => string): Uint8Array {
  const parts: string[] = [header];
  let n = header.length;
  for (let i = 0; n < SAMPLE_BYTES; i++) {
    const r = row(i);
    parts.push(r);
    n += r.length;
  }
  return encoder.encode(parts.join(''));
}

const ASCII_40 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const KANJI_20 = '東京大阪名古屋札幌福岡神戸京都横浜仙台広島';

const SHAPES: Record<string, () => Uint8Array> = {
  sales: () => shapeBytes('sales', SAMPLE_BYTES),
  synthetic: () => shapeBytes('synthetic', SAMPLE_BYTES),
  wide: () => shapeBytes('wide', SAMPLE_BYTES),
  // One column of six-digit ids: 7 bytes a row.
  ids: () => made('id\n', (i) => `${100000 + (i % 900000)}\n`),
  // Two columns of two digits: 6 bytes a row.
  pairs: () =>
    made('a,b\n', (i) => `${10 + (i % 90)},${10 + ((i * 7) % 90)}\n`),
  // Two 40-character ASCII fields: 13 characters or more, so sliced strings.
  text: () =>
    made(
      'id,title,note\n',
      (i) => `${i},${ASCII_40},${ASCII_40.slice(i % 5)}\n`,
    ),
  // A 20-character non-Latin-1 field: two-byte text.
  kanji: () => made('id,city\n', (i) => `${i},${KANJI_20.slice(i % 3)}\n`),
};

const gc = collector();
const out: Record<string, unknown> = {
  node: process.version,
  electron: process.versions['electron'] ?? null,
  pointerCompression:
    (process.config.variables as Record<string, unknown>)[
      'v8_enable_pointer_compression'
    ] ?? null,
  heapSizeLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / MB),
};
for (const [shape, make] of Object.entries(SHAPES)) {
  const bytes = make();
  const r = await heapPerSourceByte(`${shape}.csv`, bytes, SAMPLE_BYTES, gc);
  out[shape] = {
    heapPerSourceByte: Number(r.ratio.toFixed(2)),
    textPerSourceByte: Number(r.textRatio.toFixed(2)),
    sourceBytesPerRow: Number((r.heldBytes / r.rows).toFixed(1)),
    fieldsPerRow: Number((r.fields / r.rows).toFixed(1)),
    heapPerRow: Number((r.heapBytes / r.rows).toFixed(1)),
    defaultCacheHeapMB: Math.round(r.ratio * 32),
  };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
