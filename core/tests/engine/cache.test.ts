/**
 * @fileoverview A save keeps the row index of each file a path points at
 * alone, under the key its open measured: whole once the index is complete,
 * the blocks begun so far while it runs. Carried bytes keep none, and a
 * source that did not open keeps the index it was opened with.
 */

import { unzipSync } from 'fflate';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

import { readContainer } from '@document';
import type { SavedSource } from '@document';
import { RowIndex, indexPass } from '@engine';
import type { Engine, SourceHandle } from '@engine';
import { keyOf } from '@engine/key';
import { decodeBlocks } from '@engine/saved';
import { openFormat } from '@ingest';
import { blobProvider } from '@store';
import { diskProvider, nodeSource } from '@store/node';
import { ROWS } from '@core-tests/testdata/sales-q3';
import {
  FIXTURE,
  TINY,
  bytes,
  connect,
  indexed,
  openOne,
  slowed,
} from './harness.ts';

/** Milliseconds each read waits, so a save lands while the index runs. */
const SLOW_MS = 5;

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A copy of the fixture in a folder of its own, and where a save goes. */
async function copied(): Promise<{ csv: string; uno: string }> {
  dir = await mkdtemp(join(tmpdir(), 'uno-cache-'));
  const csv = join(dir, 'sales-q3.csv');
  await copyFile(FIXTURE, csv);
  return { csv, uno: join(dir, 'q3.uno') };
}

/** A carry limit the fixture fits under. */
const ROOMY = 1 << 20;

/** saveOf saves the workspace showing `src` to `uno` and reads it back. */
async function saveOf(engine: Engine, src: SourceHandle, uno: string) {
  const place = { source: src.id, cells: [], at: uno };
  const saved = await engine.save(place, ROOMY);
  return { saved, doc: readContainer('q3.uno', saved, uno) };
}

/** Where each block of `index` starts, as a row and a byte. */
function startsOf(index: RowIndex): number[][] {
  return Array.from({ length: index.begun }, (_, b) => [
    index.rowsOf(b)[0],
    index.bytesOf(b)[0],
  ]);
}

/** The blocks of `index`, as rows and bytes. */
function blocksOf(index: RowIndex): number[][] {
  return Array.from({ length: index.begun }, (_, b) => [
    ...index.rowsOf(b),
    ...index.bytesOf(b),
  ]);
}

/** The complete index the pass makes of the fixture at `csv`. */
async function fresh(csv: string): Promise<RowIndex> {
  const source = await nodeSource(csv);
  try {
    const format = await openFormat('sales-q3.csv', source);
    const index = new RowIndex(format.dataStart, source.size, TINY);
    const signal = new AbortController().signal;
    const ctx = { source, format, index, tuning: TINY, signal };
    await indexPass({ ...ctx, progress() {} });
    return index;
  } finally {
    await source.close();
  }
}

/** restored reads `saved`'s blocks back over the fixture at `csv`. */
async function restored(saved: SavedSource, csv: string): Promise<RowIndex> {
  const was = await fresh(csv);
  const starts = decodeBlocks(saved.blocks)!;
  const { counted, complete } = saved;
  const { start, size } = was;
  return RowIndex.restored(start, size, TINY, starts, counted, complete)!;
}

test('a save keeps the complete index of a file on disk, under the key its open measured', async () => {
  const { csv, uno } = await copied();
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, { name: 'sales-q3.csv', path: csv });
    await indexed(src);
    const { doc } = await saveOf(engine, src, uno);
    const saved = doc.cache?.get(src.id);

    const source = await nodeSource(csv);
    const format = await openFormat('sales-q3.csv', source);
    await source.close();
    const key = JSON.parse(JSON.stringify(keyOf(source, format, TINY)));
    expect(saved?.path).toBe(csv);
    expect(saved?.key).toStrictEqual(key);
    expect([saved?.counted, saved?.complete]).toStrictEqual([ROWS, true]);
    expect(saved?.head, 'the print of its first block').toMatch(/^[0-9a-f]+$/);
    expect(saved?.tail, 'and of its last').toMatch(/^[0-9a-f]+$/);
    const back = await restored(saved!, csv);
    expect(blocksOf(back)).toStrictEqual(blocksOf(await fresh(csv)));
  } finally {
    done();
  }
});

test('a save while the index runs keeps the blocks begun so far', async () => {
  const { csv, uno } = await copied();
  const { engine, done } = connect(TINY, [slowed(diskProvider(), SLOW_MS)]);
  try {
    const src = await openOne(engine, { name: 'sales-q3.csv', path: csv });
    const { doc } = await saveOf(engine, src, uno);
    const saved = doc.cache!.get(src.id)!;
    expect(saved.complete).toBe(false);
    expect(saved.counted).toBeGreaterThan(0);
    expect(saved.counted).toBeLessThan(ROWS);
    const begun = decodeBlocks(saved.blocks)!.firsts.length;
    const whole = startsOf(await fresh(csv));
    // A partway index keeps every block but its last, which a pass reads on.
    const kept = startsOf(await restored(saved, csv));
    expect(kept).toStrictEqual(whole.slice(0, begun - 1));
  } finally {
    done();
  }
});

test('bytes a .uno carries keep no index', async () => {
  const { uno } = await copied();
  const { engine, done } = connect(TINY, [blobProvider()]);
  try {
    const blob = new Blob([bytes]);
    const src = await openOne(engine, { name: 'sales-q3.csv', blob });
    await indexed(src);
    const { saved, doc } = await saveOf(engine, src, uno);
    expect(doc.cache).toBeUndefined();
    const names = Object.keys(unzipSync(saved));
    expect(names.filter((n) => n.startsWith('cache/'))).toStrictEqual([]);
  } finally {
    done();
  }
});

test('a source whose file has gone keeps the index it was opened with', async () => {
  const { csv, uno } = await copied();
  const first = connect(TINY);
  let saved: Uint8Array;
  try {
    const src = await openOne(first.engine, {
      name: 'sales-q3.csv',
      path: csv,
    });
    await indexed(src);
    saved = (await saveOf(first.engine, src, uno)).saved;
  } finally {
    first.done();
  }
  await writeFile(uno, saved);
  await rm(csv);

  const second = connect(TINY);
  try {
    const src = await openOne(second.engine, { name: 'q3.uno', path: uno });
    expect(src.opened.link?.missing, 'the file is gone').toBeDefined();
    const again = (await saveOf(second.engine, src, uno)).saved;
    const cacheOf = (u: Uint8Array) =>
      Object.entries(unzipSync(u)).filter(([n]) => n.startsWith('cache/'));
    expect(cacheOf(again)).toHaveLength(2);
    expect(cacheOf(again)).toStrictEqual(cacheOf(saved));
  } finally {
    second.done();
  }
});
