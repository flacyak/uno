/**
 * @fileoverview The speculative chunk scan, stitched from the true start
 * state, reports exactly the begins RecordScanner reports, wherever the file
 * is cut into chunks. Also checks what the merge facts the lab reports rest
 * on: where paths merge for each data shape, and which never do.
 */

import { describe, expect, test } from 'vite-plus/test';

import { RecordScanner, bomLength } from '@ingest/scan';
import {
  BARE,
  FIELD,
  LINE,
  LINE_CR,
  NONE,
  QUOTED,
  QUOTE_CR,
  QUOTE_SEEN,
  STATES,
  scanChunk,
  separatorOf,
  trace,
} from './speculate.ts';
import type { ChunkScan, State } from './speculate.ts';
import {
  ALTERNATING,
  BARE_QUOTES,
  EMPTY_QUOTES,
  PLAIN,
  QUOTE_RUN,
  SALES,
  SHAPES,
  SYNTHETIC,
} from './shapes.ts';

const encoder = new TextEncoder();

const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;
/** The UTF-8 byte order mark. */
const BOM = [0xef, 0xbb, 0xbf];

/** Record starts RecordScanner reports from `start`, fed in one piece. */
function sequential(bytes: Uint8Array, comma: string, start: number): number[] {
  const out: number[] = [];
  new RecordScanner(comma, (offset) => out.push(offset)).push(
    bytes.subarray(start),
    start,
  );
  return out;
}

/** The begins a stitched speculative scan reports, with the chunk states. */
interface Stitched {
  begins: number[];
  /** The true state at the start of each chunk. */
  states: State[];
  scans: ChunkScan[];
}

/**
 * speculative cuts bytes [start, end) at `cuts`, scans each chunk on its
 * own and stitches them from LINE at `start`.
 */
function speculative(
  bytes: Uint8Array,
  comma: string,
  start: number,
  cuts: readonly number[],
): Stitched {
  const sep = separatorOf(comma);
  const edges = [start, ...cuts.filter((c) => c > start && c < bytes.length)];
  edges.push(bytes.length);
  const out: Stitched = { begins: [], states: [], scans: [] };
  let state: State = LINE;
  for (let k = 0; k + 1 < edges.length; k++) {
    const scan = scanChunk(
      bytes.subarray(edges[k], edges[k + 1]),
      edges[k]!,
      sep,
    );
    out.states.push(state);
    out.scans.push(scan);
    const { ranges, end } = trace(scan, state);
    for (const [from, to] of ranges) {
      for (let i = from; i < to; i++) out.begins.push(scan.begins[i]!);
    }
    state = end;
  }
  return out;
}

/** mulberry32 random number generator. A failure reports its seed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The alphabet of tests/ingest/scan.test.ts: every byte the scanner acts on,
// plus multi-byte letters and a U+FEFF that can land anywhere in the file.
const ALPHABET = [
  'a',
  'b',
  ',',
  ';',
  '"',
  '"',
  '\n',
  '\n',
  '\r',
  '\r\n',
  ' ',
  'é',
  '日',
  '﻿',
];

/** Chance a random file starts with a byte order mark, and its maximum length. */
const BOM_CHANCE = 0.1;
const MAX_CHARS = 40;
/** Number of random files to check. */
const SEEDS = 3000;
/** Random sets of cuts tried per file, and the most cuts in one. */
const RANDOM_CUT_SETS = 4;
const MAX_RANDOM_CUTS = 6;
/**
 * The random cuts take about five seconds alone, the default timeout, so
 * beside the rest of the suite they went over it.
 */
const RANDOM_TIMEOUT_MS = 120_000;

function csvish(rand: () => number): string {
  let s = rand() < BOM_CHANCE ? '﻿' : '';
  const n = Math.floor(rand() * MAX_CHARS);
  for (let i = 0; i < n; i++)
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

/** The awkward places a cut can land, counted over the property test. */
type Place =
  | 'inside quotes'
  | 'between CR and LF'
  | 'between two quotes'
  | 'right after a BOM'
  | 'at a separator'
  | 'after a CR that starts a record';

/** places names the awkward places a single cut at `cut` lands on. */
function placesOf(
  bytes: Uint8Array,
  sep: number,
  cut: number,
  state: State,
  begins: readonly number[],
): Place[] {
  const before = bytes[cut - 1];
  const after = bytes[cut];
  const places: Place[] = [];
  if (state === QUOTED || state === QUOTE_SEEN || state === QUOTE_CR) {
    places.push('inside quotes');
  }
  if (before === CR && after === LF) places.push('between CR and LF');
  if (before === QUOTE && after === QUOTE) places.push('between two quotes');
  if (BOM.every((b, k) => bytes[cut - BOM.length + k] === b)) {
    places.push('right after a BOM');
  }
  if (before === sep || after === sep) places.push('at a separator');
  if (state === LINE_CR && begins.includes(cut - 1)) {
    places.push('after a CR that starts a record');
  }
  return places;
}

describe('stitched speculative scans agree with RecordScanner', () => {
  test('on random input, cut anywhere', { timeout: RANDOM_TIMEOUT_MS }, () => {
    const places = new Map<Place, number>();
    const states = new Map<State, number>();

    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = random(seed);
      const text = csvish(rand);
      const comma = rand() < 0.5 ? ',' : ';';
      const sep = separatorOf(comma);
      const bytes = encoder.encode(text);
      const start = bomLength(bytes);
      const want = sequential(bytes, comma, start);
      const at = `seed ${seed}: ${JSON.stringify(text)}`;

      // One cut, at every byte.
      for (let cut = start + 1; cut < bytes.length; cut++) {
        const got = speculative(bytes, comma, start, [cut]);
        expect(got.begins, `${at}, cut at ${cut}`).toEqual(want);
        const state = got.states[1]!;
        states.set(state, (states.get(state) ?? 0) + 1);
        for (const place of placesOf(bytes, sep, cut, state, want)) {
          places.set(place, (places.get(place) ?? 0) + 1);
        }
      }

      // Every byte a chunk of its own.
      const every = Array.from({ length: bytes.length }, (_, i) => i);
      expect(speculative(bytes, comma, start, every).begins, at).toEqual(want);

      // A few cuts at random.
      for (let set = 0; set < RANDOM_CUT_SETS; set++) {
        const cuts = Array.from(
          { length: 1 + Math.floor(rand() * MAX_RANDOM_CUTS) },
          () => Math.floor(rand() * bytes.length),
        ).sort((x, y) => x - y);
        const unique = [...new Set(cuts)];
        expect(
          speculative(bytes, comma, start, unique).begins,
          `${at}, cuts ${unique.join(' ')}`,
        ).toEqual(want);
      }
    }

    // Every awkward place, and every true state, came up.
    const allPlaces: Place[] = [
      'inside quotes',
      'between CR and LF',
      'between two quotes',
      'right after a BOM',
      'at a separator',
      'after a CR that starts a record',
    ];
    for (const place of allPlaces) {
      expect(places.get(place) ?? 0, place).toBeGreaterThan(0);
    }
    for (const state of STATES) {
      expect(states.get(state) ?? 0, `state ${state}`).toBeGreaterThan(0);
    }
  });

  // Each with the cuts that put a chunk edge on the awkward place.
  const cases: Array<[string, string, number, number[], number[]]> = [
    [
      'a CR that starts a record ends the first chunk',
      'a\n\rb\n',
      0,
      [3],
      [0, 2],
    ],
    ['a cut between CR and LF', 'a\r\nb\r\n', 0, [2], [0, 3]],
    [
      'a cut between the quotes of an escaped quote',
      'a\n"x""y"\nb',
      0,
      [5],
      [0, 2, 9],
    ],
    [
      'cuts on both sides of a quoted newline',
      'a\n"x\ny",1\nz\n',
      0,
      [4, 5],
      [0, 2, 10],
    ],
    ['a cut right after the byte order mark', '﻿"a,b"\nc\n', 3, [3, 4], [3, 9]],
    ['a cut right after a U+FEFF inside a field', 'a\n﻿"b\n', 0, [5], [0, 2]],
    ['cuts on both sides of a separator', 'a,"b",c\nd', 0, [1, 2], [0, 8]],
    ['a quote, then a CR, then a cut', 'a\n"x"\r\ny\n', 0, [6], [0, 2, 7]],
    [
      'a CR inside quotes after a bare quote',
      'a\n"x"\rb"\nc',
      0,
      [5, 6],
      [0, 2, 9],
    ],
  ];
  for (const [name, text, start, cuts, want] of cases) {
    test(name, () => {
      const bytes = encoder.encode(text);
      expect(sequential(bytes, ',', start)).toEqual(want);
      expect(speculative(bytes, ',', start, cuts).begins).toEqual(want);
    });
  }

  test('every chunk scan follows the true state the stitcher hands it', () => {
    const bytes = SYNTHETIC.make(1 << 16);
    const cuts = Array.from({ length: 200 }, (_, k) => 300 * (k + 1) + (k % 7));
    const got = speculative(bytes, ',', 0, cuts);
    expect(got.begins).toEqual(sequential(bytes, ',', 0));
    // Chunks start inside quotes and outside them.
    expect(got.states).toContain(QUOTED);
    expect(got.states).toContain(BARE);
    expect(got.states).toContain(FIELD);
  });
});

/** Chunk starts tried per shape, the chunk length, and the shape's size. */
const PROBES = 400;
const PROBE_BYTES = 4096;
const SHAPE_BYTES = 1 << 20;
/** Probe starts are moved by up to this many bytes, a prime, so they land all over the rows. */
const PROBE_JITTER = 13;

/** probe scans PROBES chunks of a shape, each starting at a different offset. */
function probe(bytes: Uint8Array): ChunkScan[] {
  const sep = separatorOf(',');
  const stride = Math.floor((bytes.length - PROBE_BYTES) / PROBES);
  return Array.from({ length: PROBES }, (_, k) => {
    const at = k * stride + (k % PROBE_JITTER);
    return scanChunk(bytes.subarray(at, at + PROBE_BYTES), at, sep);
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('where paths merge', () => {
  test('on rows with quoted fields, within a row or two of the chunk start', () => {
    for (const shape of [SALES, SYNTHETIC]) {
      const scans = probe(shape.make(SHAPE_BYTES));
      const merged = scans.map((s) => s.stats.merged);
      expect(
        merged.every((m) => m !== NONE),
        shape.name,
      ).toBe(true);
      // A sales row is under 60 bytes and about half hold a quote.
      expect(Math.max(...merged), shape.name).toBeLessThan(1024);
      expect(median(merged), shape.name).toBeLessThan(256);
      // Only the bytes around the first quote are stepped one at a time.
      expect(Math.max(...scans.map((s) => s.stats.stepped))).toBeLessThan(16);
    }
  });

  test('never, with no quote at all: the inside-quotes path stays inside', () => {
    const scans = probe(PLAIN.make(SHAPE_BYTES));
    for (const scan of scans) {
      expect(scan.stats.merged).toBe(NONE);
      expect(scan.stats.survivors).toBe(2);
      // It reports nothing, so the output is no larger than one reading.
      const inside = trace(scan, QUOTED);
      expect(inside.ranges).toEqual([]);
      expect(inside.end).toBe(QUOTED);
      expect(scan.stats.stepped).toBeLessThan(4);
    }
  });

  test('never, when the quotes read the same from inside and outside', () => {
    for (const shape of [EMPTY_QUOTES, BARE_QUOTES, ALTERNATING]) {
      const bytes = shape.make(SHAPE_BYTES);
      for (const scan of probe(bytes)) {
        expect(scan.stats.merged, shape.name).toBe(NONE);
        expect(scan.stats.survivors, shape.name).toBe(2);
        // Only one reading is outside quotes at a time, so all paths
        // together report at most one record per line, plus the few at the
        // start where every path steps.
        const chunk = bytes.subarray(scan.base, scan.base + scan.length);
        const lines = chunk.filter((b) => b === LF).length;
        expect(scan.begins.length, shape.name).toBeLessThanOrEqual(
          lines + STATES.length,
        );
      }
    }
  });

  test('never, in a run of quotes, where three paths step every byte', () => {
    const bytes = QUOTE_RUN.make(PROBE_BYTES * 2);
    const chunk = bytes.subarray(PROBE_BYTES);
    const scan = scanChunk(chunk, PROBE_BYTES, separatorOf(','));
    expect(scan.stats.survivors).toBe(3);
    expect(scan.stats.stepped).toBe(chunk.length);
  });

  test('the shapes are what they say', () => {
    for (const shape of SHAPES) {
      const bytes = shape.make(PROBE_BYTES);
      expect(bytes.length, shape.name).toBeGreaterThanOrEqual(PROBE_BYTES);
      const quotes = bytes.filter((b) => b === QUOTE).length;
      if (shape === PLAIN) expect(quotes).toBe(0);
      else expect(quotes, shape.name).toBeGreaterThan(0);
    }
  });
});
