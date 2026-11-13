/**
 * @fileoverview A saved index's key names the bytes and the reading it was
 * made from, and a change to any one field of it is told by name.
 */

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vite-plus/test';

import { TUNING } from '@engine';
import { differs, keyOf } from '@engine/key';
import { INDEX_VERSION } from '@engine/saved';
import { openFormat } from '@ingest';
import type { Format } from '@ingest';
import type { ByteSource } from '@store';
import { bytesSource } from '@store';
import { nodeSource } from '@store/node';

const CSV = new TextEncoder().encode('region,units\nWest,1204\nEast,987\n');

/** A source of CSV's bytes, measured as `measures` say. */
function sourceOf(measures: Partial<ByteSource> = {}): ByteSource {
  return { ...bytesSource(CSV), ...measures };
}

async function formatOf(source: ByteSource): Promise<Format> {
  return openFormat('orders.csv', source);
}

test('the key holds what the open measured, the sniffed format, the block rule and the scanner version', async () => {
  const source = sourceOf({ version: '"9b2cf5"' });
  const key = keyOf(source, await formatOf(source), TUNING);
  expect(JSON.parse(JSON.stringify(key))).toStrictEqual({
    bytes: CSV.length,
    version: '"9b2cf5"',
    delimiter: ',',
    encoding: 'utf-8',
    header: 'first',
    dataStart: 'region,units\n'.length,
    blockRows: TUNING.blockRows,
    blockBytes: TUNING.blockBytes,
    index: INDEX_VERSION,
  });
});

test('a change to any one field is told by its name', async () => {
  const source = sourceOf({ modified: 1_000, statusChanged: 2_000 });
  const format = await formatOf(source);
  const saved = keyOf(source, format, TUNING);
  const changed: Array<[string, ReturnType<typeof keyOf>]> = [
    ['bytes', keyOf({ ...source, size: CSV.length + 1 }, format, TUNING)],
    ['version', keyOf({ ...source, version: 'v2' }, format, TUNING)],
    ['modified', keyOf({ ...source, modified: 1_001 }, format, TUNING)],
    [
      'statusChanged',
      keyOf({ ...source, statusChanged: 2_001 }, format, TUNING),
    ],
    ['delimiter', keyOf(source, { ...format, delimiter: ';' }, TUNING)],
    ['encoding', keyOf(source, { ...format, encoding: 'utf-16le' }, TUNING)],
    ['header', keyOf(source, { ...format, header: 'none' }, TUNING)],
    ['dataStart', keyOf(source, { ...format, dataStart: 0 }, TUNING)],
    ['blockRows', keyOf(source, format, { ...TUNING, blockRows: 64 })],
    ['blockBytes', keyOf(source, format, { ...TUNING, blockBytes: 4096 })],
    ['index', { ...saved, index: INDEX_VERSION + 1 }],
  ];
  expect(differs(saved, saved)).toBeUndefined();
  for (const [field, now] of changed) {
    expect(differs(saved, now), field).toBe(field);
    expect(differs(JSON.parse(JSON.stringify(saved)), now), field).toBe(field);
  }
});

test('a field only one key holds differs, and one left out is one left undefined', async () => {
  const now = keyOf(sourceOf(), await formatOf(sourceOf()), TUNING);
  const saved = JSON.parse(JSON.stringify(now));
  expect(differs(saved, now), 'version is undefined in both').toBeUndefined();
  expect(differs({ ...saved, tally: 1 }, now)).toBe('tally');
});

test('a file on disk keys the same until it is touched, and by its change time once it is put back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uno-key-'));
  try {
    const path = join(dir, 'orders.csv');
    await writeFile(path, CSV);
    const keyAt = async () => {
      const source = await nodeSource(path);
      try {
        return keyOf(source, await formatOf(source), TUNING);
      } finally {
        await source.close();
      }
    };
    const saved = await keyAt();
    expect(differs(saved, await keyAt())).toBeUndefined();

    const { modified } = saved;
    await utimes(path, new Date(0), new Date(0));
    expect(differs(saved, await keyAt())).toBe('modified');

    // The modified time put back, as a rewrite that hides itself does. The
    // kernel stamps the change time a clock tick at a time, so the time is
    // put back until it moves.
    let now = saved;
    while (now.statusChanged === saved.statusChanged) {
      await utimes(path, new Date(modified!), new Date(modified!));
      now = await keyAt();
    }
    expect(differs(saved, now)).toBe('statusChanged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
