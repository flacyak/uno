/**
 * @fileoverview The names of the files uno reads: how a name splits into its
 * stem, its extension and its compression.
 *
 * A name says what a file claims to be, and its bytes decide.
 */

import type { Compression } from '@said';

/**
 * StoredCompression is a compression a file's name can claim. Those beyond
 * Compression are named so they can be refused by name.
 */
export type StoredCompression = Compression | 'bzip2' | 'xz' | 'lz4' | 'snappy';

/** The compression each extension claims, the extension lower-cased with its dot. */
const COMPRESSED: ReadonlyMap<string, StoredCompression> = new Map([
  ['.gz', 'gzip'],
  ['.zst', 'zstd'],
  ['.bz2', 'bzip2'],
  ['.xz', 'xz'],
  ['.lz4', 'lz4'],
  ['.snappy', 'snappy'],
  ['.sz', 'snappy'],
]);

/** NameParts is a file's name split into what it is called and what it claims to hold. */
export interface NameParts {
  /**
   * The file's name without its folders and its data and compression
   * extensions, as written: 'q3' for s3://acme/2025/q3.tsv.gz.
   */
  readonly stem: string;
  /**
   * The data extension, lower-cased with its dot: '.tsv' for q3.tsv.gz,
   * '.parquet' for p.snappy.parquet, '' for none.
   */
  readonly extension: string;
  /**
   * What follows the stem, as written, so the stem and it are the file's
   * name: '.TSV.gz' for Q3.TSV.gz, '.parquet' for p.snappy.parquet, '' for
   * none.
   */
  readonly suffix: string;
  /** The compression the name claims. The bytes decide; this names the inner file. */
  readonly compression?: StoredCompression;
}

/**
 * nameParts splits a file's name, or a path to it, into its stem, what
 * follows it, its data extension and the compression its last extension
 * claims. Only the last extension can be a compression, so p.snappy.parquet
 * is plain Parquet. A path that ends in a separator names its folder.
 */
export function nameParts(name: string): NameParts {
  const file = lastPart(name);
  const [rest, last] = split(file);
  const compression = COMPRESSED.get(last);
  if (compression === undefined) {
    return { stem: rest, extension: last, suffix: file.slice(rest.length) };
  }
  const [stem, extension] = split(rest);
  return { stem, extension, suffix: file.slice(stem.length), compression };
}

/**
 * lastPart returns what follows a path's last separator, '/' or '\\', once
 * any trailing separators are dropped.
 */
function lastPart(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed.slice(
    Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1,
  );
}

/**
 * split cuts a file's name at its last dot into what comes before and the
 * extension, lower-cased. A leading dot starts a hidden file's name, which
 * then has no extension.
 */
function split(file: string): [string, string] {
  const dot = file.lastIndexOf('.');
  return dot > 0
    ? [file.slice(0, dot), file.slice(dot).toLowerCase()]
    : [file, ''];
}
