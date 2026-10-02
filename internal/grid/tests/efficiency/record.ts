// Where an efficiency test writes what it measured.
//
// Each test file measures one thing a person waits on and writes its numbers
// to out/efficiency/<suite>.json as a list of { name, unit, value }. That
// shape is what a benchmark tracker reads as it is, so the files can be handed
// to one from a workflow and plotted commit by commit. Every metric here is
// one where smaller is better.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** What a number counts. */
export type Unit = "requests" | "bytes" | "x" | "entries" | "ms";

/** Metric is one number about one scenario. */
export interface Metric {
  /** What was measured, in words a chart can be titled with. */
  name: string;
  unit: Unit;
  value: number;
}

const OUT = fileURLToPath(new URL("../../out/efficiency/", import.meta.url));

/** How many spaces the written JSON is indented by. */
const INDENT = 2;

/** record writes one suite's metrics, replacing what an earlier run wrote. */
export function record(suite: string, metrics: readonly Metric[]): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}${suite}.json`, `${JSON.stringify(metrics, null, INDENT)}\n`);
}
