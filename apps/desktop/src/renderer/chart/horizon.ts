/**
 * @fileoverview A horizon chart: a row per series, its amounts cut into equal
 * bands of one round scale for every row, each folded into the row over the
 * last, a darker band a larger amount for every eye; below zero in the pole's
 * steps. A legend over the rows keys the bands, and under them a line counts
 * the values left out, over their periods' labels. Each period of a row is a
 * target the pointer and the keys step through.
 */

import type { HeatTally } from "@engine";
import type { SplitLevel, TimeLevel } from "@tally";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { barsBox } from "./bars.ts";
import { periodsUnder } from "./heat.ts";
import { fullName } from "./periods.ts";
import type { Periods } from "./heat.ts";
import type { PlotRoom } from "./kind.ts";
import { HATCH_LINE, classOf, classesOver, fillOf, hatchOf, scaleOf } from "./ramp.ts";
import type { Classes } from "./ramp.ts";
import { BARS_INSET, row, rowsIn, trackWide } from "./rows.ts";
import { TICK_GAP, mark } from "./scatter.ts";
import { among, named } from "./tooltip.ts";
import type { Reading, Targets } from "./tooltip.ts";
import { stepsOf } from "./week.ts";

/** The bands a row folds its amounts into, and the ramp's steps they wear, lightest first: adjacent steps, which theme.test.ts holds apart. */
export const HORIZON_BANDS = 3;
const BAND_STEPS = [2, 3, 4] as const;

/** The most series a horizon chart draws a row for, and the least room a period takes across, in px. */
export const HORIZON_ROWS_AT_MOST = 12;
const PITCH_LEAST = 1;

/** The rows the legend over the bands and the periods' labels under them take. */
const ROWS_BESIDE = 2;

/** A series a horizon chart draws: its value, none for a chart of one, its rows, and its rows and amount per period. */
export interface Series {
  value: string | undefined;
  rows: number;
  counts: readonly number[];
  amounts: readonly number[];
}

/** What a horizon chart draws: its periods, its series, largest first, and the values its tally did not send. */
export interface Horizon {
  periods: Periods;
  series: Series[];
  others: { values: number; rows: number };
}

/** horizonLevel gives the finest of `levels` whose periods get a px of `room`, or the coarsest. */
export function horizonLevel<L extends Periods>(
  levels: readonly L[],
  room: PlotRoom,
): L | undefined {
  return levels.find((l) => l.span * PITCH_LEAST <= room.width - 2 * BARS_INSET) ?? levels.at(-1);
}

/** timeSeries gives an over-time chart's `level` as a horizon of one series, of rows or sums. */
export function timeSeries(level: TimeLevel, summed: boolean): Horizon {
  const rows = level.rows.reduce((all, each) => all + each, 0);
  const amounts = summed ? level.sum : level.rows;
  const series = [{ value: undefined, rows, counts: level.rows, amounts }];
  const periods = { per: level.per, from: level.from + level.offset, span: level.rows.length };
  return { periods, series, others: { values: 0, rows: 0 } };
}

/** heatSeries gives a heatmap's `level` of `tally` as a horizon of a series per value, of rows or sums. */
export function heatSeries(tally: HeatTally, level: SplitLevel, summed: boolean): Horizon {
  const series = (summed ? level.sum : level.rows).map((each, i) => {
    const { value, rows } = tally.values[i]!;
    return { value, rows, counts: level.rows[i]!, amounts: each };
  });
  return { periods: level, series, others: tally.others };
}

/** bandFill gives the colour band `k` wears, 1 to HORIZON_BANDS above zero and -1 down below it, none at zero. */
function bandFill(k: number): string | undefined {
  if (k === 0) return undefined;
  return fillOf(Math.sign(k) * BAND_STEPS[Math.abs(k) - 1]!);
}

/** bandsOver gives the bands of `drawn`'s amounts, whole for rows, as horizonRows cuts them. */
function bandsOver(drawn: readonly Series[], summed: boolean): Classes {
  return classesOver(
    drawn.flatMap((s) => s.amounts),
    !summed,
    HORIZON_BANDS,
  );
}

/** bandOf gives the path of band `k` of `amounts` folded into a row 1 high, each amount `band` a band, from zero up. */
function bandOf(amounts: readonly number[], band: number, k: number): string {
  const heights = amounts.map((a) => Math.min(Math.max((a - k * band) / band, 0), 1));
  return `M0 1${heights.map((h, i) => `V${1 - h}H${i + 1}`).join("")}V1Z`;
}

/** How many hatches the page has made, so each band's pattern has an id of its own. */
let hatches = 0;

/** hatchFor gives `drawn` the hatch band `k` wears under forced colours, its ramp step's, in screen px once fitHatches runs, and its url. */
function hatchFor(drawn: SVGSVGElement, k: number): string {
  const { pitch, angle } = hatchOf(Math.sign(k) * BAND_STEPS[Math.abs(k) - 1]!);
  const pattern = mark("pattern", "");
  pattern.id = `chart-horizon-hatch-${++hatches}`;
  pattern.dataset["angle"] = `${angle}`;
  const sized = { width: `${pitch}`, height: `${pitch}` };
  for (const [name, value] of Object.entries({ patternUnits: "userSpaceOnUse", ...sized })) {
    pattern.setAttribute(name, value);
  }
  const [ground, line] = [mark("rect", "chart-hatch-ground"), mark("rect", "chart-hatch-line")];
  for (const [name, value] of Object.entries(sized)) ground.setAttribute(name, value);
  for (const [name, value] of Object.entries({ ...sized, width: `${HATCH_LINE}` })) {
    line.setAttribute(name, value);
  }
  pattern.append(ground, line);
  drawn.querySelector("defs")!.append(pattern);
  return `url(#${pattern.id})`;
}

/**
 * fitHatches undoes each row's stretch in its bands' hatches, so their lines
 * stand as far apart on the screen in every row: a row's viewBox is a unit a
 * period across and one high, stretched to the px it stands in.
 */
export function fitHatches(box: HTMLElement): void {
  for (const drawn of box.querySelectorAll<SVGSVGElement>(".chart-horizon-bands")) {
    const { width, height } = drawn.getBoundingClientRect();
    // A row not laid out yet has nothing to measure, and draws again as it takes a size.
    if (width === 0 || height === 0) continue;
    const view = drawn.viewBox.baseVal;
    const [across, up] = [view.width / width, view.height / height];
    for (const pattern of drawn.querySelectorAll("pattern")) {
      const angle = pattern.dataset["angle"];
      pattern.setAttribute("patternTransform", `scale(${across} ${up}) rotate(${angle})`);
    }
  }
}

/** strip draws `amounts` in a row as folded bands, each `band` an amount, above zero and below. */
function strip(amounts: readonly number[], band: number): SVGSVGElement {
  const drawn = mark("svg", "chart-horizon-bands");
  drawn.setAttribute("viewBox", `0 0 ${amounts.length} 1`);
  drawn.setAttribute("preserveAspectRatio", "none");
  drawn.append(mark("defs", ""));
  for (const sign of [1, -1]) {
    for (const k of BAND_STEPS.keys()) {
      const path = mark("path", "chart-horizon-band");
      path.setAttribute(
        "d",
        bandOf(
          amounts.map((a) => sign * a),
          band,
          k,
        ),
      );
      path.style.setProperty("--fill", bandFill(sign * (k + 1)) ?? "");
      path.style.setProperty("--hatch", hatchFor(drawn, sign * (k + 1)));
      drawn.append(path);
    }
  }
  for (const p of amounts.keys()) {
    const period = mark("rect", "chart-horizon-period");
    for (const [name, value] of Object.entries({ x: p, y: 0, width: 1, height: 1 })) {
      period.setAttribute(name, `${value}`);
    }
    drawn.append(period);
  }
  return drawn;
}

/**
 * horizonRows draws `horizon`, of rows or of sums where `summed`, in a plot
 * `height` px high: the legend of its bands, then a row a series that fits,
 * at most HORIZON_ROWS_AT_MOST, every row on one scale, and a line counting
 * the values left out.
 */
export function horizonRows(
  { periods, series, others }: Horizon,
  summed: boolean,
  room: PlotRoom,
  height: number,
): HTMLElement {
  const alone = series[0]?.value === undefined;
  const box = barsBox("chart-horizon", ...(alone ? ["alone"] : []));
  box.style.setProperty("--tick-gap", `${TICK_GAP}px`);
  const fits = Math.max(rowsIn(height) - ROWS_BESIDE, 1);
  const left = (shown: number) => series.length - shown + others.values;
  let shown = Math.min(series.length, HORIZON_ROWS_AT_MOST, fits);
  if (left(shown) > 0 && shown === fits) shown = Math.max(shown - 1, 1);
  const drawn = series.slice(0, shown);
  const amounts = drawn.flatMap((s) => s.amounts);
  const bands = bandsOver(drawn, summed);
  const names = drawn.flatMap(({ value }) => (value === undefined ? [] : [value]));
  const wide = trackWide(names, room);
  const scale = scaleOf(
    bands,
    amounts.some((a) => a < 0),
    wide,
    room.ch,
    bandFill,
  );
  const legend = el("div", "chart-bar-row chart-heat-legend");
  legend.append(el("span"), scale);
  box.append(legend);
  for (const { value, amounts } of drawn) {
    const bandsRow = el("div", "chart-horizon-row");
    bandsRow.append(strip(amounts, bands.width));
    box.append(value === undefined ? bandsRow : row(value, bandsRow));
  }
  if (left(shown) > 0) {
    const rest = series.slice(shown).reduce((n, s) => n + s.rows, others.rows);
    const more = m.chart_bars_more({ count: num(left(shown)) });
    box.append(el("div", "chart-bars-line", `${more} · ${m.rows_count({ count: rest })}`));
  }
  box.append(periodsUnder(periods, wide, room.ch));
  return box;
}

/**
 * horizonTargets gives the periods of `drawn`, as horizonRows drew `horizon`:
 * each worth its rows, or its sum and rows where `summed`, named by its value
 * and its period in full, in the colour of the furthest band it reaches.
 * Right and Left step along a value, Home and End to its ends, and Down and
 * Up to the same period of the next value and the one before.
 */
export function horizonTargets(horizon: Horizon, summed: boolean, drawn: HTMLElement): Targets {
  const { per, from, span } = horizon.periods;
  const marks = [...drawn.querySelectorAll(".chart-horizon-period")];
  const shown = horizon.series.slice(0, marks.length / span);
  const bands = bandsOver(shown, summed);
  const all = marks.map((mark, n) => {
    const { value, counts, amounts } = shown[Math.floor(n / span)]!;
    const p = n % span;
    const said = (): Reading[] => {
      const name = el("span");
      if (value !== undefined) name.append(named(value), ", ");
      name.append(fullName(per, from + p));
      const rows = { value: num(counts[p]!), label: el("span", "", m.chart_table_rows()) };
      return summed ? [{ value: num(amounts[p]!), label: name }, rows] : [{ ...rows, label: name }];
    };
    const key = bandFill(classOf(amounts[p]!, bands)) ?? "var(--rule)";
    return { mark, at: mark, front: false, key, said };
  });
  const step = (key: string, at: number | undefined): number | undefined => {
    const to = stepsOf(span, marks.length).get(key);
    if (to === undefined) return undefined;
    return at === undefined ? 0 : to(at);
  };
  return { all, under: among(all, ".chart-horizon-period"), step, keys: ["ArrowDown", "ArrowUp"] };
}
