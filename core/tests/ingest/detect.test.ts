/**
 * @fileoverview A file's stored bytes say whether it is Parquet or
 * compressed before any text is sniffed, and its name and first line then
 * say whether it is JSON Lines or delimited text.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vite-plus/test';

import { PARQUET_MAGIC_BYTES, detect, kindOf } from '@ingest/detect';
import type { Detected, StoredHead } from '@ingest/detect';
import { sniffEncoding } from '@ingest/sniff';
import type { ReadKind, Unread } from '@said';
import { random } from '@core-tests/random';

/** The fixtures' folder, ending in its separator. */
const testdata = fileURLToPath(new URL('../testdata/', import.meta.url));

/** How much of a file a head holds here: as much as a peek reads. */
const HEAD_BYTES = 64 << 10;

const encoder = new TextEncoder();

/** A stored file's head, and the length of every tail read asked of it. */
function stored(file: Uint8Array | string): {
  head: StoredHead;
  tails: number[];
} {
  const bytes = typeof file === 'string' ? encoder.encode(file) : file;
  const tails: number[] = [];
  const head: StoredHead = {
    bytes: bytes.subarray(0, HEAD_BYTES),
    size: bytes.length,
    tail: (length) => {
      tails.push(length);
      return Promise.resolve(bytes.subarray(bytes.length - length));
    },
  };
  return { head, tails };
}

/** What `name` holding `file` is detected as. */
function detected(name: string, file: Uint8Array | string): Promise<Detected> {
  return detect(name, stored(file).head);
}

const DELIMITED: Detected = { t: 'records', layout: 'delimited' };
/** JSON Lines, read one object per line. */
const LINES: Detected = { t: 'records', layout: 'lines' };

function unread(what: Unread): Detected {
  return { t: 'not-read', what };
}

/** bytesOf joins byte values and ASCII text into one array. */
function bytesOf(
  ...parts: ReadonlyArray<readonly number[] | string>
): Uint8Array {
  return Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...encoder.encode(p)] : p)),
  );
}

const PAR1 = 'PAR1';

/** Bytes after a magic, standing for the rest of its stream. */
const BODY = [0x15, 0x00, 0x15, 0x1c];

/** A footer length, little-endian, as a Parquet file ends with before its magic. */
const FOOTER_LENGTH = [BODY.length, 0x00, 0x00, 0x00];

/** A Parquet file's shape: its magic, a body, a footer length, its magic. */
const PARQUET = bytesOf(PAR1, BODY, FOOTER_LENGTH, PAR1);

const BZIP2_BLOCK = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
const BZIP2_END = [0x17, 0x72, 0x45, 0x38, 0x50, 0x90];

/** Each magic, then bytes as its stream would hold them. */
const MAGICS: ReadonlyArray<readonly [Unread, Uint8Array]> = [
  ['Parquet', PARQUET],
  ['gzip', new Uint8Array(gzipSync('date,units\n2026-07-01,1204\n'))],
  ['zstd', bytesOf([0x28, 0xb5, 0x2f, 0xfd], BODY)],
  ['bzip2', bytesOf('BZh9', BZIP2_BLOCK, BODY)],
  ['bzip2', bytesOf('BZh1', BZIP2_END, BODY)],
  ['xz', bytesOf([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], BODY)],
  ['snappy', bytesOf([0xff, 0x06, 0x00, 0x00], 'sNaPpY', BODY)],
  ['LZ4', bytesOf([0x04, 0x22, 0x4d, 0x18], BODY)],
  ['zip', bytesOf('PK', [0x03, 0x04], BODY)],
];

describe('the bytes decide first', () => {
  test.each(MAGICS)('%s is recognised by its magic', async (what, bytes) => {
    for (const name of ['data.csv', 'data.jsonl', 'data'])
      expect(await detected(name, bytes), name).toEqual(unread(what));
  });

  test('a PAR1 head is Parquet only where the file ends with PAR1', async () => {
    const parquet = stored(PARQUET);
    expect(await detect('q3.parquet', parquet.head)).toEqual(unread('Parquet'));
    expect(parquet.tails).toEqual([PARQUET_MAGIC_BYTES]);

    const text = stored('PAR1,units\n2026-07-01,1204\n');
    expect(await detect('q3.parquet', text.head)).toEqual(DELIMITED);
    expect(text.tails).toEqual([PARQUET_MAGIC_BYTES]);

    // An encrypted footer's magic, the same at each end.
    const encrypted = bytesOf('PARE', BODY, FOOTER_LENGTH, 'PARE');
    expect(await detected('q3.parquet', encrypted)).toEqual(unread('Parquet'));
    const mixed = bytesOf(PAR1, BODY, FOOTER_LENGTH, 'PARE');
    expect(await detected('q3.parquet', mixed)).toEqual(DELIMITED);

    // Too short to hold a footer: its tail is its own head.
    const short = stored(PAR1);
    expect(await detect('q3.parquet', short.head)).toEqual(DELIMITED);
    expect(short.tails).toEqual([]);
  });

  test('the tail is read only for a PAR1 head', async () => {
    for (const [, bytes] of MAGICS.filter(([what]) => what !== 'Parquet')) {
      const file = stored(bytes);
      await detect('data.csv', file.head);
      expect(file.tails).toEqual([]);
    }
    const csv = stored('date,units\n2026-07-01,1204\n');
    await detect('q3.csv', csv.head);
    expect(csv.tails).toEqual([]);
  });

  test("'BZh' text without the block magic stays text", async () => {
    expect(await detected('notes.csv', 'BZh9,units\n1,2\n')).toEqual(DELIMITED);
    expect(await detected('notes', 'BZh\n')).toEqual(DELIMITED);
    // A digit out of range, before a block magic.
    const zero = bytesOf('BZh0', BZIP2_BLOCK);
    expect(await detected('notes.csv', zero)).toEqual(DELIMITED);
  });

  test('gzip bytes no longer look like UTF-16', async () => {
    const gzip = new Uint8Array(gzipSync('a,b\n1,2\n'));
    expect(sniffEncoding(gzip)).not.toBe('utf-8');
    expect(await detected('q3.csv.gz', gzip)).toEqual(unread('gzip'));
  });

  test('an empty head and a one-byte head are text', async () => {
    for (const bytes of [
      new Uint8Array(),
      Uint8Array.of(0x1f),
      Uint8Array.of(0x50),
    ]) {
      const file = stored(bytes);
      expect(await detect('q3.csv', file.head)).toEqual(DELIMITED);
      expect(await detect('q3', file.head)).toEqual(DELIMITED);
      expect(file.tails).toEqual([]);
    }
    expect(await detected('q3.jsonl', '')).toEqual(LINES);
    expect(await detected('q3.json', '')).toEqual(unread('JSON'));
  });
});

describe('then the name and the first line decide', () => {
  const lines = '{"id":1,"name":"Ada"}\n{"id":2,"name":"Ben"}\n';

  test('.jsonl and .ndjson are JSON Lines, whatever the first line holds', async () => {
    expect(await detected('events.jsonl', lines)).toEqual(LINES);
    expect(await detected('events.NDJSON', 'a,b\n')).toEqual(LINES);
    expect(await detected('events.jsonl.gz', lines)).toEqual(LINES);
  });

  test('a .csv or .tsv whose first line is a JSON object stays delimited', async () => {
    expect(await detected('events.csv', lines)).toEqual(DELIMITED);
    expect(await detected('events.tsv', lines)).toEqual(DELIMITED);
  });

  test('a name with no layout extension is JSON Lines on an object first line', async () => {
    for (const name of ['events', 'events.txt', 'events.gz', 'events.log'])
      expect(await detected(name, lines), name).toEqual(LINES);
    // Past a byte order mark and blank lines.
    expect(await detected('events', `\uFEFF\n \t\r\n${lines}`)).toEqual(LINES);
    // One object with no newline after it, the whole file.
    expect(await detected('events', '{"id":1}')).toEqual(LINES);
  });

  test('any other first line leaves a layout-less name delimited', async () => {
    const cases = [
      // A headerless column of numbers is a complete JSON value each line.
      '1\n2\n3\n',
      '[1,2]\n[3,4]\n',
      '"a"\n"b"\n',
      // A document over several lines, and two objects on one.
      '{\n  "id": 1\n}\n',
      '{"id":1}{"id":2}\n',
      'date,units\n2026-07-01,1204\n',
    ];
    for (const text of cases)
      expect(await detected('events', text), text).toEqual(DELIMITED);
  });

  test('a first line the head cuts off is no complete object', async () => {
    const long = `{"note":"${'x'.repeat(HEAD_BYTES)}"}\n`;
    expect(await detected('events', long)).toEqual(DELIMITED);
    expect(await detected('events.json', long)).toEqual(unread('JSON'));
  });

  test('a .json is JSON Lines on an object first line, and JSON otherwise', async () => {
    expect(await detected('events.json', lines)).toEqual(LINES);
    for (const text of ['[]', '[{"id":1}]', '{\n"id":1\n}', '{"a":1} {"b":2}'])
      expect(await detected('events.json', text), text).toEqual(unread('JSON'));
  });
});

describe('what a file is detected as names the kind of rows it holds', () => {
  test('read or not yet, and none behind a compression or for a JSON document', async () => {
    const kinds: ReadonlyArray<readonly [string, ReadKind | undefined]> = [
      ['sales-q3.csv', 'delimited'],
      ['events.jsonl', 'jsonl'],
      ['par1.bin', 'parquet'],
      ['sales-q3.csv.gz', undefined],
    ];
    for (const [name, kind] of kinds) {
      const bytes = new Uint8Array(readFileSync(testdata + name));
      expect(kindOf(await detected(name, bytes)), name).toBe(kind);
    }
    expect(kindOf(await detected('data.json', '[]'))).toBeUndefined();
    // As detect says them once this build reads them.
    expect(kindOf({ t: 'records', layout: 'lines' })).toBe('jsonl');
    expect(kindOf({ t: 'parquet' })).toBe('parquet');
  });
});

describe('delimited text stays delimited text', () => {
  const fixtures = readdirSync(testdata).filter((name) =>
    /\.(csv|tsv)$/.test(name),
  );

  test('every CSV and TSV fixture, under its name and under none', async () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const name of fixtures) {
      const bytes = new Uint8Array(readFileSync(testdata + name));
      expect(await detected(name, bytes), name).toEqual(DELIMITED);
      expect(await detected(name.replace(/\..*$/, ''), bytes), name).toEqual(
        DELIMITED,
      );
    }
  });

  /** How many random heads are checked, and the most bytes each holds. */
  const SEEDS = 1000;
  const MAX_BYTES = 64;
  const BYTE_VALUES = 256;

  test('a random head is delimited text', async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = random(seed);
      const bytes = Uint8Array.from(
        { length: Math.floor(rand() * MAX_BYTES) },
        () => Math.floor(rand() * BYTE_VALUES),
      );
      for (const name of ['r.csv', 'r.tsv', 'r'])
        expect(await detected(name, bytes), `seed ${seed}, ${name}`).toEqual(
          DELIMITED,
        );
    }
  });
});
