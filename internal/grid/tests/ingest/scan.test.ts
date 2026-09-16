import { describe, expect, test } from "vite-plus/test";

import { readAll } from "../../src/ingest/csv.ts";
import { RecordScanner, bomLength } from "../../src/ingest/scan.ts";

const encoder = new TextEncoder();
const whole = new TextDecoder("utf-8");
const piece = new TextDecoder("utf-8", { ignoreBOM: true });

/** Where the scanner says records begin, fed `chunk` bytes at a time. */
function starts(bytes: Uint8Array, comma: string, chunk: number): number[] {
  const out: number[] = [];
  const s = new RecordScanner(comma, (offset) => out.push(offset));
  const bom = bomLength(bytes);
  for (let at = bom; at < bytes.length; at += chunk) {
    s.push(bytes.subarray(at, Math.min(at + chunk, bytes.length)), at);
  }
  return out;
}

/**
 * The file read the way the engine reads it: split at every `every`th record
 * start, each run decoded and parsed on its own, and the rows put back together.
 */
function piecewise(bytes: Uint8Array, comma: string, begins: number[], every: number): string[][] {
  const cuts = [0];
  for (let i = every; i < begins.length; i += every) cuts.push(begins[i]!);
  cuts.push(bytes.length);

  const rows: string[][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const decoder = i === 0 ? whole : piece;
    rows.push(...readAll(decoder.decode(bytes.subarray(cuts[i], cuts[i + 1])), comma));
  }
  return rows;
}

/** mulberry32, so a failure names a seed that reproduces it. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every byte the scanner acts on, plus the characters that would break a scanner
// that decoded: a multi-byte letter, and a U+FEFF in the middle of a file.
const ALPHABET = ["a", "b", ",", ";", '"', '"', "\n", "\n", "\r", "\r\n", " ", "é", "日", "\uFEFF"];

/** How often a random file opens with a byte order mark, and how long it runs. */
const BOM_CHANCE = 0.1;
const MAX_CHARS = 40;

/** How many random files the scanner is checked against. */
const SEEDS = 4000;

function csvish(rand: () => number): string {
  let s = rand() < BOM_CHANCE ? "\uFEFF" : "";
  const n = Math.floor(rand() * MAX_CHARS);
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

describe("the scanner agrees with readAll", () => {
  test("on random input, in any chunk size, split at any record", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = random(seed);
      const text = csvish(rand);
      const comma = rand() < 0.5 ? "," : ";";
      const bytes = encoder.encode(text);
      const want = readAll(whole.decode(bytes), comma);

      for (const chunk of [1, 2, 7, 64]) {
        const begins = starts(bytes, comma, chunk);
        expect(begins.length, `seed ${seed}, chunk ${chunk}: ${JSON.stringify(text)}`).toBe(
          want.length,
        );
        for (const every of [1, 2, 3]) {
          expect(
            piecewise(bytes, comma, begins, every),
            `seed ${seed}, chunk ${chunk}, every ${every}: ${JSON.stringify(text)}`,
          ).toEqual(want);
        }
      }
    }
  });

  const cases: Array<[string, string, number[]]> = [
    ["one record per line", "a,b\n1,2\n", [0, 4]],
    ["blank lines are not records", "a\n\n\r\nb\n", [0, 5]],
    ["a quoted newline stays inside its record", 'a\n"x\ny",1\nz\n', [0, 2, 10]],
    ["a doubled quote does not close the field", 'a\n"x"",\ny"\nz', [0, 2, 11]],
    ["a bare quote in an unquoted field is data", 'a\nx",\n"b"\n', [0, 2, 6]],
    ["a lone CR at the end of the file is not a record", "a\n\r", [0]],
    ["a CR that is not a line ending begins a record", "a\n\rb\n", [0, 2]],
    ["the byte order mark is not part of the first record", '\uFEFF"a,b"\nc\n', [3, 9]],
  ];

  for (const [name, text, want] of cases) {
    test(name, () => {
      const bytes = encoder.encode(text);
      expect(starts(bytes, ",", bytes.length)).toEqual(want);
      // A boundary between any two bytes changes nothing.
      expect(starts(bytes, ",", 1)).toEqual(want);
    });
  }
});

test("the scanner refuses a separator it cannot scan for", () => {
  for (const comma of ['"', "\n", "é", ",,"]) {
    expect(() => new RecordScanner(comma, () => {})).toThrow("cannot separate fields");
  }
});
