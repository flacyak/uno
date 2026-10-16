/**
 * @fileoverview A file this build does not read yet, opened fresh, is refused
 * by name: JSON Lines, a gzip-compressed CSV and a Parquet file. Each is
 * refused when opened alone, when peeked at and as a part of several files.
 * A source a workspace already logged edits against is read as it was when
 * they were made, and a file appended to it is detected as a fresh part is.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vite-plus/test';

import { newManifest, writeDocument } from '@document';
import type { HeldPart } from '@document';
import type { Engine, Said } from '@engine';
import { read } from '@ingest';
import type { Unread } from '@said';
import {
  connect,
  multiProviders,
  openOne,
  refusal,
  saidIn,
  testdata,
} from './harness.ts';

/** Each fixture, and what it holds that this build does not read. */
const UNREAD: ReadonlyArray<readonly [string, Unread]> = [
  ['events.jsonl', 'JSON Lines'],
  ['sales-q3.csv.gz', 'gzip'],
  ['par1.bin', 'Parquet'],
];

/** A part beside each fixture that is read: the first third of the export. */
const PART = 'sales-q3-part-1.csv';

/** The byte that ends a line. */
const LF = 0x0a;

/** Runs `use` with an engine that opens files, blobs and parts. */
async function withEngine(use: (engine: Engine) => Promise<void>) {
  const { engine, done } = connect(undefined, multiProviders());
  try {
    await use(engine);
  } finally {
    done();
  }
}

describe.each(UNREAD)('%s', (name, what) => {
  const said: Said = { t: 'not-read', name, what };
  const ref = { name, path: testdata(name) };

  test('opened on its own is refused by name', () =>
    withEngine(async (engine) => {
      const refused = await refusal(engine.open(ref));
      expect(refused.said).toEqual(said);
      expect(refused.message).toBe(`${name}: ${what} is not supported yet`);
    }));

  test('peeked at is refused by name', () =>
    withEngine(async (engine) => {
      expect((await refusal(engine.peek(ref))).said).toEqual(said);
    }));

  test('as a part beside a CSV is refused by name, naming the part', () =>
    withEngine(async (engine) => {
      for (const [parts, at] of [
        [[{ ref: { name: PART, path: testdata(PART) } }, { ref }], 2],
        [[{ ref }, { ref: { name: PART, path: testdata(PART) } }], 1],
      ] as const) {
        const asked = engine.open({ name: 'q3', parts, header: 'first' });
        const refused = await refusal(asked);
        expect(refused.said).toEqual({
          t: 'about',
          subject: `${name} (part ${at} of 2)`,
          why: said,
        });
      }
    }));
});

describe('a .jsonl a workspace logged edits against before', () => {
  const name = 'events.jsonl';
  const path = testdata(name);
  const bytes = new Uint8Array(readFileSync(path));

  // As it was read when the edits were made: delimited text, split at commas.
  const sheet = read(name, bytes);
  const EDITED = { row: 2, col: 1, now: 'edited' };
  sheet.set(EDITED.row, EDITED.col, EDITED.now);

  /** A format 6 workspace holding the source as `held`, with the edit. */
  function workspace(
    held:
      | { path: string; bytes: number }
      | { raw: Uint8Array }
      | { parts: HeldPart[]; header: 'first' },
  ): Blob {
    // Each part under a header row holds the rows the one file does.
    const files = 'parts' in held ? held.parts.length : 1;
    const uno = writeDocument({
      manifest: newManifest(),
      sources: [
        {
          id: 'events',
          name,
          rows: sheet.rows() * files,
          cols: sheet.cols(),
          state: { active: { row: 0, col: 0 } },
          ...held,
        },
      ],
      active: 'events',
      log: sheet.edits().map((edit) => ({ source: 'events', edit })),
      extra: new Map(),
      at: '',
    });
    return new Blob([new Uint8Array(uno)]);
  }

  /** Whether `src` reads as the edits were made, with the edit on its cell. */
  async function asLogged(
    src: Awaited<ReturnType<typeof openOne>>,
  ): Promise<void> {
    expect(saidIn(src.opened.link?.missing)).toBeUndefined();
    expect(saidIn(src.opened.link?.changed)).toBeUndefined();
    expect(src.opened.edits).toHaveLength(1);
    expect(src.opened.columns.map((c) => c.header)).toEqual(
      sheet.columns.map((c) => c.header),
    );
    const { rows } = await src.rows(EDITED.row, 1);
    expect(rows[0]![EDITED.col]).toBe(EDITED.now);
  }

  test('pointed at, reopens with its edits on the same cells', () =>
    withEngine(async (engine) => {
      const uno = workspace({ path, bytes: bytes.length });
      await asLogged(await openOne(engine, { name: 'q3.uno', blob: uno }));
    }));

  test('carried, reopens with its edits on the same cells', () =>
    withEngine(async (engine) => {
      const uno = workspace({ raw: bytes });
      await asLogged(await openOne(engine, { name: 'q3.uno', blob: uno }));
    }));

  test('relinked, is read as its edits were made', () =>
    withEngine(async (engine) => {
      const uno = workspace({ path, bytes: bytes.length });
      const src = await openOne(engine, { name: 'q3.uno', blob: uno });
      await asLogged(await engine.relink(src, { name, path }));
    }));

  test('read as one with a copy of itself, refuses a .jsonl appended to it by name', () =>
    withEngine(async (engine) => {
      const dir = await mkdtemp(join(tmpdir(), 'uno-unread-'));
      /** Copy `n` of the file, in its own name. */
      async function copy(n: number): Promise<{ name: string; path: string }> {
        const file = `events-${n}.jsonl`;
        await writeFile(join(dir, file), bytes);
        return { name: file, path: join(dir, file) };
      }
      const [one, two, three] = [await copy(1), await copy(2), await copy(3)];
      // Measured as delimited text under a header row, as the edits were made.
      const measured = (
        file: { name: string; path: string },
        skip: number,
      ): HeldPart => ({
        ...file,
        bytes: bytes.length,
        skip,
        unterminated: bytes.at(-1) !== LF,
      });
      const header = bytes.indexOf(LF) + 1;
      const uno = workspace({
        parts: [measured(one, 0), measured(two, header)],
        header: 'first',
      });
      const src = await openOne(engine, { name: 'q3.uno', blob: uno });
      await asLogged(src);

      const refused = await refusal(engine.append(src, [three]));
      expect(refused.said).toEqual({
        t: 'about',
        subject: `${three.name} (part 3 of 3)`,
        why: { t: 'not-read', name: three.name, what: 'JSON Lines' },
      });
    }));
});
