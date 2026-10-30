/**
 * @fileoverview A source that learns its columns from its rows saves them.
 * A workspace says a file was read as JSON Lines, and the file first holds a
 * key at row 50,000. Saved while its index is held just past the key, with
 * an edit in that key's column, the .uno is format 7 and pins each column
 * by name and key. Reopened, the edit is on its cell before the index
 * reaches the key, and the key takes its pinned column when it does. A late
 * key named _file keeps the name it showed beside the _file the source
 * supplies. A CSV saves as it always has, saying nothing of how it was read.
 */

import { expect, test } from 'vite-plus/test';

import {
  PARTS_VERSION,
  POINTED_VERSION,
  READ_VERSION,
  readContainer,
} from '@document';
import type { Logged } from '@document';
import { FILE_COLUMN } from '@engine';
import type { SourceHandle, SourceRef } from '@engine';
import { pointerTo } from '@ingest';
import { Op } from '@sheet';
import { manifestOf } from '@core-tests/document/manifest';
import { COLS, ROWS, UNITS, bytes } from '@core-tests/testdata/sales-q3';
import {
  PART_FIXTURES,
  PART_NAMES,
  partBytes,
} from '@core-tests/testdata/sales-q3-parts';
import {
  FIXTURE,
  connect,
  indexed,
  multiProviders,
  openOne,
  sales,
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
import type { Layout, OnDisk } from './late.ts';

/** A row well before LATE, which the index reaches first. */
const EARLY = 3;
/** The late key's column, which a widen puts after the id column. */
const LATE_COL = 1;
/** What the edit writes. */
const EDITED = 'edited';
/** The carried bytes a save allows: none, since the file is pointed at. */
const NOTHING_CARRIED = 0;

/** What a late key named _file shows as, beside the _file a source supplies. */
const SUFFIXED_FILE = `${FILE_COLUMN}_2`;

/** Each layout's headers once the late key is known. */
const HEADERS: Record<Layout, readonly string[]> = {
  file: [ID_KEY, LATE_KEY],
  part: [ID_KEY, LATE_KEY, FILE_COLUMN],
};

/** The file, written once for every test here. */
const FILE = written();

/** shown returns a row's data cells as a layout shows them, _file included. */
function shown(layout: Layout, cells: readonly string[]): string[] {
  return layout === 'part' ? [...cells, NAME] : [...cells];
}

/** headersOf returns each column's header as the source opened. */
function headersOf(src: SourceHandle): string[] {
  return src.opened.columns.map((column) => column.header);
}

/**
 * savedMidPass opens the file as `layout` and holds its index just past the
 * late key, where the source shows `headers`. It makes an edit in the late
 * key's column at row EARLY and saves while the index is still held.
 */
function savedMidPass(
  file: OnDisk,
  layout: Layout,
  headers = HEADERS[layout],
): Promise<Uint8Array> {
  const blob = workspace(file, layout);
  return withHeld(
    blob,
    file.late + PAST_LATE,
    async ({ engine, src, told }) => {
      engine.mode(true);
      await src.edit({
        op: Op.Set,
        row: EARLY,
        col: LATE_COL,
        now: EDITED,
        width: headers.length,
      });
      // The edit's answer comes after every reply posted before it.
      const last = [...told.values()].at(-1) ?? [];
      expect(last.map((column) => column.header)).toEqual(headers);
      expect(src.progress.complete, 'the index is still held').toBe(false);
      const cells = [{ source: SOURCE, row: EARLY, col: LATE_COL }];
      return engine.save({ source: SOURCE, cells, at: '' }, NOTHING_CARRIED);
    },
  );
}

test.each<Layout>(['file', 'part'])(
  'a %s saved while it is indexed is format 7, and pins each column it has found by name and key',
  async (layout) => {
    const uno = await savedMidPass(await FILE, layout);
    const { manifest, log } = readContainer('q3.uno', uno);
    expect(manifest.format).toBe(READ_VERSION);
    expect(manifest.sources[0]).toMatchObject({ kind: 'jsonl' });
    // Each key is the pointer of its name, so the manifest leaves it out.
    expect(manifest.sources[0]!.columns).toEqual([
      { name: ID_KEY },
      { name: LATE_KEY },
    ]);
    expect(log.map(({ edit }) => [edit.row, edit.col])).toEqual([
      [EARLY, LATE_COL],
    ]);
  },
);

test.each<Layout>(['file', 'part'])(
  'a %s saved while it is indexed reopens with the edit in a late column on its cell before the index reaches the key',
  async (layout) => {
    const file = await FILE;
    const blob = new Blob([new Uint8Array(await savedMidPass(file, layout))]);
    await withHeld(blob, file.late, async ({ src, release, told }) => {
      expect(headersOf(src)).toEqual(HEADERS[layout]);
      const unread = await src.rows(LATE, 1);
      expect(unread.rows, 'the index is short of the late key').toEqual([]);
      const edited = [shown(layout, [String(EARLY), EDITED])];
      expect((await src.rows(EARLY, 1)).rows).toEqual(edited);

      release();
      await indexed(src);
      expect(told.size, 'the late key took its pinned column').toBe(1);
      expect((await src.rows(LATE, 1)).rows).toEqual([
        shown(layout, cellsAt(LATE)),
      ]);
      expect((await src.rows(EARLY, 1)).rows).toEqual(edited);
    });
  },
);

test('a late key named _file keeps the name it showed beside the _file the source supplies, saved and reopened', async () => {
  const file = await written(FILE_COLUMN);
  // The supplied _file held the name first, so the key's column took a suffix.
  const headers = [ID_KEY, SUFFIXED_FILE, FILE_COLUMN];
  const uno = await savedMidPass(file, 'part', headers);
  expect(readContainer('q3.uno', uno).manifest.sources[0]!.columns).toEqual([
    { name: ID_KEY },
    { name: SUFFIXED_FILE, key: pointerTo('', FILE_COLUMN) },
  ]);

  const blob = new Blob([new Uint8Array(uno)]);
  await withHeld(blob, file.late, async ({ src, release, told }) => {
    expect(headersOf(src)).toEqual(headers);
    const edited = [String(EARLY), EDITED, NAME];
    expect((await src.rows(EARLY, 1)).rows).toEqual([edited]);
    release();
    await indexed(src);
    expect(told.size, 'the key took its pinned column').toBe(1);
    expect((await src.rows(LATE, 1)).rows).toEqual([[...cellsAt(LATE), NAME]]);
  });
});

/** The byte that ends a line. */
const LF = 0x0a;
/** The id a CSV source of the sales fixture takes. */
const SALES = 'sales-q3';

/** Delimited is a CSV source, and what its save has always written of it. */
interface Delimited {
  readonly ref: SourceRef;
  /** The format its .uno needs. */
  readonly format: number;
  /** The source as uno.json writes it, its keys in the order written. */
  readonly source: Record<string, unknown>;
}

/** headerBytes returns the length of a part's header line, which a later part skips. */
function headerBytes(part: Uint8Array): number {
  return part.indexOf(LF) + 1;
}

/** A CSV on its own, and the same rows as three parts, as a save wrote them before. */
const DELIMITED: Record<string, Delimited> = {
  'one file': {
    ref: { name: 'sales-q3.csv', path: FIXTURE },
    format: POINTED_VERSION,
    source: {
      id: SALES,
      name: 'sales-q3.csv',
      bytes: bytes.length,
      path: FIXTURE,
      rows: ROWS,
      cols: COLS,
    },
  },
  'three parts': {
    ref: {
      name: SALES,
      parts: PART_FIXTURES.map((path, i) => ({
        ref: { name: PART_NAMES[i]!, path },
      })),
      header: 'first',
    },
    format: PARTS_VERSION,
    source: {
      id: SALES,
      name: SALES,
      parts: partBytes.map((part, i) => {
        const bytes = { path: PART_FIXTURES[i]!, bytes: part.length };
        return i === 0 ? bytes : { ...bytes, skip: headerBytes(part) };
      }),
      header: 'first',
      rows: ROWS,
      cols: COLS,
    },
  },
};

test.each(Object.keys(DELIMITED))(
  'a CSV in %s saves as it always has, saying nothing of how it was read',
  async (held) => {
    const { ref, format, source } = DELIMITED[held]!;
    const { engine, done } = connect(undefined, multiProviders());
    try {
      const src = await openOne(engine, ref);
      engine.mode(true);
      const edit = { op: Op.Set, row: 0, col: UNITS, now: EDITED };
      await src.edit(edit);
      const cells = [{ source: src.id, row: 0, col: UNITS }];
      const uno = await engine.save(
        { source: src.id, cells, at: '' },
        NOTHING_CARRIED,
      );
      const manifest = manifestOf(uno);
      expect(manifest.format).toBe(format);
      // Compared as text, so the order uno.json writes keys in is held too.
      expect(JSON.stringify(manifest.sources[0])).toBe(JSON.stringify(source));
      const logged: Logged = {
        source: SALES,
        edit: { seq: 1, ...edit, was: sales.raw(0, UNITS) },
      };
      expect(readContainer('q3.uno', uno).log).toStrictEqual([logged]);
    } finally {
      done();
    }
  },
);
