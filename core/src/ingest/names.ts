/**
 * @fileoverview The names of the files uno reads: the extensions it reads,
 * the compressions it reads them through, and how a name splits into its
 * stem, its extension and its compression.
 *
 * This is the one list the desktop's dialogs, drop and panel take what they
 * open from. A name says what a file claims to be, and its bytes decide.
 */

import type { Compression } from '@said';

/**
 * StoredCompression is a compression a file's name can claim. Those beyond
 * Compression are named so they can be refused by name.
 */
export type StoredCompression = Compression | 'bzip2' | 'xz' | 'lz4' | 'snappy';

/** The extensions that name JSON Lines, lower-cased with their dot. */
export const LINES_EXTENSIONS: readonly string[] = ['.jsonl', '.ndjson'];

/**
 * A JSON document's extension, which Spark and BigQuery give JSON Lines too.
 * One is read when its first line is one object, and refused otherwise.
 */
const JSON_EXTENSION = '.json';

/**
 * The extensions of the files uno reads, lower-cased with their dot. It grows
 * as ingest learns formats.
 */
export const READ_EXTENSIONS: readonly string[] = [
  '.csv',
  '.tsv',
  ...LINES_EXTENSIONS,
  JSON_EXTENSION,
];

/** The compressions uno reads a file through. It grows as ingest learns them. */
export const READ_COMPRESSIONS: readonly Compression[] = [];

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

/** isRead says whether uno reads a file through a compression. */
function isRead(compression: StoredCompression): boolean {
  return READ_COMPRESSIONS.some((c) => c === compression);
}

/** withoutDot returns an extension as a dialog filter names it: csv for .csv. */
function withoutDot(extension: string): string {
  return extension.replace(/^\./, '');
}

/**
 * The last extensions of the names uno reads, for native dialog filters,
 * which match only the final one: csv, tsv, and each read compression's.
 */
export const DIALOG_EXTENSIONS: readonly string[] = [
  ...READ_EXTENSIONS,
  ...[...COMPRESSED]
    .filter(([, c]) => isRead(c))
    .map(([extension]) => extension),
].map(withoutDot);

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
 * linesByName says whether a name claims JSON Lines: .jsonl or .ndjson, alone
 * or under a compression. The bytes decide what a name claims nothing about.
 */
export function linesByName(name: string): boolean {
  return LINES_EXTENSIONS.includes(nameParts(name).extension);
}

/** readable says whether a name is a read extension, alone or under a read compression. */
export function readable(name: string): boolean {
  const { extension, compression } = nameParts(name);
  return (
    READ_EXTENSIONS.includes(extension) &&
    (compression === undefined || isRead(compression))
  );
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
