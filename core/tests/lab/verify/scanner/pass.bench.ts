/**
 * @fileoverview Times the whole index pass, reads included, with each
 * scanner: indexPass from core/src/engine/pass.ts itself ('stock'), and the
 * same loop line for line with RecordScanner, RecordScanner handing runs to
 * BulkIndex, and the two wasm kernels handing runs to BulkIndex. One fresh
 * process per sample, so every scanner starts with a cold JIT as a newly
 * opened workspace's engine does; the file's pages stay cached between
 * samples unless dropped outside.
 *
 * From core/, alone on a quiet machine:
 *   node --experimental-transform-types --import ../paths.js \
 *     tests/lab/verify/scanner/pass.bench.ts [--file PATH] [--samples 3]
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { indexPass } from '@engine/pass';
import { RowIndex, TUNING } from '@engine/rows';
import { openFormat } from '@ingest/format';
import { nodeSource } from '@store/node';
import { BulkIndex } from '../../scanner/bulk.ts';
import type { LabScanner } from '../../scanner/common.ts';
import { WasmScanner } from '../../scanner/wasm.ts';
import { RecordBulkScanner } from './recordbulk.ts';

const DIGITS = 1;
const VARIANTS = [
  'stock',
  'record',
  'record-bulk',
  'wasm-bulk',
  'wasm-blocks-bulk',
] as const;
type VariantName = (typeof VARIANTS)[number];

const { values } = parseArgs({
  options: {
    child: { type: 'boolean', default: false },
    variant: { type: 'string', default: '' },
    file: {
      type: 'string',
      default: '/home/hech/.cache/uno-lab/sales-q3-50m.csv',
    },
    samples: { type: 'string', default: '3' },
  },
});

/** child runs one pass and returns its milliseconds and record count. */
async function child(name: VariantName): Promise<[number, number]> {
  const source = await nodeSource(values.file);
  try {
    const format = await openFormat(values.file, source);
    const index = new RowIndex(format.dataStart, source.size, TUNING);
    const bulk = new BulkIndex(TUNING);
    const started = performance.now();
    if (name === 'stock') {
      await indexPass({
        source,
        format,
        index,
        tuning: TUNING,
        signal: new AbortController().signal,
        progress: () => {},
      });
      return [performance.now() - started, index.counted];
    }
    const many = {
      begin: (o: number) => bulk.begin(o),
      many: bulk.beginMany.bind(bulk),
    };
    const scanner: { push(chunk: Uint8Array, at: number): void } =
      name === 'record'
        ? format.scanner((offset) => index.begin(offset))
        : name === 'record-bulk'
          ? new RecordBulkScanner(format.delimiter, many.many)
          : (new WasmScanner(
              format.delimiter,
              many,
              name === 'wasm-bulk' ? 'vectors' : 'blocks',
              'many',
            ) satisfies LabScanner);
    // indexPass's loop, pass.ts:33-44, with the scanner swapped.
    for (let at = format.dataStart; at < source.size;) {
      const chunk = await source.read(
        at,
        Math.min(TUNING.chunkBytes, source.size - at),
      );
      if (chunk.length === 0) break;
      scanner.push(chunk, at);
      at += chunk.length;
      index.scanned = at;
    }
    return [performance.now() - started, index.counted + bulk.counted];
  } finally {
    await source.close();
  }
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

if (values.child) {
  const name = values.variant as VariantName;
  process.stdout.write(`${JSON.stringify(await child(name))}\n`);
} else {
  const samples = Number(values.samples);
  const results = VARIANTS.map((variant) => {
    const runs: Array<[number, number]> = [];
    for (let i = 0; i < samples; i++) {
      const done = spawnSync(
        process.execPath,
        [
          ...process.execArgv,
          fileURLToPath(import.meta.url),
          '--child',
          '--variant',
          variant,
          '--file',
          values.file,
        ],
        { encoding: 'utf8' },
      );
      if (done.status !== 0) throw new Error(`${variant}:\n${done.stderr}`);
      const lines = done.stdout.trim().split('\n');
      runs.push(JSON.parse(lines[lines.length - 1]!) as [number, number]);
    }
    return { variant, ms: runs.map((r) => r[0]), records: runs[0]![1] };
  });
  const records = results[0]!.records;
  const stock = median(results[0]!.ms);
  for (const r of results) {
    if (r.records !== records)
      throw new Error(`${r.variant}: ${r.records} records`);
    const med = median(r.ms);
    process.stdout.write(
      `${r.variant.padEnd(18)} ${med.toFixed(DIGITS).padStart(8)} ms  ` +
        `${(stock / med).toFixed(2)}x  [${r.ms.map((x) => x.toFixed(DIGITS)).join(', ')}]\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ suite: 'verify-scanner-pass', file: values.file, records, results })}\n`,
  );
}
