/**
 * @fileoverview A source whose columns grow while it is indexed. A workspace
 * says a file was read as JSON Lines, and the file first holds a key at row
 * 50,000, read through TINY blocks. A client is told every column once the
 * index meets the key, and hands the columns it is told to its handle.
 */

import { expect, test } from 'vite-plus/test';

import type { ColumnInfo, SourceHandle } from '@engine';
import { ID_KEY, LATE_KEY, withHeld, workspace, written } from './late.ts';
import type { Layout, Open } from './late.ts';
import { SCRIPTED_SOURCE, columnsOf, scriptedEngine } from './scripted.ts';

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

test('a client is told every column once the index meets a new key', () =>
  heldAs('file', async ({ src, release }) => {
    expect(headersOf(src.opened.columns)).toEqual([ID_KEY]);
    const told = nextColumns(src);
    release();
    const [columns, generation] = await told;
    expect(headersOf(columns)).toEqual([ID_KEY, LATE_KEY]);
    expect(generation).toBeGreaterThan(src.opened.generation);
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
