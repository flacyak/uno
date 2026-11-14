/**
 * @fileoverview A reopen whose source still matches the key its index was
 * saved under takes the index, reads only the sniff and the first block,
 * and serves every row as a fresh index would. Any change the key names
 * reads the source whole, as before the cache.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  appendFile,
  copyFile,
  mkdtemp,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

import { TUNING } from '@engine';
import type { Engine } from '@engine';
import { blobProvider } from '@store';
import { statusChangedMs } from '@store/disklister';
import { diskProvider } from '@store/node';
import { BUCKET } from '@core-tests/store/standin';
import { served } from '@core-tests/efficiency/remote';
import type { Served } from '@core-tests/efficiency/remote';
import { ROWS } from '@core-tests/testdata/sales-q3';
import {
  FIXTURE,
  TINY,
  bytes,
  connect,
  counted,
  everyRow,
  indexed,
  openOne,
  slowed,
} from './harness.ts';

/** The most a sniff reads, and the fixture's first block of rows. */
const SNIFF_AT_MOST = 64 << 10;
const FIRST_BLOCK_AT_MOST = 64 << 10;
/** Rows an append adds to the fixture. */
const APPENDED = '2025-09-30,West,Ada,web,1,1\n'.repeat(3);
/**
 * The most of the fixture a reopen of it grown reads past the sniff: the
 * rows the columns are told from, the first and last saved blocks, and the
 * last block again with the new rows. 4.5% measured.
 */
const GROWN_SHARE = 0.1;
/** Milliseconds each read waits, so a save lands while the index runs. */
const SLOW_MS = 5;

let dir: string | undefined;
let s: Served | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Asked is what a reopen read of the source. */
type Asked = Array<{ offset: number | undefined; length: number }>;

/** A copy of the fixture on disk, read through a counted disk. */
async function onDisk() {
  dir = await mkdtemp(join(tmpdir(), 'uno-reopen-'));
  const csv = join(dir, 'sales-q3.csv');
  await copyFile(FIXTURE, csv);
  const asked: Asked = [];
  const providers = [counted(diskProvider(), csv, asked), blobProvider()];
  const engines: Array<() => void> = [];
  const engine = (): Engine => {
    const c = connect(TUNING, providers);
    engines.push(c.done);
    return c.engine;
  };
  const close = () => engines.forEach((done) => done());
  return { csv, uno: join(dir, 'q3.uno'), asked, engine, close };
}

/** saveIndexed opens `path` in `engine`, indexes it and saves it to `uno`. */
async function saveIndexed(engine: Engine, path: string, uno: string) {
  const src = await openOne(engine, { name: 'sales-q3.csv', path });
  await indexed(src);
  const saved = await engine.save({ source: src.id, cells: [], at: uno }, 0);
  await writeFile(uno, saved);
  return { src, saved };
}

/** reopen opens the .uno at `uno` and waits for its index. */
async function reopen(engine: Engine, uno: string) {
  const src = await openOne(engine, { name: 'q3.uno', path: uno });
  await indexed(src);
  return src;
}

/** bytesOf adds up the bytes of the reads from `from` on. */
function bytesOf(asked: Asked, from: number): number {
  return asked.slice(from).reduce((sum, a) => sum + a.length, 0);
}

/** tampered is the .uno at `uno` with its index's key changed by `change`. */
async function tampered(
  uno: Uint8Array,
  change: (key: Record<string, unknown>) => void,
): Promise<Uint8Array> {
  const entries = unzipSync(uno);
  const name = Object.keys(entries).find((n) => n.endsWith('index.json'))!;
  const index = JSON.parse(strFromU8(entries[name]!));
  change(index.key);
  entries[name] = strToU8(JSON.stringify(index));
  return zipSync(entries);
}

test('a reopen whose key holds reads the sniff and the first block, and serves every row as a fresh index does', async () => {
  const disk = await onDisk();
  try {
    const { src: first } = await saveIndexed(disk.engine(), disk.csv, disk.uno);
    const rows = await everyRow(first);
    const from = disk.asked.length;
    const src = await reopen(disk.engine(), disk.uno);
    expect(src.progress.rows).toBe(ROWS);
    expect(disk.asked.length - from, 'the sniff, then the first block').toBe(2);
    expect(
      [first.progress.unkept, src.progress.unkept],
      'a save keeps the index read, and nothing the save held whole',
    ).toStrictEqual([true, false]);
    expect(bytesOf(disk.asked, from)).toBeLessThanOrEqual(
      SNIFF_AT_MOST + FIRST_BLOCK_AT_MOST,
    );
    expect(await everyRow(src)).toStrictEqual(rows);
  } finally {
    disk.close();
  }
});

test('an index of bytes with no file behind them is one no save keeps', async () => {
  const c = connect(TUNING, [blobProvider()]);
  try {
    const src = await openOne(c.engine, {
      name: 'sales-q3.csv',
      blob: new Blob([bytes]),
    });
    await indexed(src);
    expect(src.progress.unkept).toBe(false);
  } finally {
    c.done();
  }
});

test('a reopen over a file on disk changed since the save reads it whole', async () => {
  const changes: Array<[string, (csv: string) => Promise<void>]> = [
    [
      'grown, with its first row rewritten',
      async (csv) => {
        await writeFile(csv, strToU8(strFromU8(bytes).replace('West', 'Wets')));
        await appendFile(csv, APPENDED);
      },
    ],
    ['touched', (csv) => utimes(csv, new Date(0), new Date(0))],
    [
      'rewritten with its modified time put back',
      async (csv) => {
        // The kernel stamps the change time a clock tick at a time, so the
        // rewrite goes on until it moves.
        const was = await stat(csv);
        let now = was;
        while (statusChangedMs(now) === statusChangedMs(was)) {
          await writeFile(csv, bytes);
          await utimes(csv, was.mtime, was.mtime);
          now = await stat(csv);
        }
      },
    ],
  ];
  for (const [why, change] of changes) {
    const disk = await onDisk();
    try {
      await saveIndexed(disk.engine(), disk.csv, disk.uno);
      await change(disk.csv);
      const from = disk.asked.length;
      await reopen(disk.engine(), disk.uno);
      expect(bytesOf(disk.asked, from), why).toBeGreaterThanOrEqual(
        bytes.length,
      );
    } finally {
      disk.close();
      await rm(dir!, { recursive: true, force: true });
    }
  }
});

test('a reopen over a file on disk grown by an append since the save reads only its tail', async () => {
  const disk = await onDisk();
  const engine = (providers = [diskProvider(), blobProvider()]) => {
    const c = connect(TINY, providers);
    return Object.assign(c.engine, { done: c.done });
  };
  const first = engine();
  const again = engine([
    counted(diskProvider(), disk.csv, disk.asked),
    blobProvider(),
  ]);
  const fresh = engine();
  try {
    await saveIndexed(first, disk.csv, disk.uno);
    await appendFile(disk.csv, APPENDED);
    const src = await reopen(again, disk.uno);
    const whole = await openOne(fresh, { name: 'grown.csv', path: disk.csv });
    await indexed(whole);
    expect(src.progress.rows).toBe(whole.progress.rows);
    expect(disk.asked[0]!.offset, 'the sniff').toBe(0);
    expect(bytesOf(disk.asked, 1)).toBeLessThan(GROWN_SHARE * bytes.length);
    expect(await everyRow(src)).toStrictEqual(await everyRow(whole));
  } finally {
    for (const e of [first, again, fresh]) e.done();
    disk.close();
  }
});

test('a reopen whose saved key names another reading or another build reads the file whole', async () => {
  const changes: Array<[string, (key: Record<string, unknown>) => void]> = [
    ['size', (key) => (key['bytes'] = bytes.length - 1)],
    ['modified time', (key) => (key['modified'] = 0)],
    ['change time', (key) => (key['statusChanged'] = 0)],
    ['delimiter', (key) => (key['delimiter'] = ';')],
    ['header mode', (key) => (key['header'] = 'none')],
    ['block rows', (key) => (key['blockRows'] = TUNING.blockRows / 2)],
    ['scanner', (key) => (key['index'] = -1)],
  ];
  for (const [why, change] of changes) {
    const disk = await onDisk();
    try {
      const { saved } = await saveIndexed(disk.engine(), disk.csv, disk.uno);
      await writeFile(disk.uno, await tampered(saved, change));
      const from = disk.asked.length;
      const src = await reopen(disk.engine(), disk.uno);
      expect(src.progress.rows, why).toBe(ROWS);
      expect(bytesOf(disk.asked, from), why).toBeGreaterThanOrEqual(
        bytes.length,
      );
    } finally {
      disk.close();
      await rm(dir!, { recursive: true, force: true });
    }
  }
});

test('a reopen over an object uploaded again since the save reads it whole', async () => {
  const objects = new Map([['2025/sales-q3.csv', bytes]]);
  s = await served(objects, TUNING);
  dir = await mkdtemp(join(tmpdir(), 'uno-reopen-'));
  const uno = join(dir, 'q3.uno');
  const path = `s3://${BUCKET}/2025/sales-q3.csv`;
  s.door.release();
  await saveIndexed(s.engine, path, uno);

  // The same rows with the first two swapped: the same size, another ETag.
  const lines = strFromU8(bytes).split('\n');
  [lines[1], lines[2]] = [lines[2]!, lines[1]!];
  objects.set('2025/sales-q3.csv', strToU8(lines.join('\n')));
  const from = s.door.asked.length;
  await reopen(s.another(), uno);
  expect(bytesOf(s.door.asked, from)).toBeGreaterThanOrEqual(bytes.length);
});

test('a reopen of a workspace saved partway through its index goes on from the last block the save closed', async () => {
  const disk = await onDisk();
  try {
    const slow = connect(TINY, [slowed(diskProvider(), SLOW_MS)]);
    const src = await openOne(slow.engine, {
      name: 'sales-q3.csv',
      path: disk.csv,
    });
    const place = { source: src.id, cells: [], at: disk.uno };
    const saved = await slow.engine.save(place, 0);
    slow.done();
    await writeFile(disk.uno, saved);
    const index = JSON.parse(
      strFromU8(unzipSync(saved)[`cache/${src.id}/index.json`]!),
    );
    expect(index.complete, 'the save came partway').toBe(false);

    const first = connect(TINY, [diskProvider(), blobProvider()]);
    const whole = await openOne(first.engine, {
      name: 'sales-q3.csv',
      path: disk.csv,
    });
    await indexed(whole);
    const rows = await everyRow(whole);
    first.done();

    const engine = connect(TINY, [
      counted(diskProvider(), disk.csv, disk.asked),
      blobProvider(),
    ]);
    try {
      const again = await reopen(engine.engine, disk.uno);
      const read = bytesOf(disk.asked, 0);
      expect(again.progress.rows).toBe(ROWS);
      expect(again.progress.unkept, 'a save keeps the rest').toBe(true);
      expect(
        read,
        'the rows the save had indexed are not read again',
      ).toBeLessThan(bytes.length);
      expect(await everyRow(again)).toStrictEqual(rows);
    } finally {
      engine.done();
    }
  } finally {
    disk.close();
  }
});
