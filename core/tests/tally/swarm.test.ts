/**
 * @fileoverview SwarmFold against each value's rows sorted by rank.
 */

import { expect, test } from 'vite-plus/test';

import { parse } from '@num';
import { byRank } from '@tally/rank';
import {
  SWARM_ROWS_AT_MOST,
  SWARM_VALUES_AT_MOST,
  SwarmFold,
} from '@tally/swarm';

// Enough rows that each value cuts its sample more than once.
const ROWS = 20_000;
const BLOCK_ROWS = 1_024;
const VALUES = ['North', 'South', 'East', 'West', ''];
// One row in this many is blank, and one in that many a word.
const BLANK_EVERY = 7;
const WORD_EVERY = 11;

/** cellOf is row r's number cell: r and a half, blank, or a word. */
function cellOf(r: number): string {
  if (r % BLANK_EVERY === 0) return '';
  return r % WORD_EVERY === 0 ? 'n/a' : `${r}.5`;
}

/** strip is a value's strip worked out apart: its first rows by rank, those with a number. */
function strip(value: string, rows: number[]) {
  const sampled = [...rows]
    .sort(byRank)
    .slice(0, SWARM_ROWS_AT_MOST)
    .filter((r) => parse(cellOf(r), 'point') !== undefined);
  const plotted = rows.filter((r) => parse(cellOf(r), 'point') !== undefined);
  return {
    value,
    plotted: plotted.length,
    rows: sampled,
    at: sampled.map((r) => r + 0.5),
  };
}

test('a swarm fold samples each value by rank, the most rows first, with every row counted', () => {
  // A value of rows 0 to 4 in turn, and more of North.
  const valueOf = (r: number) => VALUES[r % 3 === 0 ? 0 : r % VALUES.length]!;
  const fold = new SwarmFold('point');
  for (let r = ROWS - 1; r >= 0; r--) {
    fold.add(Math.floor(r / BLOCK_ROWS), r, valueOf(r), cellOf(r));
  }
  const all = [...Array(ROWS).keys()];
  const of = (v: string) => all.filter((r) => valueOf(r) === v);
  const strips = VALUES.map((v) => strip(v, of(v))).sort(
    (a, b) => b.plotted - a.plotted || a.value.localeCompare(b.value),
  );
  const words = all.filter((r) => cellOf(r) === 'n/a').length;
  const blank = all.filter((r) => cellOf(r) === '').length;
  const last = all.findLast((r) => cellOf(r) !== '' && cellOf(r) !== 'n/a')!;
  expect(fold.snapshot()).toStrictEqual({
    strips,
    plotted: ROWS - words - blank,
    least: 1.5,
    most: last + 0.5,
    skipped: { blank, unparsed: words },
  });
});

test('a swarm fold keeps SWARM_VALUES_AT_MOST values, and later ones share Other', () => {
  const fold = new SwarmFold('comma');
  const values = SWARM_VALUES_AT_MOST + 2;
  for (let r = 0; r < values; r++) fold.add(0, r, `v${r}`, `${r},5`);
  const { strips, rest } = fold.snapshot();
  expect(strips).toHaveLength(SWARM_VALUES_AT_MOST);
  const other = [SWARM_VALUES_AT_MOST, values - 1].sort(byRank);
  expect(rest).toStrictEqual({
    value: '',
    plotted: 2,
    rows: other,
    at: other.map((r) => r + 0.5),
  });
  // Once Other has a row, a new value goes there too, and an old one keeps its own.
  fold.add(0, values, 'v0', '1');
  expect(fold.snapshot().strips.find((s) => s.value === 'v0')?.plotted).toBe(2);
});

test('an edit moves a dot, takes a row from its old value, and marks a block it took a least or most from', () => {
  const rows = [...Array(ROWS).keys()];
  const valueOf = (r: number) => VALUES[r % VALUES.length]!;
  const cells = new Map(rows.map((r) => [r, [valueOf(r), cellOf(r)] as const]));
  const fold = new SwarmFold('point');
  const add = (r: number) =>
    fold.add(Math.floor(r / BLOCK_ROWS), r, ...cells.get(r)!);
  const edit = (r: number, value: string, cell: string) => {
    fold.remove(Math.floor(r / BLOCK_ROWS), r, ...cells.get(r)!);
    cells.set(r, [value, cell]);
    add(r);
  };
  rows.forEach(add);
  const stripOf = (v: string) =>
    fold.snapshot().strips.find((s) => s.value === v)!;
  const north = stripOf('North');
  // North's first dot moves, and its second goes to South.
  const [moved, gone] = north.rows;
  edit(moved!, 'North', '-1');
  edit(gone!, 'South', `${gone}.5`);
  const after = stripOf('North');
  expect(after.at[0]).toBe(-1);
  expect(after.rows).not.toContain(gone);
  expect(after.plotted).toBe(north.plotted - 1);
  expect(stripOf('South').rows).toContain(gone);
  expect(fold.snapshot().least).toBe(-1);
  // Taking -1 back leaves its block to fold again, and then the least is the next.
  edit(moved!, 'North', `${moved}.5`);
  const block = Math.floor(moved! / BLOCK_ROWS);
  expect(fold.stale()).toEqual([block]);
  const alone = new SwarmFold('point');
  const own = rows.filter((r) => Math.floor(r / BLOCK_ROWS) === block);
  for (const r of own) alone.add(block, r, ...cells.get(r)!);
  fold.refold(block, alone);
  expect(fold.stale()).toEqual([]);
  expect(fold.snapshot().least).toBe(1.5);
  // A value whose every row an edit takes goes.
  const lone = new SwarmFold('point');
  lone.add(0, 0, 'Solo', '1');
  lone.remove(0, 0, 'Solo', '1');
  expect(lone.snapshot().strips).toEqual([]);
});
