/**
 * @fileoverview A source whose columns grow while it is indexed: the reply
 * that tells a client, and what a client does with it.
 */

import { expect, test } from 'vite-plus/test';

import type { ColumnInfo } from '@engine';
import { SCRIPTED_SOURCE, columnsOf, scriptedEngine } from './scripted.ts';

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
