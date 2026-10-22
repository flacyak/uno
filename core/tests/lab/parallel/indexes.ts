/**
 * @fileoverview Builds a RowIndex both ways, sequential and parallel, and
 * says where two of them differ. Shared by the tests and the benchmark.
 */

import { RowIndex, indexPass } from '@engine';
import type { PassContext, Tuning } from '@engine';
import type { Format } from '@ingest';
import type { ByteSource } from '@store';
import { parallelIndexPass } from './pass.ts';
import type { ChunkScanner, Plan } from './pass.ts';

/** contextFor returns a pass context over a fresh index that is never aborted. */
export function contextFor(
  source: ByteSource,
  format: Format,
  tuning: Tuning,
): PassContext {
  return {
    source,
    format,
    index: new RowIndex(format.dataStart, source.size, tuning),
    tuning,
    signal: new AbortController().signal,
    progress: () => undefined,
  };
}

/** sequentialIndex builds an index with core's indexPass. */
export async function sequentialIndex(
  source: ByteSource,
  format: Format,
  tuning: Tuning,
): Promise<RowIndex> {
  const ctx = contextFor(source, format, tuning);
  await indexPass(ctx);
  return ctx.index;
}

/** parallelIndex builds an index with the parallel pass. */
export async function parallelIndex(
  source: ByteSource,
  format: Format,
  tuning: Tuning,
  scanner: ChunkScanner,
  plan: Plan,
): Promise<RowIndex> {
  const ctx = contextFor(source, format, tuning);
  await parallelIndexPass(ctx, scanner, plan);
  return ctx.index;
}

/** blockCount is how many blocks an index holds, read through its public methods. */
export function blockCount(index: RowIndex): number {
  return index.counted === 0 ? 0 : index.blockOf(index.counted - 1) + 1;
}

/**
 * difference names the first way two indexes differ, or returns undefined
 * when they agree on every block's first row and offset, the count, the
 * bytes scanned and whether the scan completed.
 */
export function difference(a: RowIndex, b: RowIndex): string | undefined {
  const facts: Array<[string, number | boolean, number | boolean]> = [
    ['start', a.start, b.start],
    ['size', a.size, b.size],
    ['counted', a.counted, b.counted],
    ['scanned', a.scanned, b.scanned],
    ['complete', a.complete, b.complete],
    ['blocks', blockCount(a), blockCount(b)],
  ];
  for (const [name, x, y] of facts) {
    if (x !== y) return `${name}: ${String(x)} against ${String(y)}`;
  }
  for (let block = 0; block < blockCount(a); block++) {
    const [firstA] = a.rowsOf(block);
    const [firstB] = b.rowsOf(block);
    const [offsetA] = a.bytesOf(block);
    const [offsetB] = b.bytesOf(block);
    if (firstA !== firstB || offsetA !== offsetB) {
      return `block ${block}: row ${firstA} at ${offsetA} against row ${firstB} at ${offsetB}`;
    }
  }
  return undefined;
}
