/**
 * @fileoverview For the parent to run alone, on a quiet machine: does one
 * thread, with the next read in flight and the WebAssembly SIMD scanner,
 * reach the cold read limit the parallel lab's 8 workers reached?
 *
 * Four passes over one file, each in its own sample loop, all on one thread:
 *
 * - stock: core's indexPass over nodeSource, as the engine runs it today.
 * - overlap: the same RecordScanner and RowIndex, with the next read issued
 *   before the scan of the current chunk.
 * - wasm: the scanner lab's wasm-blocks-bulk kernel into its BulkIndex, with
 *   the next read in flight the same way.
 * - readonly: the reads alone, the floor any pass can reach.
 *
 * Every pass must count the same records and open the same blocks as stock,
 * or the run throws.
 *
 * Run from core/:
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     --expose-gc --import ../paths.js tests/lab/verify/critic/wasm-pass.ts \
 *     [--path /home/hech/.cache/uno-lab/sales-q3-50m.csv] [--samples 3] \
 *     [--cache warm|cold] [--check]
 *
 * `--check` runs each pass once over the 96 MB read lab file and prints only
 * whether the counts agree, no times.
 */

import { basename } from 'node:path';

import { RowIndex, TUNING, indexPass } from '@engine';
import type { PassContext } from '@engine';
import { openFormat } from '@ingest';
import type { Format } from '@ingest';
import type { ByteSource } from '@store';
import { nodeSource } from '@store/node';

import {
  drop,
  repeatedFile,
  resident,
  FULL_REPEATS,
} from '../../read/fixture.ts';
import { BulkIndex } from '../../scanner/bulk.ts';
import { WasmScanner } from '../../scanner/wasm.ts';

/** The 2.5 GB fixture the labs read. */
const BIG = '/home/hech/.cache/uno-lab/sales-q3-50m.csv';
const DEFAULT_SAMPLES = 3;

type PassName = 'stock' | 'overlap' | 'wasm' | 'readonly';
const PASSES: readonly PassName[] = ['stock', 'overlap', 'wasm', 'readonly'];

/** What one pass found, and how long it took. */
interface Outcome {
  ms: number;
  records: number;
  blocks: number;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

/**
 * overlapped calls `each` for every chunk from `start` to the end, with the
 * next chunk's read already issued when `each` runs.
 */
async function overlapped(
  source: ByteSource,
  start: number,
  each: (chunk: Uint8Array, at: number) => void,
): Promise<void> {
  const { chunkBytes } = TUNING;
  const readAt = (at: number): Promise<Uint8Array> =>
    source.read(at, Math.min(chunkBytes, source.size - at));
  let at = start;
  let next = at < source.size ? readAt(at) : undefined;
  while (next !== undefined) {
    const chunk = await next;
    if (chunk.length === 0) break;
    const after = at + chunk.length;
    next = after < source.size ? readAt(after) : undefined;
    each(chunk, at);
    at = after;
  }
}

async function runPass(
  name: PassName,
  source: ByteSource,
  format: Format,
): Promise<Outcome> {
  const started = performance.now();
  switch (name) {
    case 'stock': {
      const index = new RowIndex(format.dataStart, source.size, TUNING);
      const ctx: PassContext = {
        source,
        format,
        index,
        tuning: TUNING,
        signal: new AbortController().signal,
        progress: () => undefined,
      };
      await indexPass(ctx);
      return {
        ms: performance.now() - started,
        records: index.counted,
        blocks: blocksOf(index),
      };
    }
    case 'overlap': {
      const index = new RowIndex(format.dataStart, source.size, TUNING);
      const scanner = format.scanner((offset) => index.begin(offset));
      await overlapped(source, format.dataStart, (chunk, at) =>
        scanner.push(chunk, at),
      );
      return {
        ms: performance.now() - started,
        records: index.counted,
        blocks: blocksOf(index),
      };
    }
    case 'wasm': {
      const bulk = new BulkIndex(TUNING);
      const scanner = new WasmScanner(
        format.delimiter,
        {
          begin: (offset) => bulk.begin(offset),
          many: (begins, count, base) => bulk.beginMany(begins, count, base),
        },
        'blocks',
        'many',
      );
      await overlapped(source, format.dataStart, (chunk, at) =>
        scanner.push(chunk, at),
      );
      return {
        ms: performance.now() - started,
        records: bulk.counted,
        blocks: bulk.blocks,
      };
    }
    case 'readonly': {
      let bytes = 0;
      await overlapped(source, format.dataStart, (chunk) => {
        bytes += chunk.length;
      });
      return { ms: performance.now() - started, records: -1, blocks: bytes };
    }
    default: {
      const never: never = name;
      throw new Error(`unknown pass ${String(never)}`);
    }
  }
}

/** blocksOf is how many blocks a RowIndex opened: the last row's block, plus one. */
function blocksOf(index: RowIndex): number {
  return index.counted === 0 ? 0 : index.blockOf(index.counted - 1) + 1;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const path = check ? repeatedFile(FULL_REPEATS) : (flag('--path') ?? BIG);
  const samples = check ? 1 : Number(flag('--samples') ?? DEFAULT_SAMPLES);
  const cache = flag('--cache') ?? 'warm';
  const source = await nodeSource(path);
  try {
    const format = await openFormat(basename(path), source);
    // Warm the code on every pass once before any sample counts.
    const want = await runPass('stock', source, format);
    for (const name of PASSES) {
      const got = await runPass(name, source, format);
      if (name !== 'readonly' && got.records !== want.records) {
        throw new Error(
          `${name}: ${got.records} records, stock ${want.records}`,
        );
      }
      if (name !== 'readonly' && got.blocks !== want.blocks) {
        throw new Error(`${name}: ${got.blocks} blocks, stock ${want.blocks}`);
      }
    }
    if (check) {
      process.stdout.write(
        `[critic] every pass agrees: ${want.records} records, ${want.blocks} blocks\n`,
      );
      return;
    }
    const out: Record<string, number[]> = {};
    for (const name of PASSES) {
      out[name] = [];
      for (let i = 0; i < samples; i++) {
        if (cache === 'cold') drop(path);
        const before = resident(path) / source.size;
        globalThis.gc?.();
        const got = await runPass(name, source, format);
        out[name]!.push(got.ms);
        process.stderr.write(
          `[critic] ${cache} ${name}: ${got.ms.toFixed(1)} ms, cached before ${before.toFixed(3)}\n`,
        );
      }
    }
    process.stdout.write(`${JSON.stringify({ path, cache, samples: out })}\n`);
  } finally {
    await source.close();
  }
}

await main();
