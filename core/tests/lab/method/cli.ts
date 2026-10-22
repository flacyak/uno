/**
 * @fileoverview What the lab's two scripts share: reading flags, laying out
 * a plain text table, describing the machine, and writing the result as
 * JSON to a file and as the last line of stdout.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, statfsSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, totalmem } from 'node:os';
import { dirname } from 'node:path';

import type { Values } from './aa.ts';
import { CORE_DIR } from './suite.ts';
import type { Recorded } from './suite.ts';

/** How many spaces the written JSON is indented by. */
const INDENT = 2;
/** The f_type statfs reports for tmpfs (linux/magic.h). */
const TMPFS_MAGIC = 0x01021994;
const BYTES_PER_GIB = 1 << 30;
/** Fraction digits shown for a number in a table. */
export const DIGITS = 2;
/** Space between table columns. */
const GAP = '  ';

/** positiveInt reads a flag's value as a whole number above zero. */
export function positiveInt(text: string, flag: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--${flag} takes a whole number above zero, not ${text}`);
  }
  return n;
}

/** table lays out rows under a header, each column as wide as its widest cell. */
export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const all = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...all.map((row) => (row[col] ?? '').length)),
  );
  return all
    .map((row) =>
      row
        .map((cell, col) => cell.padEnd(widths[col]!))
        .join(GAP)
        .trimEnd(),
    )
    .join('\n');
}

/** fixed shows a number with DIGITS fraction digits. */
export function fixed(n: number): string {
  return n.toFixed(DIGITS);
}

/** valuesOf keys one run's metrics by name. */
export function valuesOf(metrics: readonly Recorded[]): Values {
  return new Map(
    metrics.map((m) => [m.name, { unit: m.unit, value: m.value }]),
  );
}

/** The commit core/ is at, and whether its tree has uncommitted changes. */
function commit(): { sha: string; dirty: boolean } {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: CORE_DIR, encoding: 'utf8' }).trim();
  return {
    sha: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain') !== '',
  };
}

/** Machine is what the numbers were measured on. */
export interface Machine {
  cpu: string;
  threads: number;
  memoryGiB: number;
  node: string;
  platform: string;
  /** TMPDIR handed to every run. */
  tmpDir: string;
  /** Whether that folder is RAM, which a GitHub runner's /tmp is not. */
  tmpIsTmpfs: boolean;
  /** The one-minute load average when the script started. */
  load1: number;
  sha: string;
  dirty: boolean;
}

/** machine describes what the numbers were measured on. */
export function machine(tmpDir: string): Machine {
  return {
    cpu: cpus()[0]?.model ?? 'unknown',
    threads: availableParallelism(),
    memoryGiB: Math.round(totalmem() / BYTES_PER_GIB),
    node: process.version,
    platform: process.platform,
    tmpDir,
    tmpIsTmpfs: statfsSync(tmpDir).type === TMPFS_MAGIC,
    load1: loadavg()[0]!,
    ...commit(),
  };
}

/** finish writes the result to `file` and prints it as the last stdout line. */
export function finish(result: unknown, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, INDENT)}\n`);
  console.log(JSON.stringify(result));
}
