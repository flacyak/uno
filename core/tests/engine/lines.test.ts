/**
 * @fileoverview A .jsonl file opened by name, or through a workspace that
 * says its source was read as JSON Lines, opens as JSON Lines. Read through
 * tiny blocks, the engine's rows equal a reference parse of a file with
 * blank lines, CRLF, a byte order mark, broken lines and a key first seen
 * deep in it, whether the workspace pinned its columns or none, a logged
 * edit stays on its cell, a find lands down and up, and a save reopens as
 * JSON Lines.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

import {
  READ_VERSION,
  newManifest,
  readContainer,
  writeDocument,
} from '@document';
import type { SavedColumn } from '@document';
import type { Engine } from '@engine';
import { Op, Sheet } from '@sheet';
import { manifestOf } from '@core-tests/document/manifest';
import {
  TINY,
  connect,
  everyRow,
  indexed,
  multiProviders,
  openOne,
  padded,
  saidIn,
} from './harness.ts';
import { LATE, LINES, jsonLines, parsed, rowsOf } from './reference.ts';

/** What the logged edit writes. */
const EDITED = 'edited';

/** No bytes carried: the source is pointed at. */
const NOTHING_CARRIED = 0;

/** The key a find searches and an edit lands in. */
const COUNTRY = '/user/country';

/**
 * workspace writes a .uno over the file at `path` that says it was read as
 * JSON Lines, with `columns` pinned and `sheet`'s edits logged.
 */
function workspace(
  path: string,
  bytes: number,
  sheet: Sheet,
  columns?: SavedColumn[],
): Blob {
  const uno = writeDocument({
    manifest: newManifest(),
    sources: [
      {
        id: 'events',
        name: 'events.jsonl',
        path,
        bytes,
        kind: 'jsonl',
        columns,
        rows: sheet.rows(),
        cols: sheet.cols(),
        state: { active: { row: 0, col: 0 } },
      },
    ],
    active: 'events',
    log: sheet.edits().map((edit) => ({ source: 'events', edit })),
    extra: new Map(),
    at: '',
  });
  expect(readContainer('q3.uno', uno).manifest.format).toBe(READ_VERSION);
  return new Blob([new Uint8Array(uno)]);
}

/** withFile runs `use` with an engine under TINY tuning and the file on disk. */
async function withFile(
  use: (engine: Engine, path: string, text: string) => Promise<void>,
): Promise<void> {
  const text = jsonLines();
  const path = join(await mkdtemp(join(tmpdir(), 'uno-lines-')), 'e.jsonl');
  await writeFile(path, text);
  const { engine, done } = connect(TINY, multiProviders());
  try {
    await use(engine, path, text);
  } finally {
    done();
  }
}

test('pinning no columns, every row is the reference parse, the late key and broken lines included', () =>
  withFile(async (engine, path, text) => {
    const file = parsed(text);
    expect(file.lines).toHaveLength(LINES);
    expect(file.keys).toContain('');
    expect(file.keys).toContain('/user.name');

    const bytes = new TextEncoder().encode(text).length;
    const blob = workspace(path, bytes, new Sheet('events.jsonl', [], []));
    const src = await openOne(engine, { name: 'q3.uno', blob });
    expect(saidIn(src.opened.label)).toBe('UTF-8 · JSON Lines');
    await indexed(src);
    const rows = await everyRow(src);
    expect(padded(rows, file.keys.length)).toEqual(rowsOf(file, file.keys));
  }));

test('pinning every column in its own order, each key finds its column and an edit stays on its cell', () =>
  withFile(async (engine, path, text) => {
    const file = parsed(text);
    // Pinned backwards, and the id column by its name alone.
    const keys = file.keys.toReversed();
    const columns = keys.map((key, i): SavedColumn => {
      return key === '/id' ? { name: 'id' } : { name: `c${i}`, key };
    });
    const sheet = new Sheet(
      'events.jsonl',
      columns.map((column) => column.name),
      rowsOf(file, keys),
    );
    const edit = { row: LATE, col: keys.indexOf('/user/name') };
    sheet.set(edit.row, edit.col, EDITED);

    const bytes = new TextEncoder().encode(text).length;
    const blob = workspace(path, bytes, sheet, columns);
    const src = await openOne(engine, { name: 'q3.uno', blob });
    expect(src.opened.columns.map((c) => c.header)).toEqual(
      columns.map((column) => column.name),
    );
    await indexed(src);
    const want = rowsOf(file, keys);
    want[edit.row]![edit.col] = EDITED;
    expect(await everyRow(src)).toEqual(want);
  }));

/**
 * rowShowing returns the first row past `from` in `dir` whose cell is `text`,
 * or null, as a find over `cells` should land.
 */
function rowShowing(
  cells: readonly string[],
  from: number,
  dir: 1 | -1,
  text: string,
): number | null {
  for (let row = from + dir; row >= 0 && row < cells.length; row += dir) {
    if (cells[row] === text) return row;
  }
  return null;
}

test('opened by name, every row is the reference parse, and a find lands down and up', () =>
  withFile(async (engine, path, text) => {
    const file = parsed(text);
    const src = await openOne(engine, { name: 'e.jsonl', path });
    expect(saidIn(src.opened.label)).toBe('UTF-8 · JSON Lines');
    await indexed(src);
    const rows = await everyRow(src);
    expect(padded(rows, file.keys.length)).toEqual(rowsOf(file, file.keys));

    const col = file.keys.indexOf(COUNTRY);
    const countries = rowsOf(file, file.keys).map((row) => row[col]!);
    const last = countries.length - 1;
    const find = (from: number, dir: 1 | -1) =>
      src.find({ col, from, dir, match: { t: 'text', text: 'BR' } });
    const down = await find(0, 1);
    expect(down.row).toBe(rowShowing(countries, 0, 1, 'BR'));
    expect(down.row).toBeGreaterThan(0);
    const up = await find(last, -1);
    expect(up.row).toBe(rowShowing(countries, last, -1, 'BR'));
    expect(up.row).toBeLessThan(last);
  }));

test('opened by name, saved and opened again, is JSON Lines with its edit in place, as format 7', () =>
  withFile(async (engine, path, text) => {
    const file = parsed(text);
    const src = await openOne(engine, { name: 'e.jsonl', path });
    await indexed(src);
    engine.mode(true);
    const edit = { row: LATE, col: file.keys.indexOf(COUNTRY) };
    await src.edit({ op: Op.Set, ...edit, now: EDITED });

    const uno = await engine.save(
      { source: src.id, cells: [], at: '' },
      NOTHING_CARRIED,
    );
    const manifest = manifestOf(uno);
    expect(manifest.format).toBe(READ_VERSION);
    expect(manifest.sources[0]).toMatchObject({ kind: 'jsonl' });
    expect(manifest.sources[0]!['columns']).toHaveLength(file.keys.length);

    // A workspace opens in an engine of its own.
    const second = connect(TINY, multiProviders());
    try {
      const again = await openOne(second.engine, {
        name: 'q3.uno',
        blob: new Blob([new Uint8Array(uno)]),
      });
      expect(saidIn(again.opened.label)).toBe('UTF-8 · JSON Lines');
      expect(again.opened.edits).toHaveLength(1);
      await indexed(again);
      const want = rowsOf(file, file.keys);
      want[edit.row]![edit.col] = EDITED;
      expect(padded(await everyRow(again), file.keys.length)).toEqual(want);
    } finally {
      second.done();
    }
  }));
