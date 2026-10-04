/**
 * @fileoverview A ByteSource that keeps the bytes it reads from a bucket in a
 * local store, so a later open of the same version of the object reads them
 * from there instead of the bucket.
 *
 * Bytes are kept a page at a time: pageBytes-aligned pieces of the object,
 * named by the object's path, size and version and the page's number. A read
 * takes the pages the store holds and asks the bucket for the rest, one
 * request per run of pages it lacks.
 *
 * The store is a seam, bytes by name, as IndexStore is for kept indexes on
 * t3/kept-index, so this file imports nothing of node: a folder (disk.ts), a
 * browser's storage or a Map can sit behind it. Which pages it holds within
 * its budget, and which go first, is the store's business.
 */

import { sha256Hex } from '@go';
import type { Provider } from '@plugin';
import type { ByteSource } from '@store';

/**
 * ByteStore keeps bytes under names the cache makes: lowercase hex, a dot,
 * and a page number, safe as a file name.
 */
export interface ByteStore {
  /** The bytes kept under `key`, or undefined when there are none. */
  load(key: string): Promise<Uint8Array | undefined>;
  /** Keeps `bytes` under `key`, replacing what was there. */
  save(key: string, bytes: Uint8Array): Promise<void>;
}

/** The bytes in one page, unless the caller says otherwise. */
export const PAGE_BYTES = 1 << 20;

/** A page name: the object's hex name, a dot, the page's number. */
export const PAGE_KEY = /^[0-9a-f]{64}\.\d+$/;

/**
 * objectKey names one version of one object, cut into pages of `pageBytes`.
 * Another version, size or page size is another name, so it never meets
 * these bytes.
 */
export function objectKey(
  path: string,
  size: number,
  version: string,
  pageBytes: number,
): string {
  const named = [path, size, version, pageBytes].join('\n');
  return sha256Hex(new TextEncoder().encode(named));
}

/** pageKey names one page of an object objectKey named. */
export function pageKey(object: string, page: number): string {
  return `${object}.${page}`;
}

/**
 * cachedSource wraps `inner`, the object at `path`, so every page read
 * through it is kept in `store` and read from there the next time.
 *
 * A source that does not say which version its bytes are is returned as it
 * is: its bytes cannot be told from other bytes under the same path.
 *
 * Bytes come only from `inner` or from pages kept under this version's
 * name, so a read returns what `inner` would. A page the store returns at
 * the wrong length is fetched again. A store that fails costs a fetch,
 * never a read: keeping is a saving.
 */
export function cachedSource(
  inner: ByteSource,
  path: string,
  store: ByteStore,
  pageBytes: number = PAGE_BYTES,
): ByteSource {
  const version = inner.version;
  if (version === undefined || path === '') return inner;
  const size = inner.size;
  const object = objectKey(path, size, version, pageBytes);

  /**
   * Pages asked of the bucket whose save has not finished, by number. A read
   * takes a page from here before it looks in the store, so a page is asked
   * for once however many reads want it.
   */
  const fresh = new Map<number, Promise<Uint8Array>>();
  /** Saves under way. close waits for them. */
  const saving = new Set<Promise<void>>();

  /** lengthOf is how many bytes page `page` holds: pageBytes but the last. */
  const lengthOf = (page: number): number =>
    Math.min(pageBytes, size - page * pageBytes);

  /** kept is page `page` from the store, or undefined when it lacks it whole. */
  async function kept(page: number): Promise<Uint8Array | undefined> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await store.load(pageKey(object, page));
    } catch {
      return undefined;
    }
    return bytes?.length === lengthOf(page) ? bytes : undefined;
  }

  /**
   * fetch asks `inner` for pages `first` to `last` in one read, puts each in
   * `fresh`, and saves each that came whole.
   */
  function fetch(first: number, last: number): void {
    const start = first * pageBytes;
    const end = Math.min((last + 1) * pageBytes, size);
    const run = inner.read(start, end - start);
    const asked = new Map<number, Promise<Uint8Array>>();
    // Handled before any reader hears of the failure, so the next read of
    // these pages asks again.
    run.catch(() => {
      for (const [page, bytes] of asked) {
        if (fresh.get(page) === bytes) fresh.delete(page);
      }
    });
    for (let page = first; page <= last; page++) {
      const at = (page - first) * pageBytes;
      const bytes = run.then((got) => got.subarray(at, at + lengthOf(page)));
      asked.set(page, bytes);
      fresh.set(page, bytes);
      const saved = bytes
        .then((got) =>
          got.length === lengthOf(page)
            ? store.save(pageKey(object, page), got)
            : undefined,
        )
        .catch(() => undefined)
        .finally(() => {
          if (fresh.get(page) === bytes) fresh.delete(page);
          saving.delete(saved);
        });
      saving.add(saved);
    }
  }

  return {
    size,
    version,

    async read(offset, length) {
      const end = Math.min(offset + length, size);
      if (end <= offset) return new Uint8Array();
      const first = Math.floor(offset / pageBytes);
      const last = Math.floor((end - 1) / pageBytes);
      const count = last - first + 1;

      // The store is asked for every page not on its way already.
      const looked = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          fresh.has(first + i) ? Promise.resolve(undefined) : kept(first + i),
        ),
      );

      // From here to the fetches nothing is awaited, so `fresh` holds still.
      // A page neither on its way nor kept is fetched with its missing
      // neighbours. One the store gained after it was asked is fetched again,
      // which costs a request and returns the same bytes.
      const parts: Array<Promise<Uint8Array> | undefined> = looked.map(
        (got, i) =>
          fresh.get(first + i) ??
          (got === undefined ? undefined : Promise.resolve(got)),
      );
      const waits: Array<Promise<Uint8Array>> = [];
      for (let i = 0; i < count;) {
        const known = parts[i];
        if (known !== undefined) {
          waits.push(known);
          i++;
          continue;
        }
        let j = i;
        while (j + 1 < count && parts[j + 1] === undefined) j++;
        fetch(first + i, first + j);
        for (let k = i; k <= j; k++) waits.push(fresh.get(first + k)!);
        i = j + 1;
      }
      const pages = await Promise.all(waits);

      if (count === 1) {
        const from = offset - first * pageBytes;
        return pages[0]!.subarray(from, from + (end - offset));
      }
      const out = new Uint8Array(end - offset);
      let written = 0;
      for (let i = 0; i < count; i++) {
        const pageStart = (first + i) * pageBytes;
        const page = pages[i]!;
        const from = Math.max(offset, pageStart) - pageStart;
        const to = Math.min(end, pageStart + page.length) - pageStart;
        if (to > from) {
          out.set(page.subarray(from, to), written);
          written += to - from;
        }
        // A page cut short means the object ended early: what came is all.
        if (page.length < lengthOf(first + i)) break;
      }
      return written === out.length ? out : out.subarray(0, written);
    },

    async close() {
      while (saving.size > 0) await Promise.all(saving);
      await inner.close();
    },
  };
}

/**
 * cachedProvider is `provider` with every file it opens by path wrapped by
 * cachedSource over `store`.
 */
export function cachedProvider(
  provider: Provider,
  store: ByteStore,
  pageBytes: number = PAGE_BYTES,
): Provider {
  const { files } = provider;
  return {
    ...provider,
    files: {
      label: files.label,
      handles: (ref) => files.handles(ref),
      async open(ref) {
        const inner = await files.open(ref);
        return 'path' in ref
          ? cachedSource(inner, ref.path, store, pageBytes)
          : inner;
      },
    },
  };
}

/**
 * memoryBytes is a ByteStore in a Map, holding at most `budget` bytes. The
 * least recently used page goes first. It copies what it keeps, so a page
 * cut from a larger read does not hold the rest of that read.
 */
export function memoryBytes(budget: number): ByteStore & { held(): number } {
  const pages = new Map<string, Uint8Array>();
  let held = 0;
  return {
    held: () => held,
    load(key) {
      const bytes = pages.get(key);
      if (bytes !== undefined) {
        // Re-inserted, so the page becomes the newest entry in the Map.
        pages.delete(key);
        pages.set(key, bytes);
      }
      return Promise.resolve(bytes);
    },
    save(key, bytes) {
      const old = pages.get(key);
      if (old !== undefined) {
        pages.delete(key);
        held -= old.length;
      }
      pages.set(key, bytes.slice());
      held += bytes.length;
      for (const [name, page] of pages) {
        if (held <= budget) break;
        pages.delete(name);
        held -= page.length;
      }
      return Promise.resolve();
    },
  };
}
