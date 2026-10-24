/**
 * @fileoverview A file's blocks laid out the way the engine lays them out,
 * found by running the engine's own index pass with the default Tuning, and
 * a way to call the garbage collector from a test or a script.
 *
 * The lab's TUNING variants change cacheBytes alone, so this layout is the
 * one every variant's engine builds.
 */

import v8 from 'node:v8';
import vm from 'node:vm';

import { RowIndex, TUNING, indexPass } from '@engine';
import { openFormat } from '@ingest';
import type { Format } from '@ingest';
import type { ByteSource } from '@store';

/** Layout is a file's format, its finished row index and its block count. */
export interface Layout {
  readonly format: Format;
  readonly index: RowIndex;
  readonly blocks: number;
}

/** layoutOf reads the whole source once and returns its block layout. */
export async function layoutOf(
  name: string,
  source: ByteSource,
): Promise<Layout> {
  const format = await openFormat(name, source);
  const index = new RowIndex(format.dataStart, source.size, TUNING);
  await indexPass({
    source,
    format,
    index,
    tuning: TUNING,
    signal: new AbortController().signal,
    progress: () => undefined,
  });
  const blocks = index.counted === 0 ? 0 : index.blockOf(index.counted - 1) + 1;
  return { format, index, blocks };
}

/** blocksOf lists the blocks holding rows [first, first + count). */
export function blocksOf(
  index: RowIndex,
  first: number,
  count: number,
): number[] {
  const last = Math.min(first + count, index.readable()) - 1;
  const out: number[] = [];
  for (let b = index.blockOf(first); b <= index.blockOf(last); b++) out.push(b);
  return out;
}

/** collector turns on gc and returns it, as tests/efficiency/index.test.ts does. */
export function collector(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

/** Bytes the V8 heap holds now. */
export function heapUsed(): number {
  return v8.getHeapStatistics().used_heap_size;
}
