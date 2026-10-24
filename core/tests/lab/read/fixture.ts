/**
 * @fileoverview The files the read lab measures, and the page cache around
 * them.
 *
 * The 96 MB file is the sales fixture repeated, written once to a folder on
 * a real disk (/tmp is RAM on this machine). The 2.5 GB file was generated
 * by another checkout and is only ever read. `drop` evicts one file's cached
 * pages without root, so the next read of it comes from the disk.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { repeated } from '@core-tests/testdata/sales-q3';

/** Where the lab writes its disk files. UNO_LAB_DIR overrides it. */
export const LAB_FOLDER =
  process.env['UNO_LAB_DIR'] ?? join(homedir(), '.cache', 'uno-lab', 'read');

/** The checkout that generated the large fixtures. */
const GENERATOR = join(homedir(), 'Documents/opensource/uno');

/**
 * Where that checkout keeps them: under core/ since the rename, under
 * internal/grid/ before it.
 */
const GENERATED = [
  'core/tests/testdata/generated',
  'internal/grid/tests/testdata/generated',
].map((folder) => join(GENERATOR, folder));

/**
 * The 2.5 GB fixture, sales-q3.csv 10,400 times over, in whichever layout
 * the checkout has. UNO_LAB_BIG overrides it.
 */
export const BIG_FILE =
  process.env['UNO_LAB_BIG'] ??
  GENERATED.map((folder) => join(folder, 'sales-q3-50m.csv')).find((path) =>
    existsSync(path),
  ) ??
  join(GENERATED[0]!, 'sales-q3-50m.csv');

/** Copies of the fixture's rows in the 96 MB file: 1,924,800 rows. */
export const FULL_REPEATS = 400;
/** Copies in the small file the proving run uses: 24 MB. */
export const SMALL_REPEATS = 100;

/** The file of `repeats` copies in the lab folder, written if it is missing. */
export function repeatedFile(repeats: number): string {
  const path = join(LAB_FOLDER, `sales-q3-x${repeats}.csv`);
  const bytes = repeated(repeats);
  if (existsSync(path) && statSync(path).size === bytes.length) return path;
  mkdirSync(LAB_FOLDER, { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/** drop evicts the file's pages from the page cache. */
export function drop(path: string): void {
  execFileSync('dd', [`if=${path}`, 'iflag=nocache', 'count=0', 'status=none']);
}

/** resident returns how many of the file's bytes are in the page cache. */
export function resident(path: string): number {
  const out = execFileSync(
    'fincore',
    ['--bytes', '--noheadings', '--output', 'RES', path],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

/** The filesystem a path is on and its mount options, as findmnt reports them. */
export function filesystemOf(path: string): string {
  return execFileSync(
    'findmnt',
    ['--noheadings', '--output', 'SOURCE,FSTYPE,OPTIONS', '--target', path],
    { encoding: 'utf8' },
  ).trim();
}
