/**
 * @fileoverview A source whose columns grow while it is indexed. A workspace
 * says a file was read as JSON Lines, and the file first holds a key at row
 * 50,000, read through TINY blocks. Rows keep their cells, and a client
 * hands the columns it is told to its handle.
 */

import { expect, test } from 'vite-plus/test';

import type { ColumnInfo, SourceHandle } from '@engine';
import { indexed, padded } from './harness.ts';
import {
  ID_KEY,
  LATE,
  LATE_KEY,
  cellsAt,
  withHeld,
  workspace,
  written,
} from './late.ts';
import type { Layout, Open } from './late.ts';
import { SCRIPTED_SOURCE, columnsOf, scriptedEngine } from './scripted.ts';

/** Rows a test reads at a time. */
const WINDOW = 10;
/**
 * A row near LATE the index reaches before it is held: a TINY chunk holds
 * fewer lines than this.
 */
const NEAR = LATE - 1_000;

const FILE = written();

/**
 * heldAs opens the file as `layout` and runs `use` while its index is held
 * `past` bytes after the start of row LATE: short of it unless said.
 */
async function heldAs(
  layout: Layout,
  use: (open: Open) => Promise<void>,
  past = 0,
): Promise<void> {
  const file = await FILE;
  return withHeld(workspace(file, layout), file.late + past, use);
}

/** nextColumns resolves with the columns and generation a source is next told. */
function nextColumns(src: SourceHandle): Promise<[ColumnInfo[], number]> {
  return new Promise((resolve) => {
    src.onColumns = (columns, generation) => resolve([columns, generation]);
  });
}

/** headersOf returns each column's header. */
function headersOf(columns: readonly ColumnInfo[]): string[] {
  return columns.map((column) => column.header);
}

/** expected returns `count` rows from `first` as the file holds them. */
function expected(first: number, count: number): string[][] {
  return Array.from({ length: count }, (_, i) => cellsAt(first + i));
}

test('rows read before and after the widen keep their cells', () =>
  heldAs('file', async ({ src, release }) => {
    expect(headersOf(src.opened.columns)).toEqual([ID_KEY]);
    const before = [await src.rows(0, WINDOW), await src.rows(NEAR, WINDOW)];
    const told = nextColumns(src);
    release();
    const [columns, generation] = await told;
    expect(headersOf(columns)).toEqual([ID_KEY, LATE_KEY]);
    expect(generation).toBeGreaterThan(src.opened.generation);
    await indexed(src);

    for (const page of before) {
      const want = expected(page.first, WINDOW);
      expect(padded(page.rows, 1)).toEqual(want.map(([id]) => [id]));
      const again = await src.rows(page.first, WINDOW);
      expect(padded(again.rows, columns.length)).toEqual(want);
    }
    const across = LATE - WINDOW / 2;
    const after = await src.rows(across, WINDOW);
    expect(padded(after.rows, columns.length)).toEqual(
      expected(across, WINDOW),
    );
  }));

test('a client hands the columns a source found to its handle, and drops ones older than it holds', async () => {
  const wide = columnsOf('id', 'late', 'later');
  const engine = scriptedEngine([
    { t: 'widened', source: SCRIPTED_SOURCE, generation: 2, columns: wide },
    {
      t: 'widened',
      source: SCRIPTED_SOURCE,
      generation: 1,
      columns: columnsOf('id', 'late'),
    },
    { t: 'widened', source: 'gone', generation: 3, columns: [] },
  ]);
  try {
    const { sources } = await engine.open({ name: 'q3.uno', path: '/q3.uno' });
    const src = sources[0]!;
    const told: Array<[ColumnInfo[], number]> = [];
    src.onColumns = (columns, generation) => told.push([columns, generation]);

    await src.rows(0, 1);
    expect(told).toEqual([[wide, 2]]);
    expect(src.generation, 'rows built before the widen are stale').toBe(2);
  } finally {
    engine.close();
  }
});
