/**
 * @fileoverview A source that learns its columns from its rows saves them.
 * A workspace says a file was read as JSON Lines, and the file first holds a
 * key at row 50,000. Saved while its index is held just past the key, with
 * an edit in that key's column, the .uno is format 7 and pins each column
 * by name and key.
 */

import { expect, test } from 'vite-plus/test';

import { READ_VERSION, readContainer } from '@document';
import { FILE_COLUMN } from '@engine';
import { Op } from '@sheet';
import {
  ID_KEY,
  LATE_KEY,
  PAST_LATE,
  SOURCE,
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

/** Each layout's headers once the late key is known. */
const HEADERS: Record<Layout, readonly string[]> = {
  file: [ID_KEY, LATE_KEY],
  part: [ID_KEY, LATE_KEY, FILE_COLUMN],
};

/** The file, written once for every test here. */
const FILE = written();

/**
 * savedMidPass opens the file as `layout` and holds its index just past the
 * late key. It makes an edit in the late key's column at row EARLY and
 * saves while the index is still held.
 */
function savedMidPass(file: OnDisk, layout: Layout): Promise<Uint8Array> {
  const blob = workspace(file, layout);
  return withHeld(blob, file.late + PAST_LATE, async ({ engine, src }) => {
    engine.mode(true);
    await src.edit({
      op: Op.Set,
      row: EARLY,
      col: LATE_COL,
      now: EDITED,
      width: HEADERS[layout].length,
    });
    expect(src.progress.complete, 'the index is still held').toBe(false);
    const cells = [{ source: SOURCE, row: EARLY, col: LATE_COL }];
    return engine.save({ source: SOURCE, cells, at: '' }, NOTHING_CARRIED);
  });
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
