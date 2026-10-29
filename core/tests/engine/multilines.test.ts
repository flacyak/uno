/**
 * @fileoverview Several JSON Lines files read as one through the engine: the
 * parts join to the rows of the one file they are, every key met across
 * them has its column, a _file column names the part each row came from
 * either side of every boundary, a part appended is read as JSON Lines, and a
 * CSV among JSON Lines parts is refused by name.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

import type { Engine, SourceRef } from '@engine';
import type { SingleRef } from '@store';
import {
  TINY,
  connect,
  everyRow,
  indexed,
  multiProviders,
  openOne,
  padded,
  saidIn,
} from './harness.ts';
import { jsonLines, parsed, rowsOf } from './reference.ts';

/** What the parts are called as one source. */
const NAME = 'events';

/** How many parts the file is cut into. */
const PARTS = 3;

/** The byte that ends a line, where the file is cut. */
const LF = '\n';

/** cut cuts `text` into PARTS pieces at line ends, so the pieces join to it. */
function cut(text: string): string[] {
  const pieces: string[] = [];
  let from = 0;
  for (let i = 1; i < PARTS; i++) {
    const at = text.indexOf(LF, Math.floor((text.length * i) / PARTS)) + 1;
    pieces.push(text.slice(from, at));
    from = at;
  }
  pieces.push(text.slice(from));
  return pieces;
}

/** rowsIn counts the lines of a piece that hold more than blanks: its rows. */
function rowsIn(piece: string): number {
  return piece.split(LF).filter((line) => /[^ \t\r]/.test(line)).length;
}

/** OnDisk is the file's pieces written to a folder of their own. */
interface OnDisk {
  text: string;
  pieces: string[];
  files: SingleRef[];
}

/** written writes the reference file's pieces to disk as events-1.jsonl and on. */
async function written(): Promise<OnDisk> {
  const text = jsonLines();
  const pieces = cut(text);
  const dir = await mkdtemp(join(tmpdir(), 'uno-multilines-'));
  const files: SingleRef[] = [];
  for (const [i, piece] of pieces.entries()) {
    const name = `events-${i + 1}.jsonl`;
    await writeFile(join(dir, name), piece);
    files.push({ name, path: join(dir, name) });
  }
  return { text, pieces, files };
}

/** asOne is the parts as one ref, with a _file column when asked. */
function asOne(files: readonly SingleRef[], fileColumn = false): SourceRef {
  const ref: SourceRef = {
    name: NAME,
    parts: files.map((file) => ({ ref: file })),
    header: 'first',
  };
  return fileColumn ? { ...ref, fileColumn } : ref;
}

/** withEngine runs `use` with an engine under TINY tuning over the disk. */
async function withEngine(use: (engine: Engine) => Promise<void>) {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    await use(engine);
  } finally {
    done();
  }
}

test('three JSON Lines parts read as the one file they were cut from, every key met', () =>
  withEngine(async (engine) => {
    const { text, files } = await written();
    const src = await openOne(engine, asOne(files));
    expect(saidIn(src.opened.label)).toBe('UTF-8 · JSON Lines');
    await indexed(src);
    const file = parsed(text);
    expect(padded(await everyRow(src), file.keys.length)).toEqual(
      rowsOf(file, file.keys),
    );
  }));

test('parts with different keys union them, in the order the parts meet them', () =>
  withEngine(async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'uno-multilines-'));
    const files: SingleRef[] = [];
    for (const [name, lines] of [
      ['a.jsonl', '{"id":1,"a":"x"}\n'],
      ['b.jsonl', '{"id":2,"b":"y"}\n{"c":"z"}\n'],
    ]) {
      await writeFile(join(dir, name!), lines!);
      files.push({ name: name!, path: join(dir, name!) });
    }
    const src = await openOne(engine, asOne(files));
    await indexed(src);
    expect(await everyRow(src)).toEqual([
      ['1', 'x', '', ''],
      ['2', '', 'y', ''],
      ['', '', '', 'z'],
    ]);
  }));

test('_file names the part each row came from, either side of every boundary', () =>
  withEngine(async (engine) => {
    const { pieces, files } = await written();
    const src = await openOne(engine, asOne(files, true));
    await indexed(src);
    const rows = await everyRow(src);
    const names = rows.map((row) => row.at(-1));
    let first = 0;
    for (const [i, piece] of pieces.entries()) {
      const last = first + rowsIn(piece) - 1;
      expect(names[first], `the first row of part ${i + 1}`).toBe(
        files[i]!.name,
      );
      expect(names[last], `the last row of part ${i + 1}`).toBe(files[i]!.name);
      first = last + 1;
    }
    expect(first).toBe(rows.length);
  }));

test('a JSON Lines part appended to JSON Lines parts is read as JSON Lines, with every key', () =>
  withEngine(async (engine) => {
    const { text, files } = await written();
    const src = await openOne(engine, asOne(files.slice(0, -1)));
    await indexed(src);
    const longer = await engine.append(src, files.slice(-1));
    expect(saidIn(longer.opened.label)).toBe('UTF-8 · JSON Lines');
    await indexed(longer);
    const file = parsed(text);
    expect(padded(await everyRow(longer), file.keys.length)).toEqual(
      rowsOf(file, file.keys),
    );
  }));

test('a CSV among JSON Lines parts is refused by name', () =>
  withEngine(async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'uno-multilines-'));
    await writeFile(join(dir, 'a.jsonl'), '{"id":1}\n');
    await writeFile(join(dir, 'b.csv'), 'id\n2\n');
    const files: SingleRef[] = [
      { name: 'a.jsonl', path: join(dir, 'a.jsonl') },
      { name: 'b.csv', path: join(dir, 'b.csv') },
    ];
    await expect(engine.open(asOne(files))).rejects.toThrow(
      'b.csv (part 2 of 2): it is delimited text and a.jsonl is JSON Lines',
    );
  }));
