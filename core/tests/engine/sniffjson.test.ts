/**
 * @fileoverview A .json file is JSON Lines when its first line is one JSON
 * object, as Spark and BigQuery write it, and opens so by name. Any other
 * .json is refused as JSON, with the words every earlier build used.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

import type { Engine, Said } from '@engine';
import {
  connect,
  everyRow,
  indexed,
  multiProviders,
  openOne,
  refusal,
  saidIn,
} from './harness.ts';

/** Page events as Spark writes them: one object per line, in a .json part. */
const PART = 'part-00000-3f2a.json';
const EVENTS = '{"id":1,"page":"/"}\n{"id":2,"page":"/pricing","ms":88}\n';

/** The same events as one JSON array, which is a document, not lines. */
const ARRAY = 'events.json';
const DOCUMENT = '[{"id":1,"page":"/"},{"id":2,"page":"/pricing","ms":88}]\n';

/** What the document is refused with, opened or peeked at. */
const REFUSED: Said = { t: 'not-read', name: ARRAY, what: 'JSON' };

/** withFiles runs `use` with both files on disk and an engine over the disk. */
async function withFiles(
  use: (engine: Engine, at: (name: string) => string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'uno-json-'));
  await writeFile(join(dir, PART), EVENTS);
  await writeFile(join(dir, ARRAY), DOCUMENT);
  const { engine, done } = connect(undefined, multiProviders());
  try {
    await use(engine, (name) => join(dir, name));
  } finally {
    done();
  }
}

test('a Spark part named .json whose lines are objects opens as JSON Lines', () =>
  withFiles(async (engine, at) => {
    const src = await openOne(engine, { name: PART, path: at(PART) });
    expect(saidIn(src.opened.label)).toBe('UTF-8 · JSON Lines');
    await indexed(src);
    expect(await everyRow(src)).toEqual([
      ['1', '/', ''],
      ['2', '/pricing', '88'],
    ]);
  }));

test('a .json holding one document is refused as JSON when opened', () =>
  withFiles(async (engine, at) => {
    const refused = await refusal(
      engine.open({ name: ARRAY, path: at(ARRAY) }),
    );
    expect(refused.said).toEqual(REFUSED);
    expect(refused.message).toBe(`${ARRAY}: JSON is not supported yet`);
  }));

test('a .json holding one document is refused the same when peeked at', () =>
  withFiles(async (engine, at) => {
    const refused = await refusal(
      engine.peek({ name: ARRAY, path: at(ARRAY) }),
    );
    expect(refused.said).toEqual(REFUSED);
  }));
