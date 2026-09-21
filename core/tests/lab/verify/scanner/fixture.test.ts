/**
 * @fileoverview The 2.5 GB fixture, read as the index pass reads it: through
 * nodeSource from the format's data start in the engine's 8 MB chunks. Each
 * chunk goes to RecordScanner feeding a RowIndex, and to both wasm kernels
 * handing runs to a BulkIndex. All three must build the same blocks, with
 * offsets well past 2^31. Skipped when the fixture is absent.
 */

import { existsSync } from 'node:fs';

import { expect, test } from 'vite-plus/test';

import { RowIndex, TUNING } from '@engine/rows';
import { openFormat } from '@ingest/format';
import { nodeSource } from '@store/node';
import { BulkIndex } from '../../scanner/bulk.ts';
import { WasmScanner } from '../../scanner/wasm.ts';

const FIXTURE = '/home/hech/.cache/uno-lab/sales-q3-50m.csv';
const ROWS = 50_044_800;
const TIMEOUT_MS = 600_000;

test.skipIf(!existsSync(FIXTURE))(
  'the 2.5 GB fixture indexes the same through runs as per record',
  async () => {
    const source = await nodeSource(FIXTURE);
    try {
      const format = await openFormat('sales-q3-50m.csv', source);
      const want = new RowIndex(format.dataStart, source.size, TUNING);
      const reference = format.scanner((offset) => want.begin(offset));
      const bulks = [new BulkIndex(TUNING), new BulkIndex(TUNING)];
      const scanners = (['vectors', 'blocks'] as const).map(
        (kernel, k) =>
          new WasmScanner(
            format.delimiter,
            {
              begin: (o) => bulks[k]!.begin(o),
              many: (b, c, base) => bulks[k]!.beginMany(b, c, base),
            },
            kernel,
            'many',
          ),
      );
      for (let at = format.dataStart; at < source.size;) {
        const chunk = await source.read(
          at,
          Math.min(TUNING.chunkBytes, source.size - at),
        );
        reference.push(chunk, at);
        for (const scanner of scanners) scanner.push(chunk, at);
        at += chunk.length;
      }
      expect(want.counted).toBe(ROWS);
      const blocks = want['blocks'];
      expect(want.bytesOf(blocks - 1)[0]).toBeGreaterThan(2 ** 31);
      for (const bulk of bulks) {
        expect(bulk.counted).toBe(want.counted);
        expect(bulk.blocks).toBe(blocks);
        for (let b = 0; b < blocks; b++) {
          if (
            bulk.firstRow(b) !== want.rowsOf(b)[0] ||
            bulk.firstByte(b) !== want.bytesOf(b)[0]
          ) {
            expect([b, bulk.firstRow(b), bulk.firstByte(b)]).toEqual([
              b,
              want.rowsOf(b)[0],
              want.bytesOf(b)[0],
            ]);
          }
        }
      }
    } finally {
      await source.close();
    }
  },
  TIMEOUT_MS,
);
