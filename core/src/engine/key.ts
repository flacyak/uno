/**
 * @fileoverview The key a saved row index holds for: which bytes it is of
 * and how they were read, so a reopen takes the index only over the same
 * bytes read the same way, by a build that finds the same blocks in them.
 */

import type { Format } from '@ingest';
import type { ByteSource } from '@store';
import type { Tuning } from './rows.ts';
import { INDEX_VERSION } from './saved.ts';

/**
 * SourceKey is what the open of a source measured. Its bytes: their size,
 * their version where the place gives one (an S3 VersionId where the bucket
 * keeps versions, its ETag in quotes otherwise), and on disk the modified
 * and change times. How they were read: the format the sniff found, the
 * block rule, and the scanner's version. A decimal mark moves no record, so
 * it is in a chart's fold and not here.
 */
export type SourceKey = {
  bytes: number;
  version?: string;
  modified?: number;
  statusChanged?: number;
  delimiter: string;
  encoding: string;
  header: string;
  dataStart: number;
  blockRows: number;
  blockBytes: number;
  index: number;
};

/** keyOf is the key of `source`, read as `format` under `tuning`. */
export function keyOf(
  source: ByteSource,
  format: Format,
  tuning: Tuning,
): SourceKey {
  const { size: bytes, version, modified, statusChanged } = source;
  const { delimiter, encoding, header, dataStart } = format;
  const { blockRows, blockBytes } = tuning;
  const read = {
    delimiter,
    encoding,
    header,
    dataStart,
    blockRows,
    blockBytes,
  };
  // A measure the place does not give is left undefined, and a save leaves
  // it out.
  const measured = { bytes, version, modified, statusChanged };
  return { ...measured, ...read, index: INDEX_VERSION };
}

/**
 * differs names the first field `saved` and `now` hold apart, a field only
 * one of them has included, or is undefined where every field is the same.
 * A field left out and one left undefined are the same.
 */
export function differs(
  saved: Readonly<Record<string, unknown>>,
  now: Readonly<Record<string, unknown>>,
): string | undefined {
  const fields = new Set([...Object.keys(now), ...Object.keys(saved)]);
  return [...fields].find((field) => saved[field] !== now[field]);
}
