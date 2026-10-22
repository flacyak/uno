/**
 * @fileoverview What Pages.records(block, false), the call find and the
 * survey make, does to the cache: a miss is decoded and dropped, a hit is
 * served from the cache and moved to the newest end. Times nothing.
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
const [s0, e0] = layout.index.bytesOf(0);
const [s1, e1] = layout.index.bytesOf(1);
// Room for blocks 0 and 1, and no more.
const pages = new Pages('sales.csv', counted, layout.format, layout.index, e0 - s0 + (e1 - s1));

for (let b = 0; b < layout.blocks; b++) await pages.records(b, false);
const afterFindOverAll = { held: pages.held, reads };

reads = 0;
const zero = await pages.records(0);
await pages.records(1);
const keptReads = reads;
reads = 0;
const zeroAgain = await pages.records(0, false); // a hit, moves 0 to newest
const hitReads = reads;
await pages.records(2); // evicts the oldest, which is now 1
reads = 0;
await pages.records(0);
const zeroStillCached = reads === 0;
await pages.records(1);
const oneEvicted = reads === 1;
process.stdout.write(
  `${JSON.stringify({ blocks: layout.blocks, afterFindOverAll, keptReads, hitSameArray: zero === zeroAgain, hitReads, zeroStillCached, oneEvicted })}\n`,
);
