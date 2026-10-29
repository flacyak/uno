/**
 * @fileoverview A source is heard from once the answer naming it is posted,
 * and not once it is closing, so its handle reads complete with its own rows.
 */

import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';

import { expect, test } from 'vite-plus/test';

import type { Provider } from '@plugin';
import { blobProvider, bytesSource } from '@store';
import { diskProvider } from '@store/node';
import { ROWS } from '@core-tests/testdata/sales-q3';
import { PART_FIXTURES, PART_NAMES } from '@core-tests/testdata/sales-q3-parts';
import { FIXTURE, TINY, connect, openOne } from './harness.ts';

const WHOLE = { name: 'sales-q3.csv', path: FIXTURE };
const PART = { name: PART_NAMES[0]!, path: PART_FIXTURES[0]! };

/** A save's bound on carried bytes. Both sources are read from the disk. */
const CARRIES_NOTHING = 0;

/**
 * handover returns a provider that reads WHOLE and PART into memory and holds
 * the last read of each: WHOLE's until PART is next opened or closed, and
 * PART's until `stale` settles. That open or close goes on two turns later,
 * by when WHOLE has been answered part way and then indexed to the end. A
 * close does not wait for a held read, as a bucket's does not.
 */
function handover(stale: Promise<void>): Provider {
  const disk = diskProvider();
  let release = (): void => {};
  const handed = async (): Promise<void> => {
    await turn();
    release();
    await turn();
  };
  return {
    ...disk,
    files: {
      ...disk.files,
      async open(ref) {
        const whole = 'path' in ref && ref.path === FIXTURE;
        if (!whole) await handed();
        const held = whole
          ? new Promise<void>((resolve) => (release = resolve))
          : stale;
        const source = bytesSource(readFileSync(whole ? FIXTURE : PART.path));
        return {
          size: source.size,
          async read(offset, length) {
            if (offset + length === source.size) await held;
            return source.read(offset, length);
          },
          close: () => (whole ? source.close() : handed()),
        };
      },
    },
  };
}

test('every handle an answer names reads complete with its own rows, and nothing from the view it replaced', async () => {
  const first = connect();
  let uno: Uint8Array;
  try {
    // PART is the .uno's first source and the showing one, and WHOLE neither.
    const part = await openOne(first.engine, PART);
    await openOne(first.engine, WHOLE);
    const place = { source: part.id, cells: [], at: '' };
    uno = await first.engine.save(place, CARRIES_NOTHING);
  } finally {
    first.done();
  }

  let stale = (): void => {};
  const held = new Promise<void>((resolve) => (stale = resolve));
  const { engine, done } = connect(TINY, [handover(held), blobProvider()]);
  try {
    const blob = new Blob([new Uint8Array(uno)]);
    const { sources } = await engine.open({ name: 'q3.uno', blob });
    const [part, whole] = sources;
    expect(whole!.opened.progress.complete).toBe(false);
    const repointed = await engine.relink(part!, WHOLE);
    expect(repointed.opened.progress.complete).toBe(false);
    // PART's last read comes back after the answer, once its view is closed.
    stale();
    // A round trip, after which what was posted behind the answers has landed.
    await repointed.rows(0, 1);
    expect(whole!.progress.complete).toBe(true);
    expect(repointed.progress).toMatchObject({ complete: true, rows: ROWS });
  } finally {
    done();
  }
});
