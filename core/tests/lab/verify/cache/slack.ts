/**
 * @fileoverview How much of a decoded sales block's heap is spare array
 * capacity: the same records kept as decoded, then as copies made several
 * ways. Measures memory only.
 */

import { collector, heapUsed, layoutOf } from '../../cache/layout.ts';
import { memorySource, shapeBytes } from '../../cache/shapes.ts';

const MB = 1 << 20;
const SAMPLE_BYTES = 8 * MB;

const COPIES: Record<string, (rec: string[]) => string[]> = {
  asDecoded: (rec) => rec,
  slice: (rec) => rec.slice(),
  newArray: (rec) => {
    const a = new Array<string>(rec.length);
    for (let j = 0; j < rec.length; j++) a[j] = rec[j]!;
    return a;
  },
};

const gc = collector();
const bytes = shapeBytes('sales', SAMPLE_BYTES);
const source = memorySource(bytes);
const layout = await layoutOf('sales.csv', source);
/** weigh keeps every block's records copied by `copy` and returns heap per source byte. */
async function weigh(copy: (rec: string[]) => string[]): Promise<number> {
  gc();
  const before = heapUsed();
  const blocks: string[][][] = [];
  for (let b = 0; b < layout.blocks; b++) {
    const [start, end] = layout.index.bytesOf(b);
    const records = layout.format.decode(await source.read(start, end - start));
    const kept = new Array<string[]>(records.length);
    for (let i = 0; i < records.length; i++) kept[i] = copy(records[i]!);
    blocks.push(kept);
  }
  gc();
  const used = heapUsed() - before;
  if (blocks.length !== layout.blocks) throw new Error('lost a block');
  return Number((used / bytes.length).toFixed(2));
}

const out: Record<string, number> = {};
// Each variant twice, in turn, so one left alive by a stack slot shows up.
for (let pass = 0; pass < 2; pass++) {
  for (const [how, copy] of Object.entries(COPIES)) {
    out[`${how}${pass}`] = await weigh(copy);
  }
}
process.stdout.write(`${JSON.stringify({ pc: (process.config.variables as Record<string, unknown>)['v8_enable_pointer_compression'], heapPerSourceByte: out })}\n`);
