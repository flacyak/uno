/**
 * @fileoverview A skeptic's checks of the remote lab: how a band jump reads
 * its blocks today, whether one ranged read per band is simple, and what
 * the page store does with bad pages, shared folders and orphans.
 *
 * Nothing here is timed. Order and counts only.
 */

import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vite-plus/test';

import { BAND_ROWS, Pages, TUNING } from '@engine';
import type { RowIndex } from '@engine';
import { openFormat } from '@ingest';
import type { Format } from '@ingest';
import type { ByteSource } from '@store';
import { AHEAD, readAhead } from '@store/ahead';
import { repeated } from '@core-tests/testdata/sales-q3';
import {
  cachedSource,
  memoryBytes,
  objectKey,
  pageKey,
} from '../../remote/cache.ts';
import { diskBytes } from '../../remote/disk.ts';
import { REF } from '../../remote/far.ts';
import { jumpRows, wholeIndex } from '../../remote/session.ts';

/** 2.4 MB, 48,120 rows. */
const OBJECT = repeated(10);
const ETAG = '"0123456789abcdef0123456789abcdef"';
const PATH = 's3://acme-exports/2025/big.csv';
const MB = 1 << 20;

/** Raw is one request the bucket side saw. */
interface Raw {
  offset: number;
  length: number;
  /** Requests still unanswered when this one went out. */
  outstanding: number;
}

/**
 * bucketLike is OBJECT behind readAhead, as s3Files builds it, with every
 * raw request logged. Each raw read answers on a later macrotask, so
 * requests that overlap show as outstanding.
 */
function bucketLike(): { source: ByteSource; raws: Raw[]; calls: string[] } {
  const raws: Raw[] = [];
  const calls: string[] = [];
  let out = 0;
  const raw = (offset: number, length: number): Promise<Uint8Array> => {
    raws.push({ offset, length, outstanding: out });
    out++;
    return new Promise((resolve) =>
      setImmediate(() => {
        out--;
        resolve(OBJECT.slice(offset, offset + length));
      }),
    );
  };
  const ahead = readAhead(raw, OBJECT.length, AHEAD);
  return {
    raws,
    calls,
    source: {
      size: OBJECT.length,
      version: ETAG,
      async read(offset, length) {
        calls.push(`ask ${offset}`);
        const got = await ahead(offset, length);
        calls.push(`got ${offset}`);
        return got;
      },
      close: () => Promise.resolve(),
    },
  };
}

/** blockSpan is the blocks rows [first, first + count) are in. */
function blockSpan(index: RowIndex, first: number, count: number): number[] {
  const end = Math.min(first + count, index.readable());
  const a = index.blockOf(first);
  const b = index.blockOf(end - 1);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/**
 * bandOnce is the one-request band read: the byte span of every block the
 * rows are in, read once, cut at the index's block starts, each block
 * decoded alone as Pages.decode does.
 */
async function bandOnce(
  source: ByteSource,
  format: Format,
  index: RowIndex,
  first: number,
  count: number,
): Promise<string[][]> {
  const blocks = blockSpan(index, first, count);
  const start = index.bytesOf(blocks[0]!)[0];
  const end = index.bytesOf(blocks.at(-1)!)[1];
  const bytes = await source.read(start, end - start);
  const out: string[][] = [];
  const last = Math.min(first + count, index.readable());
  for (const block of blocks) {
    const [from, to] = index.bytesOf(block);
    const [row0] = index.rowsOf(block);
    const records = format.decode(bytes.subarray(from - start, to - start));
    for (let i = 0; i < records.length; i++) {
      const row = row0 + i;
      if (row >= first && row < last) out.push(records[i]!);
    }
  }
  return out;
}

describe('a band jump today', () => {
  test('reads its blocks one after another, and nothing ahead of them', async () => {
    const index = await wholeIndex(OBJECT, TUNING);
    const rows = index.rows();
    const jumps = jumpRows(rows, 20);
    let blocksRead = 0;
    let rawTotal = 0;
    let unusedTotal = 0;
    let serialAll = true;
    let lengthMismatches = 0;
    for (const first of jumps) {
      const b = bucketLike();
      const format = await openFormat(REF.name, b.source);
      const pages = new Pages(
        REF.name,
        b.source,
        format,
        index,
        TUNING.cacheBytes,
      );
      b.calls.length = 0;
      b.raws.length = 0;
      const got = await pages.rows(first, BAND_ROWS);
      expect(got.length).toBe(BAND_ROWS);
      const blocks = blockSpan(index, first, BAND_ROWS);
      blocksRead += blocks.length;
      // Serial: every ask after the first comes after the previous got.
      for (let i = 1; i < b.calls.length; i += 2) {
        if (!b.calls[i]!.startsWith('got')) serialAll = false;
      }
      const wanted = new Set(
        blocks.map(
          (k) =>
            `${index.bytesOf(k)[0]}:${index.bytesOf(k)[1] - index.bytesOf(k)[0]}`,
        ),
      );
      // Let the read-ahead's guesses land.
      await new Promise((r) => setImmediate(r));
      rawTotal += b.raws.length;
      unusedTotal += b.raws.filter(
        (r) => !wanted.has(`${r.offset}:${r.length}`),
      ).length;
      // A guess at a wanted block's offset but with another block's length.
      for (const r of b.raws) {
        for (const k of blocks) {
          const [s, e] = index.bytesOf(k);
          if (r.offset === s && r.length !== e - s) lengthMismatches++;
        }
      }
    }
    console.log(
      JSON.stringify({
        jumps: jumps.length,
        blocksRead,
        rawTotal,
        unusedTotal,
        lengthMismatches,
        serialAll,
      }),
    );
    expect(serialAll).toBe(true);
    // Blocks differ in length, so read-ahead never takes them for a run.
    expect(unusedTotal).toBe(0);
    expect(lengthMismatches).toBe(0);
    expect(rawTotal).toBe(blocksRead);
  });

  test('blocks of 1,024 rows differ in byte length in this fixture', async () => {
    const index = await wholeIndex(OBJECT, TUNING);
    const lengths = new Set<number>();
    const blocks = index.blockOf(index.readable() - 1) + 1;
    for (let k = 0; k < blocks - 1; k++) {
      const [s, e] = index.bytesOf(k);
      lengths.add(e - s);
    }
    console.log(JSON.stringify({ blocks, distinctLengths: lengths.size }));
    expect(lengths.size).toBeGreaterThan(1);
  });

  test('one ranged read per band returns what Pages.rows does', async () => {
    const index = await wholeIndex(OBJECT, TUNING);
    const jumps = jumpRows(index.rows(), 20);
    for (const first of [...jumps, 0, index.rows() - BAND_ROWS, 5]) {
      const a = bucketLike();
      const format = await openFormat(REF.name, a.source);
      const pages = new Pages(
        REF.name,
        a.source,
        format,
        index,
        TUNING.cacheBytes,
      );
      const want = await pages.rows(first, BAND_ROWS);
      const b = bucketLike();
      b.raws.length = 0;
      const got = await bandOnce(b.source, format, index, first, BAND_ROWS);
      expect(got).toEqual(want);
      await new Promise((r) => setImmediate(r));
      expect(b.raws.length, `band at ${first}`).toBe(1);
    }
  });
});

describe('the page store', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0))
      await rm(d, { recursive: true, force: true });
  });
  const fresh = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'verify-remote-'));
    dirs.push(d);
    return d;
  };

  const plain = (bytes: Uint8Array, reads: number[] = []): ByteSource => ({
    size: bytes.length,
    version: ETAG,
    read(offset, length) {
      reads.push(offset);
      return Promise.resolve(bytes.slice(offset, offset + length));
    },
    close: () => Promise.resolve(),
  });

  test('a page of the right length but wrong bytes is served as the bucket bytes', async () => {
    const dir = await fresh();
    const PAGE = 4096;
    const bytes = OBJECT.subarray(0, 4 * PAGE);
    const first = cachedSource(plain(bytes), PATH, diskBytes(dir), PAGE);
    expect(await first.read(PAGE, PAGE)).toEqual(
      bytes.subarray(PAGE, 2 * PAGE),
    );
    await first.close();
    // A torn write, bit rot or another tool: same length, other bytes.
    const object = objectKey(PATH, bytes.length, ETAG, PAGE);
    await writeFile(join(dir, pageKey(object, 1)), new Uint8Array(PAGE));
    const reads: number[] = [];
    const second = cachedSource(
      plain(bytes, reads),
      PATH,
      diskBytes(dir),
      PAGE,
    );
    const got = await second.read(PAGE, PAGE);
    await second.close();
    expect(reads).toEqual([]);
    expect(got).toEqual(new Uint8Array(PAGE));
    expect(got).not.toEqual(bytes.subarray(PAGE, 2 * PAGE));
  });

  test('two engines on one folder hold about twice the budget', async () => {
    const dir = await fresh();
    const BUDGET = 8 * MB;
    const a = diskBytes(dir, BUDGET);
    const b = diskBytes(dir, BUDGET);
    const page = new Uint8Array(MB);
    const hex = (c: string): string => c.repeat(64);
    // Each counts the folder on its first save, then only its own saves,
    // as two engines opened close together would.
    for (let i = 0; i < 7; i++) {
      await a.save(`${hex('a')}.${i}`, page);
      await b.save(`${hex('b')}.${i}`, page);
    }
    let held = 0;
    for (const n of await readdir(dir)) held += (await stat(join(dir, n))).size;
    console.log(JSON.stringify({ budget: BUDGET, held }));
    expect(held).toBeGreaterThan(BUDGET);
  });

  test('a scratch file left by a crash is never counted or removed', async () => {
    const dir = await fresh();
    const BUDGET = 4 * MB;
    const orphan = join(dir, `${'c'.repeat(64)}.0.999.0.tmp`);
    await writeFile(orphan, new Uint8Array(2 * MB));
    const s = diskBytes(dir, BUDGET);
    for (let i = 0; i < 10; i++)
      await s.save(`${'d'.repeat(64)}.${i}`, new Uint8Array(MB));
    expect((await stat(orphan)).size).toBe(2 * MB);
  });

  test('a first count that fails turns saving off for the life of the store', async () => {
    const parent = await fresh();
    const dir = join(parent, 'pages');
    // A file where the folder should be, so mkdir fails.
    await writeFile(dir, 'x');
    const s = diskBytes(dir, 4 * MB);
    const key = `${'e'.repeat(64)}.0`;
    await expect(s.save(key, new Uint8Array(1))).rejects.toThrow();
    await rm(dir);
    // The folder could now be made, but the failed count is kept.
    await expect(s.save(key, new Uint8Array(1))).rejects.toThrow();
  });

  test('a weak ETag is taken as a version and cached', () => {
    const src = { ...plain(OBJECT.subarray(0, 10)), version: 'W/"abc"' };
    expect(cachedSource(src, PATH, memoryBytes(MB))).not.toBe(src);
  });
});

describe('the page store on a shared machine', () => {
  test('pages and their folder are made with the default mode', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'verify-remote-mode-'));
    try {
      const dir = join(parent, 'pages');
      const s = diskBytes(dir, MB);
      const key = `${'f'.repeat(64)}.0`;
      await s.save(key, new Uint8Array(16));
      const dirMode = (await stat(dir)).mode & 0o777;
      const fileMode = (await stat(join(dir, key))).mode & 0o777;
      console.log(
        JSON.stringify({
          umask: process.umask().toString(8),
          dirMode: dirMode.toString(8),
          fileMode: fileMode.toString(8),
        }),
      );
      // Readable by other users of the machine under a 022 umask.
      expect(fileMode & 0o044).not.toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
