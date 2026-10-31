/**
 * @fileoverview What Pages.records(block, false), the call find and the
 * survey make, does to the cache: a miss is decoded and dropped, a hit is
 * served from the cache and left where it is. Times nothing.
 */

import { Pages } from '@engine';
import { layoutOf } from '../../cache/layout.ts';
import { memorySource, shapeBytes } from '../../cache/shapes.ts';

const MB = 1 << 20;
const source = memorySource(shapeBytes('sales', 2 * MB));
const layout = await layoutOf('sales.csv', source);
let reads = 0;
const counted = {
  ...source,
  read: (offset: number, length: number) => {
    reads++;
    return source.read(offset, length);
  },
};
const size = (block: number): number => {
  const [start, end] = layout.index.bytesOf(block);
  return end - start;
};
// Room for block 1 and either of blocks 0 and 2, and no more.
const pages = new Pages(
  'sales.csv',
  counted,
  layout.format,
  layout.index,
  size(1) + Math.max(size(0), size(2)),
);

for (let b = 0; b < layout.blocks; b++) await pages.records(b, false);
const afterFindOverAll = { held: pages.held, reads };

reads = 0;
const zero = await pages.records(0);
await pages.records(1);
const keptReads = reads;
reads = 0;
const zeroAgain = await pages.records(0, false); // a hit, leaves 0 the oldest
const hitReads = reads;
await pages.records(2); // evicts the oldest, which is still 0
reads = 0;
await pages.records(1);
const oneStillCached = reads === 0;
await pages.records(0);
const zeroEvicted = reads === 1;
process.stdout.write(
  `${JSON.stringify({ blocks: layout.blocks, afterFindOverAll, keptReads, hitSameArray: zero === zeroAgain, hitReads, oneStillCached, zeroEvicted })}\n`,
);
