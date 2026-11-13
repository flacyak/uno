/**
 * @fileoverview The cache a .uno keeps of a pointed-at source: its row index
 * and the key it holds for, under cache/<id>/. A reader that ignores the
 * folder reads the workspace as well, so the manifest's format stays.
 */

import type { Document, Manifest } from './document.ts';
import { resolvedPath, storedPath } from './document.ts';

/** The layout of a cache this build reads and writes. Any other is ignored. */
export const CACHE_VERSION = 1;
/** The folder of each source's cache, by id: its key and counts, its blocks. */
export const CACHE_DIR = 'cache/';
const indexEntry = (id: string): string => `${CACHE_DIR}${id}/index.json`;
const blocksEntry = (id: string): string => `${CACHE_DIR}${id}/blocks.bin`;

/** SavedSource is what a .uno keeps of one source's row index. */
export interface SavedSource {
  /** The file the index is of, resolved as the source's own path is. */
  path: string;
  /** Which bytes the index is of and how they were read, field by field. */
  key: Readonly<Record<string, unknown>>;
  /** Records the scan had passed. */
  counted: number;
  /** Whether the scan had read to the end of the file. */
  complete: boolean;
  /** The block starts as stored, decoded once the key matches. */
  blocks: Uint8Array;
}

/** One entry of the container. */
type Entry = { name: string; bytes: Uint8Array };

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/**
 * readCache reads the cache of each source `m` names that `entries` hold.
 * One that does not parse, or has another version, is left out and so not
 * written back. Undefined when none is read.
 */
export function readCache(
  entries: Record<string, Uint8Array>,
  m: Manifest,
  at: string,
): Map<string, SavedSource> | undefined {
  const cache = new Map<string, SavedSource>();
  for (const { id } of m.sources) {
    const blocks = entries[blocksEntry(id)];
    const o = parsed(entries[indexEntry(id)]);
    if (blocks === undefined || o?.['version'] !== CACHE_VERSION) continue;
    const { path, key, counted, complete } = o;
    if (typeof path !== 'string' || !isRecord(key)) continue;
    if (typeof counted !== 'number' || typeof complete !== 'boolean') continue;
    const kept = { key, counted, complete, blocks };
    cache.set(id, { path: resolvedPath(path, at), ...kept });
  }
  return cache.size === 0 ? undefined : cache;
}

/** cacheEntries lays out the cache of each of the sources of `d` with one. */
export function cacheEntries(d: Document): Entry[] {
  return d.sources.flatMap(({ id }) => {
    const saved = d.cache?.get(id);
    if (saved === undefined) return [];
    const { path, blocks, ...rest } = saved;
    const index = { version: CACHE_VERSION, path: storedPath(path, d.at) };
    const json = JSON.stringify({ ...index, ...rest }, undefined, 2);
    return [
      { name: indexEntry(id), bytes: encoder.encode(json) },
      { name: blocksEntry(id), bytes: blocks },
    ];
  });
}

/** parsed is the JSON object in `bytes`, if they hold one. */
function parsed(bytes?: Uint8Array): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(decoder.decode(bytes));
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
