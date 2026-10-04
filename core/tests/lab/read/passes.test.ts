/**
 * @fileoverview The read lab's passes build the same index the engine's
 * indexPass builds, at any chunk size, with any reads in flight and any
 * buffers. A reused buffer is never read into while the pass holds it, and
 * the engine runner counts every row.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { RowIndex, indexPass } from '@engine';
import type { Tuning } from '@engine';
import { openFormat } from '@ingest';
import type { Format } from '@ingest';
import type { ByteSource } from '@store';
import { nodeSource } from '@store/node';
import { TINY } from '@core-tests/engine/harness';
import { ROWS, repeated } from '@core-tests/testdata/sales-q3';

import { engineRun } from './engine.ts';
import { chunks, pipePass, splitPass, withReadAhead } from './passes.ts';
import { BUFFERS, openReader } from './reader.ts';

/** Copies of the sales fixture in the first file. */
const SALES_REPEATS = 2;
/** Rows in the synthetic file. */
const SYNTHETIC_ROWS = 2000;
/** One in this many synthetic rows has a newline inside quotes, one in CRLF_EVERY ends in CRLF. */
const NEWLINE_EVERY = 7;
const CRLF_EVERY = 5;
const CITIES = ['Lagos', 'Malmö', 'São Paulo', '東京', 'Lyon'];

/** Reads kept in flight that the passes are checked with. */
const IN_FLIGHT = [0, 1, 2, 3];
/** readAhead depths, 1 being no read-ahead at all. */
const AHEADS = [1, 2, 3, 4];
/** A prime number of bytes, a few records long, so chunks split records everywhere. */
const ODD_CHUNK = 251;
const PAGE_CHUNK = 4096;
const LARGE_CHUNK = 1 << 16;
/** The tests that sweep every plan make thousands of reads. */
const SLOW_MS = 60_000;

/** synthetic is a CSV with quoted commas, quoted newlines, CRLF rows and multi-byte characters. */
function synthetic(): string {
  let out = 'id,customer,note,city\n';
  for (let i = 0; i < SYNTHETIC_ROWS; i++) {
    const note =
      i % NEWLINE_EVERY === 0 ? '"two\nlines, and a comma"' : 'plain';
    const end = i % CRLF_EVERY === 0 ? '\r\n' : '\n';
    out += `${i},"Okafor, Ada",${note},${CITIES[i % CITIES.length]}${end}`;
  }
  return out;
}

/** same is whether two arrays hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(a, b) === 0;
}

/** An index's blocks as [first row, end row, start byte, end byte], plus its counts. */
function shape(index: RowIndex): unknown {
  const blocks: number[][] = [];
  if (index.counted > 0) {
    const last = index.blockOf(index.counted - 1);
    for (let b = 0; b <= last; b++)
      blocks.push([...index.rowsOf(b), ...index.bytesOf(b)]);
  }
  return {
    counted: index.counted,
    scanned: index.scanned,
    complete: index.complete,
    blocks,
  };
}

interface Case {
  name: string;
  path: string;
  size: number;
  format: Format;
  /** The index the engine's own indexPass builds. */
  want: unknown;
  chunkSizes: number[];
}

let folder = '';
const cases: Case[] = [];

/** stockIndex runs the engine's indexPass over the file and returns its index. */
async function stockIndex(
  source: ByteSource,
  format: Format,
  tuning: Tuning,
): Promise<RowIndex> {
  const index = new RowIndex(format.dataStart, source.size, tuning);
  await indexPass({
    source,
    format,
    index,
    tuning,
    signal: new AbortController().signal,
    progress: () => undefined,
  });
  return index;
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'uno-lab-read-'));
  const files: Array<[string, Uint8Array, number[]]> = [
    [
      'sales.csv',
      repeated(SALES_REPEATS),
      [ODD_CHUNK, PAGE_CHUNK, LARGE_CHUNK],
    ],
    [
      'synthetic.csv',
      new TextEncoder().encode(synthetic()),
      [ODD_CHUNK, PAGE_CHUNK, LARGE_CHUNK],
    ],
    // A byte order mark, a blank line, and no newline at the end.
    [
      'edges.csv',
      new TextEncoder().encode('﻿a,b\n1,"x\r\ny"\n\n2,3'),
      [1, 2, 3],
    ],
  ];
  for (const [name, bytes, sizes] of files) {
    const path = join(folder, name);
    await writeFile(path, bytes);
    const source = await nodeSource(path);
    try {
      const format = await openFormat(name, source);
      const index = await stockIndex(source, format, {
        ...TINY,
        chunkBytes: PAGE_CHUNK,
      });
      cases.push({
        name,
        path,
        size: bytes.length,
        format,
        want: shape(index),
        // One chunk larger than the file reads it whole.
        chunkSizes: [...sizes, bytes.length + 1],
      });
    } finally {
      await source.close();
    }
  }
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe(
  'the lab passes build the index indexPass builds',
  { timeout: SLOW_MS },
  () => {
    test('splitPass, over the source as it is and under readAhead', async () => {
      for (const c of cases) {
        for (const chunkBytes of c.chunkSizes) {
          for (const depth of AHEADS) {
            const raw = await nodeSource(c.path);
            try {
              const source = withReadAhead(raw, depth);
              const index = new RowIndex(c.format.dataStart, raw.size, TINY);
              await splitPass(source, c.format, index, chunkBytes);
              expect(
                shape(index),
                `${c.name}, chunk ${chunkBytes}, ahead ${depth}`,
              ).toEqual(c.want);
            } finally {
              await raw.close();
            }
          }
        }
      }
    });

    test('pipePass, with any reads in flight and any buffers', async () => {
      for (const c of cases) {
        const reader = await openReader(c.path);
        try {
          for (const chunkBytes of c.chunkSizes) {
            for (const inFlight of IN_FLIGHT) {
              for (const buffers of BUFFERS) {
                const index = new RowIndex(
                  c.format.dataStart,
                  reader.size,
                  TINY,
                );
                const plan = { chunkBytes, inFlight, buffers, scan: true };
                const times = await pipePass(reader, c.format, index, plan);
                const label = `${c.name}, ${JSON.stringify(plan)}`;
                expect(shape(index), label).toEqual(c.want);
                expect(times.bytes, label).toBe(c.size - c.format.dataStart);
              }
            }
          }
        } finally {
          await reader.close();
        }
      }
    });

    test('pipePass reads every byte and scans none when told only to read', async () => {
      const c = cases[0]!;
      const reader = await openReader(c.path);
      try {
        const index = new RowIndex(c.format.dataStart, reader.size, TINY);
        const plan = {
          chunkBytes: PAGE_CHUNK,
          inFlight: 3,
          buffers: 'reused' as const,
          scan: false,
        };
        const times = await pipePass(reader, c.format, index, plan);
        expect(times.bytes).toBe(c.size - c.format.dataStart);
        expect(times.records).toBe(0);
      } finally {
        await reader.close();
      }
    });
  },
);

describe('chunks', { timeout: SLOW_MS }, () => {
  test('a chunk it hands over is not read into until the next is asked for', async () => {
    const c = cases[0]!;
    const bytes = repeated(SALES_REPEATS);
    const reader = await openReader(c.path);
    try {
      for (const inFlight of IN_FLIGHT) {
        const plan = {
          chunkBytes: PAGE_CHUNK,
          inFlight,
          buffers: 'reused' as const,
        };
        let at = 0;
        for await (const chunk of chunks(reader, 0, plan)) {
          expect(chunk.offset).toBe(at);
          const want = bytes.subarray(at, at + chunk.bytes.length);
          expect(same(chunk.bytes, want), `chunk at ${at}`).toBe(true);
          // Let the reads in flight land. None of them may land here.
          await tick();
          await tick();
          expect(same(chunk.bytes, want), `chunk at ${at}, later`).toBe(true);
          at += chunk.bytes.length;
        }
        expect(at).toBe(bytes.length);
      }
    } finally {
      await reader.close();
    }
  });

  test('leaving early waits for the reads in flight', async () => {
    const c = cases[0]!;
    const reader = await openReader(c.path);
    const plan = {
      chunkBytes: PAGE_CHUNK,
      inFlight: 3,
      buffers: 'reused' as const,
    };
    for await (const chunk of chunks(reader, 0, plan)) {
      expect(chunk.offset).toBe(0);
      break;
    }
    await reader.close();
  });
});

describe('the engine runner', () => {
  for (const ahead of AHEADS.slice(0, 2)) {
    test(`counts every row, with readAhead ${ahead}`, async () => {
      const c = cases[0]!;
      const times = await engineRun(c.path, ahead, {
        ...TINY,
        chunkBytes: PAGE_CHUNK,
      });
      expect(times.records).toBe(SALES_REPEATS * ROWS);
      expect(times.passReads).toBeGreaterThan(0);
      expect(times.readFactor).toBeGreaterThanOrEqual(1);
      expect(times.totalMs).toBeGreaterThanOrEqual(times.engineMs);
    });
  }
});
