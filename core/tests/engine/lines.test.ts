/**
 * @fileoverview A workspace that says a source was read as JSON Lines opens
 * it as JSON Lines. Read through tiny blocks, the engine's rows equal a
 * reference parse of a file with blank lines, CRLF, a byte order mark,
 * broken lines and a key first seen deep in it, whether the workspace
 * pinned its columns or none, and a logged edit stays on its cell.
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
import { Sheet } from '@sheet';
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
