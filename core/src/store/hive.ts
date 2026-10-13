/**
 * @fileoverview Hive partition folders: a path under a dataset's root read as
 * the key=value pairs its folders name.
 *
 * Spark, Hive, DuckDB and Polars write a dataset as folders such as
 * year=2024/month=9, escaping what a path cannot hold as %XX.
 */

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

/** pairOf splits a key=value folder in two, as written. */
function pairOf(folder: string): { key: string; value: string } | undefined {
  const [key, value, ...more] = folder.split('=');
  if (value === undefined || more.length > 0 || key === '') return undefined;
  return { key, value };
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
