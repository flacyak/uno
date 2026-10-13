/**
 * @fileoverview Hive partition folders: a path under a dataset's root read as
 * the key=value pairs its folders name.
 *
 * Spark, Hive, DuckDB and Polars write a dataset as folders such as
 * year=2024/month=9, escaping what a path cannot hold as %XX.
 */

import { compareStrings } from '@go';

/** The value Hive writes for a null partition, which reads as empty. */
export const HIVE_NULL = '__HIVE_DEFAULT_PARTITION__';

/** Partition is the keys a path's folders name, in path order, and their values. */
export interface Partition {
  readonly keys: readonly string[];
  readonly values: readonly string[];
}

/** Runs of %XX escapes, each of which decodes as UTF-8 bytes. */
const ESCAPES = /(?:%[0-9A-Fa-f]{2})+/g;

/** The characters one escape takes: '%' and two hex digits. */
const ESCAPE_CHARS = 3;

/** The most bytes UTF-8 spends on one code point. */
const UTF8_MAX_BYTES = 4;

/** A value of digits alone, which orders as the whole number it writes. */
const WHOLE = /^[0-9]+$/;

/** The zeros a whole number is written with before its first other digit. */
const LEADING_ZEROS = /^0+/;

/**
 * partitionOf reads the key=value folders of a path under a dataset's root.
 * The file's own name is not read.
 *
 * A folder with no '=', more than one, or nothing before it names no key.
 * Escapes decode as UTF-8 and a malformed one stays as written, as does '+'.
 * HIVE_NULL reads as an empty value.
 */
export function partitionOf(relative: string): Partition {
  const keys: string[] = [];
  const values: string[] = [];
  for (const folder of relative.split('/').slice(0, -1)) {
    const pair = pairOf(folder);
    if (pair === undefined) continue;
    const value = unescaped(pair.value);
    keys.push(unescaped(pair.key));
    values.push(value === HIVE_NULL ? '' : value);
  }
  return { keys, values };
}

/**
 * byPartPath orders paths under a dataset's root one folder at a time. A name
 * orders first by the text before its first '=', so the values of one key
 * stay together. Among them a whole number comes first, then any other value,
 * then a name that is no key=value pair. Two whole numbers order as numbers,
 * so month=9 comes before month=10, and the rest by code point.
 */
export function byPartPath(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = byName(left[i], right[i]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

/** pairOf splits a key=value folder in two, as written. */
function pairOf(folder: string): { key: string; value: string } | undefined {
  const [key, value, ...more] = folder.split('=');
  if (value === undefined || more.length > 0 || key === '') return undefined;
  return { key, value };
}

/**
 * The kinds of name that share the text before their first '=', in the order
 * they come: a pair whose value is a whole number, any other pair, and a name
 * that is no pair.
 */
const KINDS = ['whole', 'pair', 'none'] as const;

/** Ranked is what a name at one depth of a path orders by. */
interface Ranked {
  /** The text before the first '=', or the whole name when it has none. */
  readonly key: string;
  /** The text after the first '='. */
  readonly value: string;
  readonly kind: (typeof KINDS)[number];
}

/** rankOf splits a name at its first '=' and says what kind of name it is. */
function rankOf(name: string): Ranked {
  const at = name.indexOf('=');
  const pair = pairOf(name);
  return {
    key: at < 0 ? name : name.slice(0, at),
    value: at < 0 ? '' : name.slice(at + 1),
    kind:
      pair === undefined ? 'none' : WHOLE.test(pair.value) ? 'whole' : 'pair',
  };
}

/**
 * byName orders two names at one depth of a path, a step at a time: by the
 * text before the first '=', by kind, two whole numbers as numbers, and then
 * by code point. Each step orders any two names, so a name that is no pair
 * cannot fall between two values of one key and the order stays total.
 */
function byName(a: string, b: string): number {
  const x = rankOf(a);
  const y = rankOf(b);
  if (x.key !== y.key) return compareStrings(x.key, y.key);
  if (x.kind !== y.kind) return KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind);
  if (x.kind === 'whole' && y.kind === 'whole') {
    const order = byNumber(x.value, y.value);
    if (order !== 0) return order;
  }
  return compareStrings(a, b);
}

/** byNumber orders two runs of digits by the whole numbers they write. */
function byNumber(a: string, b: string): number {
  const x = a.replace(LEADING_ZEROS, '');
  const y = b.replace(LEADING_ZEROS, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return compareStrings(x, y);
}

/** unescaped decodes every run of escapes in text. */
function unescaped(text: string): string {
  return text.replace(ESCAPES, (run) => {
    let decoded = '';
    for (let at = 0; at < run.length;) {
      const point = codePointAt(run, at);
      decoded += point.text;
      at = point.end;
    }
    return decoded;
  });
}

/**
 * codePointAt decodes the escapes at `at` that spell one code point, and says
 * where they end. An escape that starts no code point is kept as written.
 */
function codePointAt(run: string, at: number): { text: string; end: number } {
  for (let bytes = 1; bytes <= UTF8_MAX_BYTES; bytes++) {
    const end = at + bytes * ESCAPE_CHARS;
    if (end > run.length) break;
    try {
      return { text: decodeURIComponent(run.slice(at, end)), end };
    } catch {
      // Too few bytes for this code point, or bytes that start none.
    }
  }
  const end = at + ESCAPE_CHARS;
  return { text: run.slice(at, end), end };
}
