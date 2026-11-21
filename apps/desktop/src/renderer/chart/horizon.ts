/**
 * @fileoverview A horizon chart: a row per series, its amounts cut into equal
 * bands of one scale for every row, each folded into the row over the last, a
 * darker band a larger amount for every eye; below zero in the pole's steps.
 */

import type { TimeTally } from "@engine";
import { el } from "@renderer/shell/util";
import { barsBox } from "./bars.ts";
import type { PlotRoom } from "./kind.ts";
import { BARS_INSET } from "./rows.ts";
import { mark } from "./scatter.ts";

/** The bands a row folds its amounts into, and the ramp's steps they wear, lightest first: adjacent steps, which theme.test.ts holds apart. */
export const HORIZON_BANDS = 3;
const BAND_STEPS = [2, 3, 4] as const;

/** The least room a period takes across, in px. */
const PITCH_LEAST = 1;

/** amountsOf gives `tally`'s rows, or sums, at its finest size whose periods get a px of `room`. */
export function amountsOf(tally: TimeTally, summed: boolean, room: PlotRoom): number[] | undefined {
  const fits = (span: number) => span * PITCH_LEAST <= room.width - 2 * BARS_INSET;
  const level = tally.levels.find((l) => fits(l.span)) ?? tally.levels.at(-1);
  return level === undefined ? undefined : summed ? level.sum : level.rows;
}

/** bandOf gives the path of band `k` of `amounts` folded into a row 1 high, each amount `band` a band, from zero up. */
function bandOf(amounts: readonly number[], band: number, k: number): string {
  const heights = amounts.map((a) => Math.min(Math.max((a - k * band) / band, 0), 1));
  return `M0 1${heights.map((h, i) => `V${1 - h}H${i + 1}`).join("")}V1Z`;
}

/** strip draws `amounts` in a row as folded bands, each `band` an amount, above zero and below. */
function strip(amounts: readonly number[], band: number): SVGSVGElement {
  const drawn = mark("svg", "chart-horizon-bands");
  drawn.setAttribute("viewBox", `0 0 ${amounts.length} 1`);
  drawn.setAttribute("preserveAspectRatio", "none");
  for (const [arm, sign] of [
    ["seq", 1],
    ["div", -1],
  ] as const) {
    for (const [k, step] of BAND_STEPS.entries()) {
      const path = mark("path", "chart-horizon-band");
      path.setAttribute(
        "d",
        bandOf(
          amounts.map((a) => sign * a),
          band,
          k,
        ),
      );
      path.style.fill = `var(--${arm}-${step})`;
      drawn.append(path);
    }
  }
  return drawn;
}

/** horizonRow draws `amounts` as a row of folded bands on a scale of the most of them. */
export function horizonRow(amounts: readonly number[]): HTMLElement {
  const box = barsBox("chart-horizon");
  const most = Math.max(0, ...amounts.map(Math.abs));
  const bands = el("div", "chart-horizon-row");
  bands.append(strip(amounts, most === 0 ? 1 : most / HORIZON_BANDS));
  box.append(bands);
  return box;
}
