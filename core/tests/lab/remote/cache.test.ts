/**
 * @fileoverview cachedSource returns what its source would, asks the source
 * for each page once, keeps pages apart by version, and survives a store
 * that fails. diskBytes keeps pages whole within its budget.
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vite-plus/test';

import type { ByteSource } from '@store';
import {
  PAGE_KEY,
  cachedSource,
  memoryBytes,
  objectKey,
  pageKey,
} from './cache.ts';
import type { ByteStore } from './cache.ts';
import { diskBytes } from './disk.ts';

/** A version as S3 gives one for an object uploaded whole. */
const ETAG = '"0123456789abcdef0123456789abcdef"';
const PATH = 's3://acme-exports/2025/big.csv';
/** A budget no test reaches. */
const ROOMY = 1 << 30;

/** Counted is a source over `bytes` that records every read it is asked. */
interface Counted {
  source: ByteSource;
  reads: Array<[offset: number, length: number]>;
}

function counted(bytes: Uint8Array, version: string = ETAG): Counted {
  const reads: Counted['reads'] = [];
  return {
    reads,
    source: {
      size: bytes.length,
      version,
      read(offset, length) {
        reads.push([offset, length]);
        return Promise.resolve(
          bytes.slice(offset, Math.min(offset + length, bytes.length)),
        );
      },
      close: () => Promise.resolve(),
    },
  };
}

/** A seeded generator, so a failing case can be run again. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** `size` bytes from `random`. */
function noise(size: number, random: () => number): Uint8Array {
  const BYTE = 256;
  return Uint8Array.from({ length: size }, () => Math.floor(random() * BYTE));
}

describe('cachedSource', () => {
  const SEEDS = 40;
  const READS = 30;
  const MAX_SIZE = 5000;
  const MAX_PAGE = 700;

  test('every read returns what the source would, cold and kept', async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = mulberry32(seed);
      const size = 1 + Math.floor(random() * MAX_SIZE);
      const pageBytes = 1 + Math.floor(random() * MAX_PAGE);
      const bytes = noise(size, random);
      const store = memoryBytes(ROOMY);
      // Reads run past the end and start past it, as an engine's last chunk does.
      const asks = Array.from({ length: READS }, () => {
        const offset = Math.floor(random() * (size + pageBytes));
        return [offset, Math.floor(random() * size)] as const;
      });

      const cold = cachedSource(counted(bytes).source, PATH, store, pageBytes);
      for (const [offset, length] of asks) {
        const want = bytes.subarray(offset, Math.min(offset + length, size));
        expect(await cold.read(offset, length), `seed ${seed}`).toEqual(want);
      }
      await cold.close();

      const again = counted(bytes);
      const kept = cachedSource(again.source, PATH, store, pageBytes);
      for (const [offset, length] of asks) {
        const want = bytes.subarray(offset, Math.min(offset + length, size));
        expect(await kept.read(offset, length), `seed ${seed}`).toEqual(want);
      }
      expect(again.reads, `seed ${seed}: kept pages are read locally`).toEqual(
        [],
      );
    }
  });

  test('a run of missing pages is one read, aligned to pages', async () => {
    const PAGE = 100;
    const bytes = noise(10 * PAGE, mulberry32(1));
    const store = memoryBytes(ROOMY);
    const warm = cachedSource(counted(bytes).source, PATH, store, PAGE);
    // Pages 1 and 3 are kept.
    await warm.read(PAGE + 5, 1);
    await warm.read(3 * PAGE + 5, 1);
    await warm.close();

    const c = counted(bytes);
    const src = cachedSource(c.source, PATH, store, PAGE);
    expect(await src.read(50, 4 * PAGE)).toEqual(bytes.subarray(50, 450));
    // Pages 0, 2 and 4 are missing, each between kept ones.
    expect(c.reads).toEqual([
      [0, PAGE],
      [2 * PAGE, PAGE],
      [4 * PAGE, PAGE],
    ]);
  });

  test('reads at once of the same pages ask the source once', async () => {
    const PAGE = 64;
    const bytes = noise(8 * PAGE, mulberry32(2));
    const c = counted(bytes);
    const src = cachedSource(c.source, PATH, memoryBytes(ROOMY), PAGE);
    const [a, b] = await Promise.all([
      src.read(10, 3 * PAGE),
      src.read(PAGE, 2 * PAGE),
    ]);
    expect(a).toEqual(bytes.subarray(10, 10 + 3 * PAGE));
    expect(b).toEqual(bytes.subarray(PAGE, 3 * PAGE));
    expect(c.reads).toEqual([[0, 4 * PAGE]]);
  });

  test('another version, size or page size is another object', async () => {
    const PAGE = 64;
    const bytes = noise(4 * PAGE, mulberry32(3));
    const store = memoryBytes(ROOMY);
    const warm = cachedSource(counted(bytes).source, PATH, store, PAGE);
    await warm.read(0, bytes.length);
    await warm.close();

    const changed = noise(4 * PAGE, mulberry32(4));
    const other = counted(changed, '"another"');
    const src = cachedSource(other.source, PATH, store, PAGE);
    expect(await src.read(0, changed.length)).toEqual(changed);
    expect(other.reads).toHaveLength(1);

    const keys = new Set([
      objectKey(PATH, bytes.length, ETAG, PAGE),
      objectKey(PATH, bytes.length, '"another"', PAGE),
      objectKey(PATH, bytes.length + 1, ETAG, PAGE),
      objectKey(PATH, bytes.length, ETAG, PAGE + 1),
      objectKey(`${PATH}x`, bytes.length, ETAG, PAGE),
    ]);
    expect(keys.size).toBe(5);
    expect(pageKey(objectKey(PATH, 1, ETAG, PAGE), 7)).toMatch(PAGE_KEY);
  });

  test('a source that does not say its version is read as it is', () => {
    const unversioned: ByteSource = {
      ...counted(noise(MAX_PAGE, mulberry32(9))).source,
      version: undefined,
    };
    expect(cachedSource(unversioned, PATH, memoryBytes(ROOMY))).toBe(
      unversioned,
    );
  });

  test('a page kept at the wrong length is asked for again', async () => {
    const PAGE = 64;
    const bytes = noise(2 * PAGE, mulberry32(5));
    const store = memoryBytes(ROOMY);
    const object = objectKey(PATH, bytes.length, ETAG, PAGE);
    await store.save(pageKey(object, 0), bytes.subarray(0, PAGE - 1));
    const c = counted(bytes);
    const src = cachedSource(c.source, PATH, store, PAGE);
    expect(await src.read(0, PAGE)).toEqual(bytes.subarray(0, PAGE));
    expect(c.reads).toEqual([[0, PAGE]]);
  });

  test('a store that fails costs reads, never wrong bytes', async () => {
    const PAGE = 64;
    const bytes = noise(3 * PAGE, mulberry32(6));
    const broken: ByteStore = {
      load: () => Promise.reject(new Error('disk gone')),
      save: () => Promise.reject(new Error('disk full')),
    };
    const c = counted(bytes);
    const src = cachedSource(c.source, PATH, broken, PAGE);
    expect(await src.read(5, 2 * PAGE)).toEqual(
      bytes.subarray(5, 5 + 2 * PAGE),
    );
    await src.close();
    expect(await src.read(5, 2 * PAGE)).toEqual(
      bytes.subarray(5, 5 + 2 * PAGE),
    );
    expect(c.reads).toHaveLength(2);
  });

  test('a read that fails is asked for again by the next read', async () => {
    const PAGE = 64;
    const bytes = noise(2 * PAGE, mulberry32(7));
    let failing = true;
    const c = counted(bytes);
    const flaky: ByteSource = {
      ...c.source,
      read: (offset, length) =>
        failing
          ? Promise.reject(new Error('network'))
          : c.source.read(offset, length),
    };
    const src = cachedSource(flaky, PATH, memoryBytes(ROOMY), PAGE);
    await expect(src.read(0, PAGE)).rejects.toThrow('network');
    failing = false;
    expect(await src.read(0, PAGE)).toEqual(bytes.subarray(0, PAGE));
  });
});

describe('memoryBytes', () => {
  test('holds at most its budget, the least recently used going first', async () => {
    const PAGE = 10;
    const store = memoryBytes(3 * PAGE);
    for (const key of ['a', 'b', 'c'])
      await store.save(key, new Uint8Array(PAGE));
    await store.load('a');
    await store.save('d', new Uint8Array(PAGE));
    expect(store.held()).toBe(3 * PAGE);
    expect(await store.load('b')).toBeUndefined();
    expect(await store.load('a')).toBeDefined();
  });
});

describe('diskBytes', () => {
  let dir = '';
  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  const key = (page: number): string =>
    pageKey(objectKey(PATH, 1, ETAG, 1), page);

  test('a saved page loads back whole, and a missing one is undefined', async () => {
    dir = await mkdtemp(join(tmpdir(), 'uno-lab-remote-'));
    const store = diskBytes(join(dir, 'pages'));
    expect(await store.load(key(0))).toBeUndefined();
    const PAGE = 1000;
    const bytes = noise(PAGE, mulberry32(8));
    await store.save(key(0), bytes);
    expect(await store.load(key(0))).toEqual(bytes);
    // Nothing but the page is left in the folder.
    expect(await readdir(join(dir, 'pages'))).toEqual([key(0)]);
  });

  test('a name the cache did not make is refused', async () => {
    dir = await mkdtemp(join(tmpdir(), 'uno-lab-remote-'));
    const store = diskBytes(dir);
    await expect(store.save('../escape', new Uint8Array(1))).rejects.toThrow(
      'not a page key',
    );
  });

  test('the folder stays within its budget, keeping the page last used', async () => {
    const PAGE = 1000;
    const PAGES = 10;
    const BUDGET = 4 * PAGE;
    dir = await mkdtemp(join(tmpdir(), 'uno-lab-remote-'));
    const store = diskBytes(dir, BUDGET);
    await store.save(key(0), new Uint8Array(PAGE));
    for (let page = 1; page < PAGES; page++) {
      // Modified times are in milliseconds: one apart keeps the order plain.
      await new Promise((resolve) => setTimeout(resolve, 2));
      await store.load(key(0));
      await store.save(key(page), new Uint8Array(PAGE));
    }
    const names = await readdir(dir);
    const sizes = await Promise.all(
      names.map(async (n) => (await stat(join(dir, n))).size),
    );
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(BUDGET);
    expect(names).toContain(key(0));
    expect(names).toContain(key(PAGES - 1));
  });
});
