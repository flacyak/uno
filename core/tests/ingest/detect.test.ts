/**
 * @fileoverview A file's stored bytes say whether it is Parquet before any
 * text is sniffed.
 */

import { describe, expect, test } from 'vite-plus/test';

import { PARQUET_MAGIC_BYTES, detect } from '@ingest/detect';
import type { Detected, StoredHead } from '@ingest/detect';
import type { Unread } from '@said';

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

describe('the bytes decide first', () => {
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
    const csv = stored('date,units\n2026-07-01,1204\n');
    await detect('q3.csv', csv.head);
    expect(csv.tails).toEqual([]);
  });

  test('an empty head and a one-byte head are text', async () => {
    for (const bytes of [
      new Uint8Array(),
      Uint8Array.of(0x1f),
      Uint8Array.of(0x50),
    ]) {
      const file = stored(bytes);
      expect(await detect('q3.csv', file.head)).toEqual(DELIMITED);
      expect(file.tails).toEqual([]);
    }
  });
});
