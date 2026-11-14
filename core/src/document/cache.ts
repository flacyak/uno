/**
 * @fileoverview The cache a .uno keeps of a pointed-at source: its row index
 * and the key it holds for, and the folds of its charts, under cache/<id>/.
 * A reader that ignores the folder reads the workspace as well, so the
 * manifest's format stays.
 */

import { TALLY_VERSION } from '@tally';

import type { Document, Manifest } from './document.ts';
import { resolvedPath, storedPath } from './document.ts';

/** The layout of a cache this build reads and writes. Any other is ignored. */
export const CACHE_VERSION = 1;
/** The folder of each source's cache, by id: its key and counts, its blocks. */
export const CACHE_DIR = 'cache/';
const indexEntry = (id: string): string => `${CACHE_DIR}${id}/index.json`;
const blocksEntry = (id: string): string => `${CACHE_DIR}${id}/blocks.bin`;
const chartsEntry = (id: string): string => `${CACHE_DIR}${id}/charts.json`;

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
  /** The SHA-256 of a disk file's first block and its last, where known. */
  head?: string;
  tail?: string;
  /** The block starts as stored, decoded once the key matches. */
  blocks: Uint8Array;
  /**
   * The fold of each of the source's charts by the chart's id, as the
   * engine wrote it. Read only where this build's TALLY_VERSION folded them
   * over the edits the log holds now.
   */
  charts?: Readonly<Record<string, unknown>>;
}

/** Digest is the SHA-256 of a source's edits, by the source's id. */
export type Digest = (id: string) => string;

/** One entry of the container, and what its deflate is kept under. */
type Entry = { name: string; bytes: Uint8Array; key?: string };

/** The most bytes a source's cache may hold before deflate. */
export const CACHE_SOURCE_AT_MOST = 16 << 20;
/** The most bytes every source's cache together may hold before deflate. */
export const CACHE_AT_MOST = 64 << 20;

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
  log: Digest,
): Map<string, SavedSource> | undefined {
  const cache = new Map<string, SavedSource>();
  for (const { id } of m.sources) {
    const blocks = entries[blocksEntry(id)];
    const o = parsed(entries[indexEntry(id)]);
    if (blocks === undefined || o?.['version'] !== CACHE_VERSION) continue;
    const { path, key, counted, complete, head, tail } = o;
    if (typeof path !== 'string' || !isRecord(key)) continue;
    if (typeof counted !== 'number' || typeof complete !== 'boolean') continue;
    if (!isHash(head) || !isHash(tail)) continue;
    const kept = { key, counted, complete, head, tail, blocks };
    // Folds made by another build, or over other edits, are folded again.
    const folded = parsed(entries[chartsEntry(id)]);
    const charts = folded?.['charts'];
    const held = folded?.['version'] === TALLY_VERSION && isRecord(charts);
    const folds = held && folded['log'] === log(id) ? { charts } : {};
    cache.set(id, { path: resolvedPath(path, at), ...kept, ...folds });
  }
  return cache.size === 0 ? undefined : cache;
}

/** The entries of the caches a save lays out, and which caches they are. */
export interface Laid {
  entries: Entry[];
  kept: Map<string, SavedSource>;
}

/**
 * cacheEntries lays out the cache of each of the sources of `d` with one,
 * in their order, but a cache that would pass a cap: that source is saved
 * without its charts' folds, or where that passes too, without any, and is
 * read afresh when it opens. The block starts deflate once for each file
 * and count of them. Each source's folds hold for its edits, by `log`.
 */
export function cacheEntries(d: Document, log: Digest): Laid {
  let room = CACHE_AT_MOST;
  const laid: Laid = { entries: [], kept: new Map() };
  for (const { id } of d.sources) {
    const saved = d.cache?.get(id);
    if (saved === undefined) continue;
    const { path, blocks, charts, ...rest } = saved;
    const index = { version: CACHE_VERSION, path: storedPath(path, d.at) };
    const json = JSON.stringify({ ...index, ...rest }, undefined, 2);
    const bytes = encoder.encode(json);
    const folds = charts && { version: TALLY_VERSION, log: log(id), charts };
    const folded = folds && encoder.encode(JSON.stringify(folds));
    const size = bytes.length + blocks.length;
    const cap = Math.min(CACHE_SOURCE_AT_MOST, room);
    if (size > cap) continue;
    const charted = folded !== undefined && size + folded.length <= cap;
    room -= charted ? size + folded.length : size;
    const key = `${path} ${JSON.stringify(saved.key)} ${blocks.length}`;
    laid.entries.push(
      { name: indexEntry(id), bytes },
      { name: blocksEntry(id), bytes: blocks, key },
    );
    if (charted) laid.entries.push({ name: chartsEntry(id), bytes: folded });
    laid.kept.set(id, charted ? saved : { path, blocks, ...rest });
  }
  return laid;
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

function isHash(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}
