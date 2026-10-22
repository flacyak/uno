/**
 * @fileoverview A source whose columns grow while it is indexed. A workspace
 * says a file was read as JSON Lines, and the file first holds a key at row
 * 50,000, read through TINY blocks. Rows and edits keep their cells, _file
 * moves right and still refuses every edit, an edit aimed at the columns
 * from before is refused once _file has moved, no rows reach a client over a
 * key its columns lack, and a client that knows no widened reply ignores it.
 */

import { expect, test } from 'vite-plus/test';

import { FILE_COLUMN } from '@engine';
import type { ColumnInfo, Reply, RowsReply, Said, SourceHandle } from '@engine';
import { Op } from '@sheet';
import {
  TINY,
  connect,
  indexed,
  multiProviders,
  openOne,
  padded,
  refusal,
} from './harness.ts';
import {
  ID_KEY,
  LATE,
  LATE_KEY,
  NAME,
  PAST_LATE,
  SOURCE,
  cellsAt,
  withHeld,
  workspace,
  written,
} from './late.ts';
import type { Layout, Open } from './late.ts';
import { SCRIPTED_SOURCE, columnsOf, scriptedEngine } from './scripted.ts';

/** Rows a test reads at a time. */
const WINDOW = 10;
/** A row read before the late key is met. */
const EARLY = 3;
/**
 * A row near LATE the index reaches before it is held: a TINY chunk holds
 * fewer lines than this.
 */
const NEAR = LATE - 1_000;
/** What an edit writes. */
const EDITED = 'edited';
/** Rows requests a client keeps in flight while the file is indexed. */
const IN_FLIGHT = 4;
/** What a fold says of an edit to _file. */
const FILE_REFUSED = /_file shows which file each row came from/;

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

/**
 * hammer keeps IN_FLIGHT requests for the rows around LATE in flight until
 * the source is indexed, and adds every page they read to `pages`.
 */
async function hammer(
  src: SourceHandle,
  pages: RowsReply[] = [],
): Promise<RowsReply[]> {
  const ask = async (): Promise<void> => {
    while (!src.progress.complete) {
      pages.push(await src.rows(LATE - WINDOW, 2 * WINDOW));
    }
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, ask));
  return pages;
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

test('an edit made before the widen stays on its cell, and one after lands on the new column', () =>
  heldAs('file', async ({ engine, src, release }) => {
    engine.mode(true);
    const early = await src.edit({
      op: Op.Set,
      row: EARLY,
      col: 0,
      now: EDITED,
    });
    expect(headersOf(early.columns)).toEqual([ID_KEY]);
    const told = nextColumns(src);
    release();
    await told;
    await indexed(src);

    expect((await src.rows(EARLY, 1)).rows).toEqual([[EDITED, '']]);
    const late = await src.edit({
      op: Op.Set,
      row: LATE + 1,
      col: 1,
      now: EDITED,
    });
    expect(headersOf(late.columns)).toEqual([ID_KEY, LATE_KEY]);
    expect((await src.rows(LATE, 2)).rows).toEqual([
      cellsAt(LATE),
      [String(LATE + 1), EDITED],
    ]);

    const undone = await src.undo();
    expect(headersOf(undone.columns), 'undo keeps the new column').toEqual([
      ID_KEY,
      LATE_KEY,
    ]);
    expect((await src.rows(LATE + 1, 1)).rows).toEqual([cellsAt(LATE + 1)]);
    expect((await src.rows(EARLY, 1)).rows).toEqual([[EDITED, '']]);

    // Aimed at the one column drawn before the widen, an edit still lands:
    // with no supplied column, no column moved.
    await src.edit({
      op: Op.Set,
      row: EARLY + 1,
      col: 0,
      now: EDITED,
      width: 1,
    });
    expect((await src.rows(EARLY + 1, 1)).rows).toEqual([[EDITED, '']]);
  }));

test('_file moves right past the new column, and still refuses every edit', () =>
  heldAs('part', async ({ engine, src, release }) => {
    expect(headersOf(src.opened.columns)).toEqual([ID_KEY, FILE_COLUMN]);
    expect((await src.rows(0, 1)).rows).toEqual([['0', NAME]]);
    engine.mode(true);
    const file = { op: Op.Set, row: 0, now: EDITED };
    await expect(src.edit({ ...file, col: 1, width: 2 })).rejects.toThrow(
      FILE_REFUSED,
    );

    const told = nextColumns(src);
    release();
    const [columns] = await told;
    expect(headersOf(columns)).toEqual([ID_KEY, LATE_KEY, FILE_COLUMN]);
    await indexed(src);

    expect((await src.rows(0, 1)).rows).toEqual([['0', '', NAME]]);
    expect((await src.rows(LATE, 1)).rows).toEqual([[...cellsAt(LATE), NAME]]);
    await expect(src.edit({ ...file, col: 2, width: 3 })).rejects.toThrow(
      FILE_REFUSED,
    );
    await src.edit({ ...file, col: 1, width: 3 });
    expect((await src.rows(0, 1)).rows).toEqual([['0', EDITED, NAME]]);
  }));

test('an edit aimed at the columns drawn before _file moved is refused, and the log is left as it was', () =>
  heldAs('part', async ({ engine, src, release }) => {
    engine.mode(true);
    // Drawn as id and _file, so column 1 was _file.
    const stale = { op: Op.Set, row: 0, col: 1, now: EDITED, width: 2 };
    const told = nextColumns(src);
    release();
    await told;

    const refused = await refusal(src.edit(stale));
    expect(refused.said).toEqual({ t: 'columns-moved', name: SOURCE });
    await expect(src.undo()).rejects.toThrow('there is nothing to undo');
    expect((await src.rows(0, 1)).rows).toEqual([['0', '', NAME]]);
    // Aimed at the columns it was told, the same edit lands.
    await src.edit({ ...stale, width: 3 });
    expect((await src.rows(0, 1)).rows).toEqual([['0', EDITED, NAME]]);
  }));

test.each<Layout>(['file', 'part'])(
  'no rows of a %s reach a client over a key its columns lack',
  (layout) =>
    heldAs(
      layout,
      async ({ src, release, told }) => {
        // The index has read row LATE whole, and holds there.
        const pages = [await src.rows(LATE - WINDOW, 2 * WINDOW)];
        release();
        await hammer(src, pages);
        expect(told.size, 'the late key widened the source once').toBe(2);

        let late = 0;
        for (const page of pages) {
          const columns = told.get(page.generation);
          expect(columns, `told at ${page.generation}`).toBeDefined();
          const headers = headersOf(columns ?? []);
          page.rows.forEach((row, i) => {
            const at = page.first + i;
            expect(row.length).toBeLessThanOrEqual(headers.length);
            if (at >= LATE) {
              late++;
              expect(row[headers.indexOf(LATE_KEY)], `row ${at}`).toBe(
                `l${at}`,
              );
            }
            if (layout === 'part') {
              expect(row[headers.indexOf(FILE_COLUMN)], `row ${at}`).toBe(NAME);
            }
          });
        }
        expect(
          late,
          'the page read while held has rows past LATE',
        ).toBeGreaterThan(WINDOW / 2);
      },
      PAST_LATE,
    ),
);

test('a client that knows no widened reply finds no request it answers, and a handle with no handler reads on', async () => {
  const file = await FILE;
  const replies: Reply[] = [];
  const { engine, done } = connect(TINY, multiProviders(), undefined, (reply) =>
    replies.push(reply),
  );
  const errors: Said[] = [];
  engine.onError = (said) => errors.push(said);
  try {
    const blob = workspace(file, 'file');
    const src = await openOne(engine, { name: 'q3.uno', blob });
    await hammer(src);

    const widened = replies.filter((reply) => reply.t === 'widened');
    expect(widened).toHaveLength(1);
    expect(
      widened[0],
      'an old client settles a reply by its id',
    ).not.toHaveProperty('id');
    expect(errors).toEqual([]);
    expect((await src.rows(LATE, 1)).rows).toEqual([cellsAt(LATE)]);
  } finally {
    done();
  }
});

// ------------------------------------------------------------ the client alone

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
