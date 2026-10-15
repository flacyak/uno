/**
 * @fileoverview Checks when fill.ts's level loop stops at its last level,
 * where the Pages budget equals the level: `while (pages.held < level && ...)`.
 * Uses an in-memory sales file and small numbers, times nothing.
 *
 * Usage, from core/:
 *   node --import ../paths.js \
 *     tests/lab/verify/cache/stop.ts
 */

import { Pages } from '@engine';
import { layoutOf } from '../../cache/layout.ts';
import { memorySource, shapeBytes } from '../../cache/shapes.ts';

const MB = 1 << 20;
const FILE_BYTES = 8 * MB;
const LEVELS = [1 * MB, 2 * MB];

const source = memorySource(shapeBytes('sales', FILE_BYTES));
const layout = await layoutOf('sales.csv', source);
const pages = new Pages(
  'sales.csv',
  source,
  layout.format,
  layout.index,
  Math.max(...LEVELS),
);
let block = 0;
const levels: { level: number; held: number; blocksRead: number }[] = [];
for (const level of LEVELS) {
  while (pages.held < level && block < layout.blocks) {
    await pages.records(block++);
  }
  levels.push({ level, held: pages.held, blocksRead: block });
}
process.stdout.write(
  `${JSON.stringify({ blocksInFile: layout.blocks, fileBytes: source.size, levels })}\n`,
);
