/**
 * @fileoverview Measures the index pass over a 200 MB synthetic CSV: bytes read
 * to sniff, read and scan time, heap kept per row, and the time to answer a
 * window asked for mid-pass. The CSV has quoted commas, quoted newlines, CRLF
 * rows and multi-byte characters. It is written to the temp directory once.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { RowIndex, TUNING } from '@engine';
import type { Engine } from '@engine';
import { peekFormat } from '@ingest';
import { diskProvider, nodeSource } from '@store/node';
import { SCREEN, connect, indexed, openOne } from '@core-tests/engine/harness';
import { record } from './record.ts';
import type { Metric } from './record.ts';
import { collector, countNewlines, counted, writeOnce } from './synthetic.ts';
import type { Synthetic } from './synthetic.ts';

/** The file's size, give or take the last batch of rows. */
const FILE_BYTES = 200 << 20;
/** Where the file is written, named for its size. */
const FILE = join(tmpdir(), `uno-index-${FILE_BYTES}.csv`);

/** One in this many rows has a newline inside a quoted field. */
const NEWLINE_EVERY = 7;
/** One in this many rows ends in CRLF. */
const CRLF_EVERY = 5;
/** One in this many rows has a multi-byte character. */
const WIDE_EVERY = 3;

const HEADER = 'id,customer,note,amount,city\n';
const CUSTOMERS = [
  '"Okafor, Ada"',
  'Lindqvist',
  '"Diaz ""Pepe"" Ruiz"',
  'Nakamura',
];
const CITIES = ['Lagos', 'Malmö', 'São Paulo', '東京', 'Lyon'];

/** Bytes in a megabyte. */
const MB = 1 << 20;
/** Milliseconds in a second. */
const SECOND_MS = 1000;

/** The least MB per second the scan, and the whole pass, must manage. */
const THROUGHPUT_FLOOR_MB_S = 150;
/**
 * The most scan time may be, as a multiple of a loop that only counts
 * newlines in the same bytes.
 */
const SCAN_OVER_COUNT_BUDGET = 3;
/** The most heap bytes the index may keep per row. */
const HEAP_PER_ROW_BUDGET = 1;
/** The most bytes a sniff may read to pick a delimiter and find the header. */
const SNIFF_BYTES_BUDGET = 64 << 10;
/**
 * The most a window asked for mid-pass may wait, as a fraction of the whole
 * pass.
 */
const WINDOW_WAIT_FRACTION = 0.1;

/** rows yields the file's rows, the same on every machine. */
function* rows(): Generator<string> {
  for (let i = 0; ; i++) {
    const customer = CUSTOMERS[i % CUSTOMERS.length]!;
    const note =
      i % NEWLINE_EVERY === 0
        ? '"first line\nsecond line, with a comma"'
        : i % WIDE_EVERY === 0
          ? 'naïve café'
          : 'plain';
    const city = CITIES[i % CITIES.length]!;
    const end = i % CRLF_EVERY === 0 ? '\r\n' : '\n';
    yield `${i},${customer},${note},${(i * 37) % 100000}.${i % 100},${city}${end}`;
  }
}

/** The CSV, written once. */
const CSV: Synthetic = { path: FILE, head: HEADER, bytes: FILE_BYTES, rows };

let engine: Engine | undefined;
let done: (() => void) | undefined;
afterEach(() => {
  done?.();
  engine = undefined;
  done = undefined;
});

test('the index pass scans bytes at disk speed and keeps little per row', async () => {
  const expected = writeOnce(CSV);
  const gc = collector();
  const metrics: Metric[] = [];

  // Bytes read by the sniff.
  const src = await nodeSource(FILE);
  const sniffed = counted(src);
  const format = await peekFormat('index.csv', sniffed.source);
  if (format === undefined) throw new Error('the file read as empty');
  metrics.push({
    name: 'index: bytes read to sniff',
    unit: 'bytes',
    value: sniffed.bytes(),
  });
  expect(sniffed.bytes()).toBeLessThanOrEqual(SNIFF_BYTES_BUDGET);
  expect(format.delimiter).toBe(',');
  expect(format.columns).toEqual(['id', 'customer', 'note', 'amount', 'city']);

  // The pass, with read and scan timed apart and heap measured around it.
  const index = new RowIndex(format.dataStart, src.size, TUNING);
  const scanner = format.scanner((offset) => index.begin(offset));
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let readMs = 0;
  let countMs = 0;
  let scanMs = 0;
  let newlines = 0;
  for (let at = format.dataStart; at < src.size;) {
    const t0 = performance.now();
    const chunk = await src.read(
      at,
      Math.min(TUNING.chunkBytes, src.size - at),
    );
    const t1 = performance.now();
    newlines += countNewlines(chunk);
    const t2 = performance.now();
    scanner.push(chunk, at);
    scanMs += performance.now() - t2;
    countMs += t2 - t1;
    readMs += t1 - t0;
    at += chunk.length;
    index.scanned = at;
  }
  index.complete = true;
  gc();
  const heapPerRow =
    (process.memoryUsage().heapUsed - heapBefore) / index.counted;
  await src.close();

  expect(index.counted).toBe(expected);
  // Every row ends in a newline, and one in NEWLINE_EVERY holds another.
  expect(newlines).toBeGreaterThan(expected);
  const scanned = src.size - format.dataStart;
  const scanOverCount = scanMs / countMs;
  metrics.push(
    {
      name: 'index: read ms per 200 MB',
      unit: 'ms',
      value: Math.round(readMs),
    },
    {
      name: 'index: scan ms per 200 MB',
      unit: 'ms',
      value: Math.round(scanMs),
    },
    {
      name: 'index: scan time over a newline count',
      unit: 'x',
      value: scanOverCount,
    },
    {
      name: 'index: heap bytes kept per row',
      unit: 'bytes',
      value: heapPerRow,
    },
  );
  expect(scanOverCount).toBeLessThanOrEqual(SCAN_OVER_COUNT_BUDGET);
  expect(heapPerRow).toBeLessThanOrEqual(HEAP_PER_ROW_BUDGET);
  const scanRate = scanned / MB / (scanMs / SECOND_MS);
  expect(scanRate).toBeGreaterThanOrEqual(THROUGHPUT_FLOOR_MB_S);

  // End to end through the engine, with a window asked for during the pass.
  ({ engine, done } = connect(TUNING, [diskProvider()]));
  const began = performance.now();
  const handle = await openOne(engine, { name: 'index.csv', path: FILE });
  const firstProgress = new Promise<void>((resolve) => {
    handle.onProgress = (p) => {
      if (p.readable > 0) resolve();
    };
  });
  await firstProgress;
  const asked = performance.now();
  const reply = await handle.rows(0, SCREEN);
  const answered = performance.now() - asked;
  const completeBeforeAnswer = handle.progress.complete;
  await indexed(handle);
  const passMs = performance.now() - began;

  expect(reply.rows.length).toBe(SCREEN);
  expect(reply.rows[0]![1]).toBe('Okafor, Ada');
  expect(completeBeforeAnswer).toBe(false);
  expect(handle.progress.rows).toBe(expected);
  metrics.push(
    {
      name: 'index: pass ms per 200 MB through the engine',
      unit: 'ms',
      value: Math.round(passMs),
    },
    {
      name: 'index: window asked mid-pass, ms to answer',
      unit: 'ms',
      value: Math.round(answered),
    },
  );
  expect(answered).toBeLessThanOrEqual(passMs * WINDOW_WAIT_FRACTION);
  expect(src.size / MB / (passMs / SECOND_MS)).toBeGreaterThanOrEqual(
    THROUGHPUT_FLOOR_MB_S,
  );

  record('index', metrics);
}, 120_000);
