/**
 * @fileoverview Checks that the cache lab measures what it says it does: the
 * shapes are the rows they claim, the layout is the engine's own, a first
 * visit misses every block it spans, a find leaves the cache as it was, and
 * the two scripts run as processes speak their protocols. Also checks one
 * fact the bench relies on to explain a find over a bucket: readAhead serves
 * none of a find's block reads, since blocks differ in length.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { BAND_ROWS, TUNING } from '@engine';
import type { SourceHandle, Tuning } from '@engine';
import { readAll } from '@ingest';
import { RUN, readAhead } from '@store/ahead';
import { diskProvider, nodeSource } from '@store/node';
import { connect, indexed, openOne } from '@core-tests/engine/harness';
import { bytes as salesBytes, ROWS } from '@core-tests/testdata/sales-q3';
import { onLines, start, stderrOf } from './child.ts';
import type { FillLine } from './fill.ts';
import { heapPerSourceByte } from './heap.ts';
import { collector, layoutOf } from './layout.ts';
import type { Layout } from './layout.ts';
import {
  findToEnd,
  hitRate,
  opened,
  pickJumps,
  session,
  visit,
} from './session.ts';
import type { Jump } from './session.ts';
import { WIDE_COPIES, shapeBytes } from './shapes.ts';
import { GO } from './slowed.ts';
import type { SlowedAsk, SlowedLine } from './slowed.ts';
import { median, seeded, shuffled } from './stats.ts';
import { Watch } from './watch.ts';

/** Bytes in a megabyte. */
const MB = 1 << 20;
/** The size of the file the engine tests open: about 80 blocks of sales rows. */
const FILE_BYTES = 4 * MB;
/** Jumps per test session. */
const JUMPS = 4;
/** A cache large enough to hold the whole test file. */
const ROOMY: Tuning = { ...TUNING, cacheBytes: 64 * MB };
/** A cache that holds about one block of sales rows. */
const CRAMPED: Tuning = { ...TUNING, cacheBytes: 64 << 10 };
/** The delay the Watch test switches on. */
const DELAY_MS = 20;
/** A seed for the tests' random picks. */
const SEED = 7;

const decoder = new TextDecoder();
const sales = readAll(decoder.decode(salesBytes), ',');

let folder = '';
let path = '';
let layout: Layout;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'uno-lab-cache-'));
  path = join(folder, 'sales.csv');
  await writeFile(path, shapeBytes('sales', FILE_BYTES));
  const source = await nodeSource(path);
  try {
    layout = await layoutOf('sales.csv', source);
  } finally {
    await source.close();
  }
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** Opens the test file through a Watch with `tuning`, indexed. */
async function open(tuning: Tuning): Promise<{
  watch: Watch;
  src: SourceHandle;
  done: () => void;
}> {
  const watch = new Watch(diskProvider());
  const { engine, done } = connect(tuning, [watch.provider]);
  const src = await openOne(engine, { name: 'sales.csv', path });
  await indexed(src);
  return { watch, src, done };
}

describe('shapes', () => {
  test('a wide row is a sales-q3 row written WIDE_COPIES times', () => {
    const rows = readAll(decoder.decode(shapeBytes('wide', MB)), ',');
    expect(rows[0]).toHaveLength(sales[0]!.length * WIDE_COPIES);
    expect(rows[0]![0]).toBe('date_1');
    for (let r = 1; r <= ROWS; r++) {
      const want = Array.from({ length: WIDE_COPIES }, () => sales[r]!).flat();
      expect(rows[r]).toEqual(want);
    }
  });

  test('the synthetic shape has quoted newlines, CRLF and wide characters', () => {
    const bytes = shapeBytes('synthetic', MB);
    const text = decoder.decode(bytes);
    const rows = readAll(text, ',');
    expect(rows[0]).toEqual(['id', 'customer', 'note', 'amount', 'city']);
    expect(rows.every((r) => r.length === rows[0]!.length)).toBe(true);
    expect(rows[1]![2]).toBe('first line\nsecond line, with a comma');
    expect(rows[2]![1]).toBe('Lindqvist');
    expect(text).toContain('\r\n');
    expect(text).toContain('東京');
  });

  test('every shape reaches its target and ends on a whole row', () => {
    for (const shape of ['sales', 'synthetic', 'wide'] as const) {
      const bytes = shapeBytes(shape, MB);
      expect(bytes.length).toBeGreaterThanOrEqual(MB);
      expect(bytes.at(-1)).toBe('\n'.charCodeAt(0));
    }
  });
});

describe('layout and jumps', () => {
  test('the layout counts the rows the engine counts', async () => {
    const { src, done } = await open(TUNING);
    try {
      expect(src.progress.rows).toBe(layout.index.counted);
      expect(layout.blocks).toBeGreaterThan(1);
    } finally {
      done();
    }
  });

  test('jumps share no block with each other or with what an open reads', () => {
    const taken = opened(layout);
    const before = new Set(taken);
    const jumps = pickJumps(layout, JUMPS * 2, seeded(SEED), taken);
    const blocks = jumps.flatMap((j) => j.blocks);
    expect(new Set(blocks).size).toBe(blocks.length);
    expect(blocks.some((b) => before.has(b))).toBe(false);
  });
});

describe('sessions through the engine', () => {
  test('a first visit misses every block it spans and returns the right rows', async () => {
    const { watch, src, done } = await open(ROOMY);
    try {
      const jumps = pickJumps(layout, JUMPS, seeded(SEED), opened(layout));
      for (const jump of jumps) {
        const v = await visit(src, watch, jump);
        expect(v.misses).toBe(v.blocks);
      }
      // A repeated file's row r is sales-q3's data row r mod ROWS.
      const jump = jumps[0]!;
      const reply = await src.rows(jump.from, BAND_ROWS);
      expect(reply.rows.length).toBe(BAND_ROWS);
      for (let i = 0; i < BAND_ROWS; i++) {
        expect(reply.rows[i]).toEqual(sales[1 + ((jump.from + i) % ROWS)]);
      }
    } finally {
      done();
    }
  });

  test('a cache that holds the session answers every revisit', async () => {
    const { watch, src, done } = await open(ROOMY);
    try {
      const jumps = pickJumps(layout, JUMPS, seeded(SEED), opened(layout));
      const run = await session(src, watch, jumps, seeded(SEED));
      expect(hitRate(run.first)).toBe(0);
      expect(hitRate(run.revisits)).toBe(1);
    } finally {
      done();
    }
  });

  test('a cache smaller than one band misses on revisits', async () => {
    const { watch, src, done } = await open(CRAMPED);
    try {
      const jumps = pickJumps(layout, JUMPS, seeded(SEED), opened(layout));
      const run = await session(src, watch, jumps, seeded(SEED));
      expect(hitRate(run.revisits)).toBeLessThan(1 / 2);
    } finally {
      done();
    }
  });

  test('a find reads every block the cache lacks and adds none to it', async () => {
    const { watch, src, done } = await open(ROOMY);
    try {
      const jumps = pickJumps(layout, JUMPS, seeded(SEED), opened(layout));
      await session(src, watch, jumps, seeded(SEED));
      const held = new Set([
        ...opened(layout),
        ...jumps.flatMap((j) => j.blocks),
      ]);
      let lacking = 0;
      for (let b = 0; b < layout.blocks; b++) {
        if (held.has(b)) continue;
        const [start, end] = layout.index.bytesOf(b);
        lacking += end - start;
      }

      const first = await findToEnd(src, watch);
      const second = await findToEnd(src, watch);
      expect(first.found).toEqual({
        row: null,
        searched: layout.index.counted,
        complete: true,
      });
      // The cache could hold the whole file, yet the second find reads the
      // same bytes as the first.
      expect(first.bytes).toBe(lacking);
      expect(second.bytes).toBe(lacking);

      const after = [];
      for (const jump of shuffled(jumps, seeded(SEED))) {
        after.push(await visit(src, watch, jump));
      }
      expect(hitRate(after)).toBe(1);
    } finally {
      done();
    }
  });

  test('a Watch counts reads, and delays them once switched on', async () => {
    const watch = new Watch(diskProvider());
    const source = await watch.provider.files.open({ name: 'sales.csv', path });
    try {
      await source.read(0, 1);
      expect(watch.reads).toBe(1);
      watch.delayMs = DELAY_MS;
      const started = performance.now();
      await source.read(0, 1);
      expect(performance.now() - started).toBeGreaterThanOrEqual(DELAY_MS - 1);
      expect(watch.reads).toBe(2);
      expect(watch.bytes).toBe(2);
    } finally {
      await source.close();
    }
  });
});

describe('heap', () => {
  test('a cached block costs several heap bytes per source byte, its text about one', async () => {
    const gc = collector();
    const narrow = await heapPerSourceByte(
      'sales.csv',
      shapeBytes('sales', 2 * MB),
      2 * MB,
      gc,
    );
    expect(narrow.ratio).toBeGreaterThan(2);
    expect(narrow.textRatio).toBeGreaterThan(0.8);
    expect(narrow.textRatio).toBeLessThan(1.3);
    // Blocks with a character past Latin-1 decode to two-byte strings.
    const synthetic = await heapPerSourceByte(
      'synthetic.csv',
      shapeBytes('synthetic', 2 * MB),
      2 * MB,
      gc,
    );
    expect(synthetic.textRatio).toBeGreaterThan(1.5);
  });
});

describe('readAhead under a find', () => {
  /** How many reads a reader made that a prefetch had already asked for. */
  async function prefetched(lengths: readonly number[]): Promise<number> {
    const size = lengths.reduce((a, b) => a + b, 0);
    const asked = new Set<string>();
    const read = readAhead((offset, length) => {
      asked.add(`${offset}:${length}`);
      return Promise.resolve(new Uint8Array(length));
    }, size);
    let served = 0;
    let at = 0;
    for (const length of lengths) {
      if (asked.has(`${at}:${length}`)) served++;
      await read(at, length);
      at += length;
    }
    return served;
  }

  test('serves none of a find block reads, which differ in length', async () => {
    const blocks = Array.from({ length: layout.blocks }, (_, b) => {
      const [start, end] = layout.index.bytesOf(b);
      return end - start;
    });
    expect(new Set(blocks).size).toBeGreaterThan(1);
    expect(await prefetched(blocks)).toBe(0);
    // The same number of reads at one length is served almost entirely.
    const same = blocks.map(() => median(blocks));
    expect(await prefetched(same)).toBeGreaterThanOrEqual(same.length - RUN);
  });
});

describe('scripts run as processes', () => {
  test('fill.ts prints a line per level and ends', async () => {
    const child = start('fill.ts', [path, '1', '2']);
    const tail = stderrOf(child);
    const lines: FillLine[] = [];
    onLines<FillLine>(child, (l) => lines.push(l));
    const code = await new Promise<number | null>((resolve) =>
      child.on('close', resolve),
    );
    expect(code, tail()).toBe(0);
    const levels = lines.filter((l) => l.t === 'level');
    expect(levels).toHaveLength(2);
    expect(lines.at(-1)).toEqual({ t: 'done' });
  });

  test('slowed.ts indexes, waits for go, then runs its sessions slowed', async () => {
    const jumps: Jump[] = pickJumps(layout, 2, seeded(SEED), opened(layout));
    const ask: SlowedAsk = {
      name: 'sales.csv',
      path,
      rows: layout.index.counted,
      cacheMB: TUNING.cacheBytes / MB,
      slowMs: DELAY_MS,
      sessions: [jumps],
    };
    const child = start('slowed.ts', []);
    const tail = stderrOf(child);
    const lines: SlowedLine[] = [];
    let ready = (): void => {};
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    onLines<SlowedLine>(child, (l) => {
      lines.push(l);
      if (l.t === 'ready') ready();
    });
    const closed = new Promise<number | null>((resolve) =>
      child.on('close', resolve),
    );
    child.stdin.write(`${JSON.stringify(ask)}\n`);
    await isReady;
    child.stdin.end(`${GO}\n`);
    expect(await closed, tail()).toBe(0);

    const runs = lines.find((l) => l.t === 'runs');
    if (runs?.t !== 'runs') throw new Error(`no runs: ${tail()}`);
    const [run] = runs.runs;
    expect(run!.first.map((v) => v.misses)).toEqual(
      jumps.map((j) => j.blocks.length),
    );
    // Each block read sleeps first, one block after another.
    for (const v of run!.first) {
      expect(v.ms).toBeGreaterThanOrEqual(v.misses * (DELAY_MS - 1));
    }
  });
});
