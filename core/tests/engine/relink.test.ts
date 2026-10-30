/**
 * @fileoverview A relinked file is held to the kind of rows its source's log
 * was read as. A CSV source pointed at a Parquet file is refused and left as
 * it was, open or missing, and one pointed at another CSV replays its edits
 * over it. A JSON Lines source over parts, pointed at its file again, is read
 * as JSON Lines with the columns it found.
 */

import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

import { newManifest, writeDocument } from '@document';
import { FILE_COLUMN } from '@engine';
import type { Engine, SourceHandle, SourceRef } from '@engine';
import { read } from '@ingest';
import { Op } from '@sheet';
import { UNITS } from '@core-tests/testdata/sales-q3';
import {
  FIXTURE,
  bytes,
  connect,
  indexed,
  multiProviders,
  openOne,
  refusal,
  saidIn,
  testdata,
} from './harness.ts';
import {
  ID_KEY,
  LATE,
  LATE_KEY,
  NAME as LINES,
  SOURCE as EVENTS,
  workspace,
  written,
} from './late.ts';

/** The source's name, which its file is called. */
const NAME = 'sales-q3.csv';

/** The one edit made to the source before it is relinked. */
const EDITED = { row: 2, col: UNITS, now: '1204' };

/** The late key's column in a JSON Lines source, after its id column. */
const LATE_COL = 1;

/** Runs `use` with an engine and the fixture open on it with one edit. */
async function withEdited(
  use: (engine: Engine, src: SourceHandle) => Promise<void>,
): Promise<void> {
  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: NAME, path: FIXTURE });
    engine.mode(true);
    await src.edit({ op: Op.Set, ...EDITED });
    await use(engine, src);
  } finally {
    done();
  }
}

/** The edited cell as `src` reads it. */
async function editedIn(src: SourceHandle): Promise<string | undefined> {
  const { rows } = await src.rows(EDITED.row, 1);
  return rows[0]?.[EDITED.col];
}

test('a CSV source pointed at a Parquet file is refused, and left as it was', () =>
  withEdited(async (engine, src) => {
    const file = 'par1.bin';
    const refused = await refusal(
      engine.relink(src, { name: file, path: testdata(file) }),
    );
    expect(refused.said).toEqual({
      t: 'relink-other-kind',
      name: NAME,
      file,
      was: 'delimited',
      now: 'parquet',
    });
    expect(refused.message).toBe(
      'sales-q3.csv was read as delimited text, and par1.bin is Parquet',
    );
    expect(await editedIn(src)).toBe(EDITED.now);
  }));

test('a CSV source pointed at another CSV replays its edits over it', () =>
  withEdited(async (engine, src) => {
    const dir = await mkdtemp(join(tmpdir(), 'uno-relink-'));
    const path = join(dir, 'elsewhere.csv');
    await copyFile(FIXTURE, path);
    const back = await engine.relink(src, { name: 'elsewhere.csv', path });
    expect(back.opened.edits).toHaveLength(1);
    expect(await editedIn(back)).toBe(EDITED.now);
  }));

test('a missing CSV source pointed at a Parquet file stays missing, and takes a CSV', async () => {
  // A workspace whose source's file is gone, with the edit in its log.
  const dir = await mkdtemp(join(tmpdir(), 'uno-relink-'));
  const sheet = read(NAME, bytes);
  sheet.set(EDITED.row, EDITED.col, EDITED.now);
  const uno = writeDocument({
    manifest: newManifest(),
    sources: [
      {
        id: 'sales',
        name: NAME,
        path: join(dir, NAME),
        bytes: bytes.length,
        rows: sheet.rows(),
        cols: sheet.cols(),
        state: { active: { row: 0, col: 0 } },
      },
    ],
    active: 'sales',
    log: sheet.edits().map((edit) => ({ source: 'sales', edit })),
    extra: new Map(),
    at: '',
  });

  const { engine, done } = connect();
  try {
    const blob = new Blob([new Uint8Array(uno)]);
    const gone = await openOne(engine, { name: 'q3.uno', blob });
    expect(gone.opened.link?.missing).toBeDefined();

    const file = 'par1.bin';
    const refused = await refusal(
      engine.relink(gone, { name: file, path: testdata(file) }),
    );
    expect(refused.said).toMatchObject({
      t: 'relink-other-kind',
      now: 'parquet',
    });
    await expect(gone.rows(0, 1)).rejects.toThrow('point it at one');

    const back = await engine.relink(gone, { name: NAME, path: FIXTURE });
    expect(await editedIn(back)).toBe(EDITED.now);
  } finally {
    done();
  }
});

test('a JSON Lines source over parts, pointed at its file again, is read as JSON Lines with its edit', async () => {
  const file = await written();
  const { engine, done } = connect(undefined, multiProviders());
  try {
    const blob = workspace(file, 'part');
    const src = await openOne(engine, { name: 'q3.uno', blob });
    await indexed(src);
    engine.mode(true);
    await src.edit({ op: Op.Set, row: LATE, col: LATE_COL, now: EDITED.now });

    const ref: SourceRef = {
      name: EVENTS,
      parts: [{ ref: { name: LINES, path: file.path } }],
      header: 'first',
    };
    const back = await engine.relink(src, ref);
    expect(saidIn(back.opened.label)).toBe('UTF-8 · JSON Lines');
    expect(back.opened.columns.map((column) => column.header)).toEqual([
      ID_KEY,
      LATE_KEY,
      FILE_COLUMN,
    ]);
    await indexed(back);
    expect((await back.rows(LATE, 1)).rows).toEqual([
      [String(LATE), EDITED.now, LINES],
    ]);
  } finally {
    done();
  }
});
