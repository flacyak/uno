/**
 * @fileoverview Does readAll slow down on sales rows once it has also read
 * the synthetic and wide shapes, as it has by the time the cache lab times
 * decode (measureHeap reads all three first)? Times sales, feeds the other
 * shapes through, times sales again, in one process. Taken on a busy
 * machine: compare the two phases, not the numbers with the lab's.
 */

import { collector, layoutOf } from '../../cache/layout.ts';
import type { Layout } from '../../cache/layout.ts';
import { memorySource, shapeBytes } from '../../cache/shapes.ts';
import type { ShapeName } from '../../cache/shapes.ts';

const MB = 1 << 20;
const SALES_BYTES = 16 * MB;
const OTHER_BYTES = 4 * MB;
const REPS = 3;

async function chunksOf(
  shape: ShapeName,
  size: number,
): Promise<{ layout: Layout; chunks: Uint8Array[]; total: number }> {
  const bytes = shapeBytes(shape, size);
  const layout = await layoutOf(`${shape}.csv`, memorySource(bytes));
  const chunks: Uint8Array[] = [];
  for (let b = 0; b < layout.blocks; b++) {
    const [start, end] = layout.index.bytesOf(b);
    chunks.push(bytes.subarray(start, end));
  }
  return { layout, chunks, total: chunks.reduce((n, c) => n + c.length, 0) };
}

const gc = collector();
const sales = await chunksOf('sales', SALES_BYTES);

function timeSales(): number[] {
  const out: number[] = [];
  for (let r = 0; r < REPS; r++) {
    gc();
    const t = performance.now();
    for (const c of sales.chunks) sales.layout.format.decode(c);
    out.push(Math.round(sales.total / MB / ((performance.now() - t) / 1000)));
  }
  return out;
}

const salesOnly = timeSales();
for (const shape of ['synthetic', 'wide'] as const) {
  const other = await chunksOf(shape, OTHER_BYTES);
  for (const c of other.chunks) other.layout.format.decode(c);
}
const afterOthers = timeSales();
process.stdout.write(
  `${JSON.stringify({ salesOnlyMBps: salesOnly, afterSyntheticAndWideMBps: afterOthers })}\n`,
);
