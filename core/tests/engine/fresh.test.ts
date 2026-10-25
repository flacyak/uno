/**
 * @fileoverview Whether a file is still the one a source opened, told from one
 * stat of its path. The disk cases open and stat a real file.
 */

import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

import { connect, openOne } from './harness.ts';

const ADS = 'Ad_Date,Cost\n2024-11-16,$12.50\n2024-11-17,$8.00\n';

/**
 * When the file was written, in seconds. The fraction puts its modified time
 * past the half of a ms, where rounding and truncating to whole ms part ways.
 */
const WRITTEN_S = 1_793_148_441.2827;

/** A file holding ADS, last written at WRITTEN_S. */
async function written(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'uno-fresh-')), 'ads.csv');
  await writeFile(path, ADS);
  await utimes(path, WRITTEN_S, WRITTEN_S);
  return path;
}

test('an open and a stat agree, to the ms, on when a file was written', async () => {
  const path = await written();
  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: 'ads.csv', path });
    const { modified } = await engine.stat(path);
    expect(src.opened.link?.modified).toEqual(expect.any(Number));
    expect(src.opened.link?.modified).toBe(modified?.getTime());
  } finally {
    done();
  }
});
