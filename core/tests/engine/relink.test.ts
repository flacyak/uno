/**
 * @fileoverview A relinked file is held to the kind of rows its source's log
 * was read as. A CSV source pointed at a Parquet file is refused and left as
 * it was.
 */

import { expect, test } from 'vite-plus/test';

import type { Engine, SourceHandle } from '@engine';
import { Op } from '@sheet';
import { UNITS } from '@core-tests/testdata/sales-q3';
import { FIXTURE, connect, openOne, refusal, testdata } from './harness.ts';

/** The source's name, which its file is called. */
const NAME = 'sales-q3.csv';

/** The one edit made to the source before it is relinked. */
const EDITED = { row: 2, col: UNITS, now: '1204' };

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
