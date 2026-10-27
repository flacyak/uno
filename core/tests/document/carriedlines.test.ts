/**
 * @fileoverview A workspace that carries a JSON Lines file reads back in
 * readDocument the way the engine read it: every key in its column, the
 * edits on the same cells. An extensionless JSON Lines source is carried
 * under .jsonl.
 */

import { unzipSync } from 'fflate';
import { expect, test } from 'vite-plus/test';

import { readDocument } from '@document';
import type { Engine } from '@engine';
import { Op } from '@sheet';
import {
  connect,
  everyRow,
  indexed,
  multiProviders,
  openOne,
} from '@core-tests/engine/harness';
import { LATE, jsonLines, parsed } from '@core-tests/engine/reference';

/** A save limit larger than any carried source here. */
const ROOMY = 1 << 20;

/** What the edit writes. */
const EDITED = 'edited';

/** withEngine runs `use` with an engine that opens dropped files. */
async function withEngine(use: (engine: Engine) => Promise<void>) {
  const { engine, done } = connect(undefined, multiProviders());
  try {
    await use(engine);
  } finally {
    done();
  }
}

test('a dropped .jsonl saves, and readDocument replays its edits onto the same cells', () =>
  withEngine(async (engine) => {
    const text = jsonLines();
    const file = parsed(text);
    const src = await openOne(engine, {
      name: 'events.jsonl',
      blob: new Blob([text]),
    });
    await indexed(src);
    engine.mode(true);
    const col = file.keys.indexOf('/user/country');
    await src.edit({ op: Op.Set, row: LATE, col, now: EDITED });
    const rows = await everyRow(src);

    const uno = await engine.save({ source: src.id, cells: [], at: '' }, ROOMY);
    const doc = readDocument('q3.uno', uno);
    const sheet = doc.sheets!.get(src.id)!;
    expect(sheet.columns.map((column) => column.header)).toHaveLength(
      file.keys.length,
    );
    expect(sheet.rows()).toBe(rows.length);
    expect(sheet.raw(LATE, col)).toBe(EDITED);
    for (const [row, cells] of rows.entries()) {
      expect(
        cells.map((_, c) => sheet.raw(row, c)),
        `row ${row}`,
      ).toEqual(cells);
    }
  }));

test('an extensionless JSON Lines source is carried under .jsonl', () =>
  withEngine(async (engine) => {
    const src = await openOne(engine, {
      name: 'events',
      blob: new Blob(['{"id":1}\n{"id":2}\n']),
    });
    await indexed(src);
    const uno = await engine.save({ source: src.id, cells: [], at: '' }, ROOMY);
    const entries = Object.keys(unzipSync(uno));
    expect(entries.filter((entry) => entry.startsWith('data/'))).toEqual([
      `data/source/${src.id}.jsonl`,
    ]);
    expect(readDocument('q3.uno', uno).sheets!.get(src.id)!.rows()).toBe(2);
  }));
