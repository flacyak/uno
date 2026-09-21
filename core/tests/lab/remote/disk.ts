/**
 * @fileoverview The ByteStore for a folder on this machine's disk: one file
 * per page, written whole or not at all, and the least recently used pages
 * removed once the folder passes its budget.
 *
 * It is shaped like diskIndexes on t3/kept-index. This file and nothing else
 * in the lab imports node:fs, which is where store/node.ts would hold it.
 */

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { PAGE_KEY } from './cache.ts';
import type { ByteStore } from './cache.ts';

/** The most a folder holds unless the caller says otherwise. */
export const BYTES_BUDGET = 1 << 30;

/**
 * The share of the budget a prune brings the folder down to, so the saves
 * after it do not each prune again.
 */
const LOW_WATER = 0.9;

/** The ending of a page being written, before it is renamed into place. */
const SCRATCH = '.tmp';

/** isMissing says whether an error says a file is not there. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * diskBytes keeps pages in `dir`, made on the first save, within `budget`
 * bytes.
 *
 * A load moves the page's modified time to now, which is what the prune
 * orders by. The folder's size is counted on the first save, then kept up
 * by what each save adds and each prune removes. Saves go on while a prune
 * looks, and the pages they write are missed by its look, so the folder can
 * pass its budget by those until the next prune, which the count starts.
 * Several engines may share the folder, so the count only starts a prune,
 * and the prune looks at the folder itself.
 */
export function diskBytes(
  dir: string,
  budget: number = BYTES_BUDGET,
): ByteStore {
  const at = (key: string): string => {
    if (!PAGE_KEY.test(key)) throw new Error(`not a page key: ${key}`);
    return join(dir, key);
  };
  /** The bytes the folder holds, as far as this store knows. */
  let held = 0;
  /** The first count of the folder, made with it on the first save. */
  let counting: Promise<void> | undefined;
  /** The prune under way, or the last one. */
  let pruning: Promise<void> = Promise.resolve();
  /** Tells scratch files of one process apart. */
  let scratches = 0;

  /**
   * prune removes the least recently used pages until the folder, as it
   * looked, is under LOW_WATER of its budget. It returns what the folder
   * held when it looked and how much of that it removed.
   */
  async function prune(): Promise<{ looked: number; removed: number }> {
    const names = (await readdir(dir)).filter((n) => PAGE_KEY.test(n));
    const pages = await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        const st = await stat(path).catch(() => undefined);
        return { path, bytes: st?.size ?? 0, used: st?.mtimeMs ?? 0 };
      }),
    );
    const looked = pages.reduce((sum, p) => sum + p.bytes, 0);
    const goal = budget * LOW_WATER;
    let removed = 0;
    for (const p of pages.toSorted((a, b) => a.used - b.used)) {
      if (looked - removed <= goal) break;
      await rm(p.path, { force: true });
      removed += p.bytes;
    }
    return { looked, removed };
  }

  return {
    async load(key) {
      const path = at(key);
      let read: Buffer;
      try {
        read = await readFile(path);
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return new Uint8Array(read.buffer, read.byteOffset, read.byteLength);
    },

    async save(key, bytes) {
      const path = at(key);
      // Every save of this store waits for the first count, so it is the
      // folder before any of them.
      counting ??= mkdir(dir, { recursive: true }).then(async () => {
        const { looked, removed } = await prune();
        held = looked - removed;
      });
      await counting;
      // Two engines keeping the same page write scratch files of their own,
      // and the last rename wins whole.
      const scratch = `${path}.${process.pid}.${scratches++}${SCRATCH}`;
      try {
        await writeFile(scratch, bytes);
        await rename(scratch, path);
      } catch (err) {
        await rm(scratch, { force: true });
        throw err;
      }
      held += bytes.length;
      if (held <= budget) return;
      pruning = pruning.then(async () => {
        // An earlier prune in the chain may have made room already.
        if (held <= budget) return;
        // Only what was removed comes off: saves made while it looked stay
        // counted. Another engine's pages it removed can take the count
        // below the folder's, never below nothing.
        const { removed } = await prune().catch(() => ({ removed: 0 }));
        held = Math.max(0, held - removed);
      });
      await pruning;
    },
  };
}
