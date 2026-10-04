/**
 * @fileoverview A person's session through the real engine: jump to random
 * places in a large file, reading a band of BAND_ROWS rows at each, then go
 * back to them in a shuffled order. Also a find that reads to the end of the
 * file.
 *
 * Every read the engine makes after the index is a page cache miss, so the
 * reads counted by a Watch during a band request are that request's misses.
 * The blocks a band spans come from the file's Layout.
 */

import { spawnSync } from 'node:child_process';

import { BAND_ROWS } from '@engine';
import type { Found, SourceHandle } from '@engine';
import { SAMPLE_ROWS } from '@sheet';
import { REGION } from '@core-tests/testdata/sales-q3';
import { blocksOf } from './layout.ts';
import type { Layout } from './layout.ts';
import { seeded, shuffled } from './stats.ts';
import type { Random } from './stats.ts';
import type { Watch } from './watch.ts';

/** How many times the session goes back over its jumps, each in a new order. */
export const REVISIT_PASSES = 2;

/** Jump is one place a person goes to: the band's first row and its blocks. */
export interface Jump {
  from: number;
  blocks: readonly number[];
}

/** Visit is one band request: how long it took and the blocks it missed. */
export interface Visit {
  ms: number;
  misses: number;
  blocks: number;
}

/** SessionRun is every visit of one session, first visits apart from revisits. */
export interface SessionRun {
  first: Visit[];
  revisits: Visit[];
}

/** Random picks per jump before giving up on finding unread blocks. */
const PICKS_PER_JUMP = 1000;

/**
 * pickJumps chooses `count` band positions whose blocks share nothing with
 * `taken` or with each other, and adds their blocks to `taken`. A first visit
 * is then always a miss, even when one engine serves several sessions.
 */
export function pickJumps(
  layout: Layout,
  count: number,
  random: Random,
  taken: Set<number>,
): Jump[] {
  const rows = layout.index.counted;
  if (rows < BAND_ROWS) throw new Error(`${rows} rows hold no whole band`);
  const out: Jump[] = [];
  for (let tries = 0; out.length < count; tries++) {
    if (tries > count * PICKS_PER_JUMP) {
      throw new Error(`found ${out.length} of ${count} unread bands`);
    }
    const from = Math.floor(random() * (rows - BAND_ROWS + 1));
    const blocks = blocksOf(layout.index, from, BAND_ROWS);
    if (blocks.some((b) => taken.has(b))) continue;
    for (const b of blocks) taken.add(b);
    out.push({ from, blocks });
  }
  return out;
}

/** opened returns the blocks an open reads: those holding the sample rows. */
export function opened(layout: Layout): Set<number> {
  return new Set(blocksOf(layout.index, 0, SAMPLE_ROWS));
}

/** visit asks for one band and returns its time and misses. */
export async function visit(
  src: SourceHandle,
  watch: Watch,
  jump: Jump,
): Promise<Visit> {
  const reads = watch.reads;
  const started = performance.now();
  const reply = await src.rows(jump.from, BAND_ROWS);
  const ms = performance.now() - started;
  if (reply.rows.length !== BAND_ROWS) {
    throw new Error(
      `asked ${BAND_ROWS} rows at ${jump.from}, got ${reply.rows.length}`,
    );
  }
  return { ms, misses: watch.reads - reads, blocks: jump.blocks.length };
}

/**
 * session visits each jump in order, then revisits them all REVISIT_PASSES
 * times, each pass in a new shuffled order.
 */
export async function session(
  src: SourceHandle,
  watch: Watch,
  jumps: readonly Jump[],
  random: Random,
): Promise<SessionRun> {
  const first: Visit[] = [];
  for (const jump of jumps) first.push(await visit(src, watch, jump));
  const revisits: Visit[] = [];
  for (let pass = 0; pass < REVISIT_PASSES; pass++) {
    for (const jump of shuffled(jumps, random)) {
      revisits.push(await visit(src, watch, jump));
    }
  }
  return { first, revisits };
}

/** The seed every run starts from, so every run picks the same places. */
export const SEED = 20261023;

/**
 * orderFor returns the random source for session `i`'s revisit orders, the
 * same in every variant and every process.
 */
export function orderFor(i: number): Random {
  return seeded(SEED + i + 1);
}

/**
 * runSessions runs one session per list of jumps, in order. `before` runs
 * ahead of each.
 */
export async function runSessions(
  src: SourceHandle,
  watch: Watch,
  plans: readonly (readonly Jump[])[],
  before?: () => void,
): Promise<SessionRun[]> {
  const runs: SessionRun[] = [];
  for (const [i, jumps] of plans.entries()) {
    before?.();
    runs.push(await session(src, watch, jumps, orderFor(i)));
  }
  return runs;
}

/** The share of block lookups the cache answered, over some visits. */
export function hitRate(visits: readonly Visit[]): number {
  const blocks = visits.reduce((n, v) => n + v.blocks, 0);
  const misses = visits.reduce((n, v) => n + v.misses, 0);
  return blocks === 0 ? 0 : 1 - misses / blocks;
}

/** Text absent from every region cell, so a find for it reads every row. */
export const NOWHERE = 'nowhere';
/** A start row before the first, so row 0 is searched too. */
const BEFORE_FIRST = -1;

/** FindRun is one find to the end of the file. */
export interface FindRun {
  ms: number;
  found: Found;
  /** Reads, and bytes, the find made through the source. */
  reads: number;
  bytes: number;
}

/** findToEnd searches the region column for NOWHERE from the first row down. */
export async function findToEnd(
  src: SourceHandle,
  watch: Watch,
): Promise<FindRun> {
  const reads = watch.reads;
  const bytes = watch.bytes;
  const started = performance.now();
  const found = await src.find({
    col: REGION,
    from: BEFORE_FIRST,
    dir: 1,
    match: { t: 'text', text: NOWHERE },
  });
  return {
    ms: performance.now() - started,
    found,
    reads: watch.reads - reads,
    bytes: watch.bytes - bytes,
  };
}

/**
 * dropCached asks the kernel to drop a file's cached pages, so the next reads
 * of it go to the disk. Returns false when dd is missing or refused.
 */
export function dropCached(path: string): boolean {
  const run = spawnSync(
    'dd',
    [`if=${path}`, 'iflag=nocache', 'count=0', 'status=none'],
    { stdio: 'ignore' },
  );
  return run.status === 0;
}
