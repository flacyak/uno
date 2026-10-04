/**
 * @fileoverview Stands in for tests/efficiency/record.ts when a suite runs
 * under lab.config.ts. With METHOD_OUT_DIR set, a suite's metrics are written
 * to <METHOD_OUT_DIR>/<kind>/<suite>.json, so the lab's many runs never
 * overwrite core/out/<kind>/, which other people and tools read. Without it,
 * every call goes to the real record.ts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  KINDS,
  outFolder as coreOutFolder,
  record as coreRecord,
} from '../../efficiency/record.ts';
import type { Kind, Metric } from '../../efficiency/record.ts';

export { KINDS };
export type { Kind, Metric };

/** The environment variable naming the folder metrics are written under. */
export const OUT_ENV = 'METHOD_OUT_DIR';
/** How many spaces the written JSON is indented by, as in record.ts. */
const INDENT = 2;

export function outFolder(kind: Kind): string {
  const root = process.env[OUT_ENV];
  return root === undefined ? coreOutFolder(kind) : `${join(root, kind)}/`;
}

/** record writes one suite's metrics, as record.ts does, to outFolder. */
export function record(
  suite: string,
  metrics: readonly Metric[],
  kind: Kind = 'efficiency',
): void {
  if (process.env[OUT_ENV] === undefined) {
    coreRecord(suite, metrics, kind);
    return;
  }
  const out = outFolder(kind);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    `${out}${suite}.json`,
    `${JSON.stringify(metrics, null, INDENT)}\n`,
  );
}
