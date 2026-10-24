/**
 * @fileoverview Writes a suite's metrics to out/<kind>/<suite>.json as a list
 * of { name, unit, value }. Smaller is better for every metric.
 *
 * The kind is what the suite measures: `efficiency` counts what a change
 * costs in requests, bytes and entries, and `performance` times what it
 * does. scripts/report.ts reads a kind's folder and reports it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** What a number counts. */
export type Unit = 'requests' | 'bytes' | 'x' | 'entries' | 'ms';

/** Metric is one number about one scenario. */
export interface Metric {
  /** What was measured. Used as the chart title. */
  name: string;
  unit: Unit;
  value: number;
}

/** Kind is what a suite measures, and the folder its metrics are written to. */
export type Kind = 'efficiency' | 'performance';

export const KINDS: readonly Kind[] = ['efficiency', 'performance'];

/** The folder a kind's metrics are written to. */
export function outFolder(kind: Kind): string {
  return fileURLToPath(new URL(`../../out/${kind}/`, import.meta.url));
}

/** How many spaces the written JSON is indented by. */
const INDENT = 2;

/** record writes one suite's metrics, replacing what an earlier run wrote. */
export function record(
  suite: string,
  metrics: readonly Metric[],
  kind: Kind = 'efficiency',
): void {
  const out = outFolder(kind);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    `${out}${suite}.json`,
    `${JSON.stringify(metrics, null, INDENT)}\n`,
  );
}
