/**
 * @fileoverview A refresh of a file on disk that grew by an append reads the
 * rows it gained and keeps the rest, and reads the file in full for any
 * other change. The files are real ones, read through a disk provider that
 * counts the bytes.
 */

import { appendFile, mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

import type { Chart } from '@document';
import { TUNING } from '@engine';
import type { SourceHandle, Tally, Tuning } from '@engine';
import type { Provider } from '@plugin';
import { diskProvider } from '@store/node';
import { repeated } from '@core-tests/efficiency/remote';
import { REGION, ROWS } from '@core-tests/testdata/sales-q3';
import { connect, everyRow, indexed, openOne, sales } from './harness.ts';

/** Small blocks, so the file is hundreds of them and a block is 4 KB. */
const SMALL: Tuning = {
  ...TUNING,
  chunkBytes: 64 << 10,
  blockRows: 64,
  blockBytes: 4 << 10,
};
/** 2.4 MB. */
const REPEATS = 10;
/** The rows an append adds: one more copy of the fixture's. */
const APPENDED = repeated(1).subarray(repeated(0).length);
/**
 * The most a refresh of a grown file may read beyond the appended bytes, none
 * of it more for a larger file: the sniff of the format, the sample rows its
 * columns are told from, the first and last blocks for the print, and the
 * last block again for the chart and the pass. 89,859 bytes measured.
 */
const GROWN_EXTRA = 100_000;

/** Rows per region. */
function chartOver(source: string): Chart {
  const by = { col: REGION, header: sales.columns[REGION]!.header };
  const place = { x: 1, y: 0, width: 420, height: 260 };
  return {
    id: 'c',
    source,
    plot: { t: 'bars', by },
    title: '',
    place,
    refresh: 0,
  };
}

/** counted is the disk provider, adding every byte it reads to `read`. */
function counted(read: { bytes: number }): Provider {
  const disk: Provider = diskProvider();
  const { files } = disk;
  return {
    ...disk,
    files: {
      label: files.label,
      handles: (ref) => files.handles(ref),
      async open(ref) {
        const source = await files.open(ref);
        return {
          size: source.size,
          modified: source.modified,
          async read(offset, length) {
            const got = await source.read(offset, length);
            read.bytes += got.length;
            return got;
          },
          close: () => source.close(),
        };
      },
    },
  };
}

/** The chart's tally once complete, for a source indexed or not yet. */
function tallied(src: SourceHandle): Promise<Tally> {
  return new Promise((resolve) => {
    src.onTally = (_chart, tally) => {
      if (tally.t === 'unread' || tally.coverage.complete) resolve(tally);
    };
  });
}

/** Every row of the file at `path` and its chart, read afresh. */
async function afresh(path: string): Promise<[string[][], Tally]> {
  const { engine, done } = connect(SMALL);
  try {
    const src = await openOne(engine, { name: 'log.csv', path });
    const tally = tallied(src);
    await engine.chart(chartOver(src.id));
    await indexed(src);
    return [await everyRow(src), await tally];
  } finally {
    done();
  }
}

/**
 * grown opens the file at `path` with a chart, lets `change` change it, and
 * refreshes it as a schedule does. It resolves with the rows and chart the
 * refresh shows, and the bytes it read.
 */
async function grown(
  path: string,
  change: () => Promise<void>,
): Promise<[string[][], Tally, number]> {
  const read = { bytes: 0 };
  const { engine, done } = connect(SMALL, [counted(read)]);
  try {
    const src = await openOne(engine, { name: 'log.csv', path });
    const first = tallied(src);
    await engine.chart(chartOver(src.id));
    await indexed(src);
    await first;
    await change();
    read.bytes = 0;
    const now = await engine.relink(src, { name: 'log.csv', path }, true);
    const tally = await tallied(now);
    await indexed(now);
    // Counted before the rows are read back for the test to compare.
    const bytes = read.bytes;
    return [await everyRow(now), tally, bytes];
  } finally {
    done();
  }
}

/** A file of the fixture's rows REPEATS times over, in a folder of its own. */
async function written(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'uno-grown-')), 'log.csv');
  await writeFile(path, repeated(REPEATS));
  return path;
}

test('a file that grew by an append reads the rows it gained, and shows what a fresh open shows', async () => {
  const path = await written();
  const [rows, tally, bytes] = await grown(path, () =>
    appendFile(path, APPENDED),
  );
  expect(rows).toHaveLength((REPEATS + 1) * ROWS);
  expect([rows, tally]).toStrictEqual(await afresh(path));
  expect(bytes).toBeLessThanOrEqual(APPENDED.length + GROWN_EXTRA);
});

test('a file that grew with its first or last block rewritten is read in full', async () => {
  const size = repeated(REPEATS).length;
  // The first row's date, and the last row's, one digit for another.
  for (const at of [repeated(0).length + 1, size - 2]) {
    const path = await written();
    const [rows, tally, bytes] = await grown(path, async () => {
      const file = await open(path, 'r+');
      const { buffer } = await file.read(Buffer.alloc(1), 0, 1, at);
      await file.write(Buffer.from(buffer[0] === 0x31 ? '2' : '1'), 0, 1, at);
      await file.close();
      await appendFile(path, APPENDED);
    });
    expect([rows, tally]).toStrictEqual(await afresh(path));
    expect(bytes).toBeGreaterThan(size);
  }
});
