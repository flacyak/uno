// What changed between two runs of the efficiency tests, as a table.
//
// The counts are exact, so any difference between a pull request and the
// branch it is going into is something the change did, and is worth a line.

import type { Metric } from "./record.ts";

/** Change is one metric as it was and as it is. Either side can be missing. */
export interface Change {
  name: string;
  unit: string;
  base: number | undefined;
  head: number | undefined;
}

/** compare lines the two runs up by name, in the order the newer one lists them. */
export function compare(base: readonly Metric[], head: readonly Metric[]): Change[] {
  const before = new Map(base.map((m) => [m.name, m]));
  const after = new Set(head.map((m) => m.name));
  return [
    ...head.map((m) => ({
      name: m.name,
      unit: m.unit,
      base: before.get(m.name)?.value,
      head: m.value,
    })),
    ...base
      .filter((m) => !after.has(m.name))
      .map((m) => ({ name: m.name, unit: m.unit, base: m.value, head: undefined })),
  ];
}

/** The unit of the one metric that is a wall clock, and moves with the machine. */
const CLOCK = "ms";
/** How many digits a number that is not whole is shown to. */
const DIGITS = 2;
const PERCENT = 100;

function shown(value: number | undefined): string {
  if (value === undefined) return "";
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: DIGITS });
}

/** What a change comes to, in words: every metric here is one where smaller is better. */
function verdict(c: Change): string {
  if (c.base === undefined) return "new";
  if (c.head === undefined) return "gone";
  if (c.head === c.base) return "same";
  const by = c.base === 0 ? "" : ` ${Math.abs(((c.head - c.base) / c.base) * PERCENT).toFixed(1)}%`;
  const noisy = c.unit === CLOCK ? " (wall clock)" : "";
  return `${c.head < c.base ? "better" : "worse"}${by}${noisy}`;
}

/** markdown writes the changes as a table a pull request can show. */
export function markdown(changes: readonly Change[], baseline: boolean): string {
  const lines = [
    "### Efficiency",
    "",
    baseline
      ? "What this change costs, beside the branch it is going into. Smaller is better."
      : "What this change costs. The branch it is going into has no efficiency tests to compare with.",
    "",
    "| Metric | Unit | Base | Head | Change |",
    "| --- | --- | ---: | ---: | --- |",
    ...changes.map(
      (c) => `| ${c.name} | ${c.unit} | ${shown(c.base)} | ${shown(c.head)} | ${verdict(c)} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
