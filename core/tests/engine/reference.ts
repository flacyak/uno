/**
 * @fileoverview A random JSON Lines file and a reference parse of it. The
 * file holds a byte order mark, CRLF, blank lines, broken and non-object
 * lines, and a key first seen halfway down. The parse reads each line with
 * JSON.parse and lays it out by key as walkLine names its cells.
 */

import { pointerTo } from '@ingest';
import { pick, random } from '@core-tests/random';
import type { Random } from '@core-tests/random';

/** How many lines the file holds, enough for hundreds of TINY blocks. */
export const LINES = 600;
/** The seed the file is drawn from. */
const SEED = 30;
/** Where in the file a key is first seen. */
export const LATE = LINES / 2;
/** What ends a line: an LF or a CRLF, alone or after a blank line. */
const ENDINGS = ['\n', '\r\n', '\n \t\n', '\r\n\r\n'];
/** Lines that are JSON, but not one object. */
const NOT_OBJECTS = ['[1,2]', '"text"', '42', 'null'];
/** Chance a line is cut short, and that it is not one object. */
const BROKEN_CHANCE = 0.05;
/** Text a string holds: plain, accented, quoted, escaped and pointer-like. */
const TEXTS = ['ada', 'Zoë', '日本', 'say "hi"', 'a\\b', 'tab\there', 'a/b~c'];
/** Each country a user is from. */
const COUNTRIES = ['PT', 'BR', 'GB'];
/** The share of lines with each optional field. */
const SOME = 0.3;
/** What a late 'user.name' steps by, so that most of its numbers have a fraction. */
const LATE_STEP = 0.25;
/** The byte order mark the file starts with. */
const BOM = '\uFEFF';

/**
 * record returns line `i` as an object: nested fields, an array, an empty
 * object, true, false and null, and past LATE a literal 'user.name' beside
 * the nested one.
 */
function record(rand: Random, i: number): Record<string, unknown> {
  const out: Record<string, unknown> = { id: i };
  if (rand() > SOME) {
    out['user'] = { name: pick(rand, TEXTS), country: pick(rand, COUNTRIES) };
  }
  if (rand() < SOME) out['tags'] = [pick(rand, TEXTS), i];
  if (rand() < SOME) out['paid'] = rand() < SOME ? null : i % 2 === 0;
  if (rand() < SOME) out['meta'] = {};
  if (i > LATE && rand() < SOME) out['user.name'] = i * LATE_STEP;
  return out;
}

/** jsonLines returns the file's text: a byte order mark, then every line. */
export function jsonLines(): string {
  const rand = random(SEED);
  let text = BOM;
  for (let i = 0; i < LINES; i++) {
    const line = JSON.stringify(record(rand, i));
    const odd = rand();
    if (odd < BROKEN_CHANCE) text += line.slice(0, line.length / 2);
    else if (odd < 2 * BROKEN_CHANCE) text += pick(rand, NOT_OBJECTS);
    else text += line;
    // The last line ends with no LF.
    if (i + 1 < LINES) text += pick(rand, ENDINGS);
  }
  return text;
}

/** cellsOf returns a parsed object's cells by key, as walkLine writes them. */
function cellsOf(parent: string, object: object, out: Map<string, string>) {
  for (const [name, value] of Object.entries(object)) {
    const key = pointerTo(parent, name);
    if (value === null) out.set(key, '');
    else if (Array.isArray(value)) out.set(key, JSON.stringify(value));
    else if (typeof value !== 'object') out.set(key, String(value));
    else if (Object.keys(value).length === 0) out.set(key, '{}');
    else cellsOf(key, value, out);
  }
  return out;
}

/** What the reference parse makes of the file. */
export interface Parsed {
  /** Every key in the order it is first seen, '' for a line kept whole. */
  readonly keys: readonly string[];
  /** Each line's cells by key. */
  readonly lines: ReadonlyArray<ReadonlyMap<string, string>>;
}

/** parse returns what JSON.parse makes of `line`, or undefined if it throws. */
function parse(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** isObject says whether a parsed value is an object, not an array or null. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * parsed reads the file past its byte order mark with JSON.parse: each line
 * that holds more than spaces, tabs and CRs, without its CR, laid out by key
 * or kept whole.
 */
export function parsed(text: string): Parsed {
  const keys = new Set<string>();
  const lines = text
    .slice(BOM.length)
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => /[^ \t\r]/.test(line))
    .map((line) => {
      const value = parse(line);
      const cells = isObject(value)
        ? cellsOf('', value, new Map())
        : new Map([['', line]]);
      for (const key of cells.keys()) keys.add(key);
      return cells;
    });
  return { keys: [...keys], lines };
}

/** rowsOf lays out each parsed line over `keys`, with '' where it has none. */
export function rowsOf(file: Parsed, keys: readonly string[]): string[][] {
  return file.lines.map((cells) => keys.map((key) => cells.get(key) ?? ''));
}
