/**
 * @fileoverview Whether a file is still the one a source opened, told from one
 * stat of its path. The disk cases open and stat a real file.
 */

import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

import { unchanged } from '@engine';
import { modifiedMs, statusChangedMs } from '@store/disklister';
import { connect, openOne } from './harness.ts';

const ADS = 'Ad_Date,Cost\n2024-11-16,$12.50\n2024-11-17,$8.00\n';

/**
 * When the file was written, in seconds. The fraction puts its modified time
 * past the half of a ms, where rounding and truncating to whole ms part ways.
 */
const WRITTEN_S = 1_793_148_441.2827;
/** A second after it, as a touch would leave it. */
const TOUCHED_S = WRITTEN_S + 1;

/** A file holding ADS, last written at WRITTEN_S. */
async function written(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'uno-fresh-')), 'ads.csv');
  await writeFile(path, ADS);
  await utimes(path, WRITTEN_S, WRITTEN_S);
  return path;
}

test('a file is unchanged until it is touched or rewritten at another size', async () => {
  const path = await written();
  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: 'ads.csv', path });
    // One stat of the path, held against what the open measured.
    const fresh = async (): Promise<boolean> =>
      unchanged(src.opened.link!, src.opened.size, await engine.stat(path));
    expect(await fresh(), 'nobody touched it').toBe(true);
    await utimes(path, TOUCHED_S, TOUCHED_S);
    expect(await fresh(), 'touched').toBe(false);
    await writeFile(path, `${ADS}2024-11-18,$3.10\n`);
    await utimes(path, WRITTEN_S, WRITTEN_S);
    expect(await fresh(), 'rewritten at another size').toBe(false);
  } finally {
    done();
  }
});

test('a rewrite that keeps the size and the modified time is seen by its change time', async () => {
  const path = await written();
  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: 'ads.csv', path });
    const was = await stat(path);
    // One cent more, the same length, and the time put back, as a copy that
    // keeps times (cp -p, rsync -t) leaves it. The kernel stamps the change
    // time a clock tick at a time, so the rewrite goes on until it moves.
    let now = was;
    while (statusChangedMs(now) === statusChangedMs(was)) {
      await writeFile(path, ADS.replace('$12.50', '$12.51'));
      await utimes(path, WRITTEN_S, WRITTEN_S);
      now = await stat(path);
    }
    expect([now.size, modifiedMs(now)]).toEqual([was.size, modifiedMs(was)]);
    const entry = await engine.stat(path);
    expect(unchanged(src.opened.link!, src.opened.size, entry)).toBe(false);
  } finally {
    done();
  }
});

test('versions decide where there is one, and a file that says neither is never unchanged', () => {
  const at = { name: 'ads.csv', path: 's3://acme/ads.csv', folder: false };
  const link = { path: at.path, version: '"a"' };
  const now = { ...at, version: '"a"' };
  expect(unchanged(link, ADS.length, now)).toBe(true);
  expect(unchanged(link, ADS.length, { ...at, version: '"b"' })).toBe(false);
  expect(unchanged(link, ADS.length, at)).toBe(false);
  expect(unchanged({ path: at.path }, ADS.length, now)).toBe(false);
  // Without a version, a file must say when it was written to be unchanged.
  const bare = { ...at, bytes: ADS.length };
  expect(unchanged({ path: at.path }, ADS.length, bare)).toBe(false);
});
