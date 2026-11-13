/**
 * @fileoverview A .uno keeps each pointed-at source's row index under
 * cache/<id>/, and a reader that does not know the folder reads the file as
 * one saved without it: format 6, the manifest unchanged, and every other
 * entry byte for byte the same.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { expect, test } from 'vite-plus/test';

import {
  FORMAT_VERSION,
  MANIFEST_ENTRY,
  newManifest,
  readContainer,
  writeDocument,
} from '@document';
import type { Document, HeldFile, SavedSource } from '@document';
import {
  CACHE_AT_MOST,
  CACHE_DIR,
  CACHE_SOURCE_AT_MOST,
  CACHE_VERSION,
} from '@document/cache';

/** Fixed created time, so two saves can be compared byte for byte. */
const CREATED = new Date('2026-11-01T09:00:00Z');
const AT = '/home/cpa/q4/books.uno';
const ORDERS = '/home/cpa/q4/orders.csv';

/** A cache of orders.csv as a save writes it. */
function saved(): SavedSource {
  return {
    path: ORDERS,
    key: { bytes: 2_040_109_871, modified: 1_762_000_000_000, delimiter: ',' },
    counted: 30_604_418,
    complete: true,
    blocks: Uint8Array.of(0, 41, 128, 8, 177, 210, 4),
  };
}

/** orders.csv, at `path` under the id `id`. */
function held(id = 'orders', path = ORDERS): HeldFile {
  return {
    id,
    name: 'orders.csv',
    path,
    bytes: 2_040_109_871,
    rows: 30_604_418,
    cols: 11,
    state: { active: { row: 0, col: 0 } },
  };
}

/** A workspace of orders.csv, with `cache` as its saved index. */
function workspace(cache?: Map<string, SavedSource>): Document {
  return {
    manifest: { ...newManifest(), created: CREATED, modified: CREATED },
    sources: [held()],
    active: 'orders',
    log: [],
    ...(cache === undefined ? {} : { cache }),
    extra: new Map(),
    at: AT,
  };
}

const INDEX = `${CACHE_DIR}orders/index.json`;
const BLOCKS = `${CACHE_DIR}orders/blocks.bin`;

/** The entries of a .uno, but those under cache/. */
function uncached(uno: Uint8Array): Record<string, Uint8Array> {
  const entries = unzipSync(uno);
  for (const name of Object.keys(entries))
    if (name.startsWith(CACHE_DIR)) delete entries[name];
  return entries;
}

test('a save writes each source cache under cache/<id>/ and reads it back as it was', () => {
  const uno = writeDocument(workspace(new Map([['orders', saved()]])));
  const entries = unzipSync(uno);
  expect(entries[BLOCKS]).toStrictEqual(saved().blocks);
  expect(JSON.parse(strFromU8(entries[INDEX]!))).toStrictEqual({
    version: CACHE_VERSION,
    path: 'orders.csv',
    key: saved().key,
    counted: saved().counted,
    complete: true,
  });
  const back = readContainer('books.uno', uno, AT);
  expect(back.cache).toStrictEqual(new Map([['orders', saved()]]));
  expect(back.extra.size, 'the cache is read, not carried').toBe(0);
});

test('a cache leaves the format as it was, and the manifest and every other entry as a save without one writes them', () => {
  const plain = writeDocument(workspace());
  const cached = writeDocument(workspace(new Map([['orders', saved()]])));
  expect(FORMAT_VERSION, 'this build reads format 6, as before').toBe(6);
  const formatOf = (uno: Uint8Array): unknown =>
    JSON.parse(strFromU8(unzipSync(uno)[MANIFEST_ENTRY]!)).format;
  expect(formatOf(cached)).toBe(formatOf(plain));
  expect(uncached(cached)).toStrictEqual(unzipSync(plain));
});

test('a reader that drops cache/, as builds before 7a0c3a2b do, opens the workspace a save without one writes', () => {
  const cached = writeDocument(workspace(new Map([['orders', saved()]])));
  const stripped = zipSync(uncached(cached));
  const plain = readContainer('books.uno', writeDocument(workspace()), AT);
  expect(readContainer('books.uno', stripped, AT)).toStrictEqual(plain);
});

test('a reader that carries cache/ as entries it does not know writes it back, and this build reads it again', () => {
  const cached = writeDocument(workspace(new Map([['orders', saved()]])));
  // A build from 7a0c3a2b on, before the cache, holds the entries in extra.
  const entries = unzipSync(cached);
  const carried = workspace();
  carried.extra = new Map([
    [INDEX, entries[INDEX]!],
    [BLOCKS, entries[BLOCKS]!],
  ]);
  const back = readContainer('books.uno', writeDocument(carried), AT);
  expect(back.cache).toStrictEqual(new Map([['orders', saved()]]));
});

test('a workspace with no cache writes no cache entry', () => {
  const uno = writeDocument(workspace());
  const names = Object.keys(unzipSync(uno));
  expect(names.filter((n) => n.startsWith(CACHE_DIR))).toStrictEqual([]);
  expect(readContainer('books.uno', uno, AT).cache).toBeUndefined();
});

test('a cache this build cannot read is ignored and not written back', () => {
  const uno = writeDocument(workspace(new Map([['orders', saved()]])));
  const index = JSON.parse(strFromU8(unzipSync(uno)[INDEX]!));
  const unreadable: Array<[string, Record<string, Uint8Array>]> = [
    ['newer', { [INDEX]: strToU8(JSON.stringify({ ...index, version: 2 })) }],
    ['not JSON', { [INDEX]: strToU8('{"version": 1,') }],
    ['no blocks', { [BLOCKS]: new Uint8Array(0) }],
    ['no key', { [INDEX]: strToU8(JSON.stringify({ ...index, key: 1 })) }],
    ['a stray', { [`${CACHE_DIR}gone/index.json`]: strToU8('{}') }],
  ];
  for (const [why, change] of unreadable) {
    const entries = { ...unzipSync(uno), ...change };
    if (why === 'no blocks') delete entries[BLOCKS];
    const read = readContainer('books.uno', zipSync(entries), AT);
    if (why === 'a stray') {
      expect(read.cache?.size, why).toBe(1);
    } else {
      expect(read.cache, why).toBeUndefined();
    }
    const again = Object.keys(unzipSync(writeDocument(read)));
    const kept = again.filter((n) => n.startsWith(CACHE_DIR));
    expect(kept, why).toStrictEqual(why === 'a stray' ? [INDEX, BLOCKS] : []);
  }
});

/** Bytes left under a cap for a cache's index entry beside its blocks. */
const INDEX_ROOM = 1 << 10;

/** A cache whose blocks take `bytes`. */
function sized(bytes: number): SavedSource {
  return { ...saved(), blocks: new Uint8Array(bytes) };
}

/** A workspace of `count` copies of orders.csv, each with a cache of `bytes`. */
function copies(count: number, bytes: number): Document {
  const d = workspace();
  d.sources = Array.from({ length: count }, (_, i) =>
    held(`orders-${i}`, `/home/cpa/q4/orders-${i}.csv`),
  );
  d.active = d.sources[0]!.id;
  d.cache = new Map(d.sources.map((s) => [s.id, sized(bytes)]));
  return d;
}

test('a source whose cache passes its cap is saved without one', () => {
  const read = (bytes: number) =>
    readContainer('books.uno', writeDocument(copies(1, bytes)), AT).cache;
  expect(read(CACHE_SOURCE_AT_MOST - INDEX_ROOM)?.size).toBe(1);
  expect(read(CACHE_SOURCE_AT_MOST)).toBeUndefined();
});

test('the caches that would pass the workspace cap are saved without, in source order', () => {
  const each = CACHE_SOURCE_AT_MOST - INDEX_ROOM;
  const fit = Math.floor(CACHE_AT_MOST / CACHE_SOURCE_AT_MOST);
  const d = copies(fit + 1, each);
  const uno = writeDocument(d);
  const kept = readContainer('books.uno', uno, AT).cache;
  const ids = Array.from({ length: fit }, (_, i) => `orders-${i}`);
  expect([...kept!.keys()]).toStrictEqual(ids);
  expect([...d.cache!.keys()], 'the save says which went in').toStrictEqual(
    ids,
  );
});
