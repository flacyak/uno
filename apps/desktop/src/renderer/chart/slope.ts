/**
 * @fileoverview A slope chart: a line per value from its From end, left, to
 * its To end, right, on one scale, so it never reads as two. Every line wears
 * the accent, as its slope says whether it rose or fell. The lines and dots
 * are SVG in shares of the plot, as a scatter's points are.
 */

import type { SlopePlot } from "@document";
import type { SlopeTally } from "@engine";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import type { Ended } from "@tally";
import { axis } from "./axes.ts";
import { TIP_GAP } from "./bars.ts";
import { LEGEND_NAME_AT_MOST } from "./legend.ts";
import { BARS_INSET } from "./rows.ts";
import { POINT_RADIUS, gridline, mark, percent } from "./scatter.ts";

/** The ring of the window's ground round a dot, in px: the dataviz skill's 2 px. */
const RING = 2;

/** Where the From end and the To end stand across the plot. */
const ENDS_AT = ["0", "100%"] as const;

/** The most values a slope draws, the largest first: past a dozen, lines cross into a tangle. */
export const SLOPES_AT_MOST = 12;

/** A value a slope draws: its label, and where it stands at each state, none where it has no number there. */
export interface Sloped {
  label: string;
  ends: [number | undefined, number | undefined];
}

/** A slope's rows to draw, its two states, and the values it leaves out. */
export interface Slopes {
  rows: Sloped[];
  states: [string, string];
  /** The values past those drawn, which a line under the plot counts. */
  more: number;
}

/**
 * sloped gives the first SLOPES_AT_MOST of `tally`'s values as `plot`
 * measures them at each end: its rows, its sum, or its mean, none for an end
 * of no rows or of no number, and none at all for a value whose rows count
 * apart from their states, as its ends may lack some.
 */
export function sloped(plot: SlopePlot, tally: SlopeTally): Slopes {
  const at = ({ rows, sum, numbers }: Ended): number | undefined => {
    if (rows === 0) return undefined;
    if (plot.of === undefined) return rows;
    if (plot.measure === "sum") return sum;
    return numbers === 0 ? undefined : sum / numbers;
  };
  const rows = tally.values.map(({ value, ends, unsplit }): Sloped => ({
    label: value,
    ends: unsplit ? [undefined, undefined] : [at(ends[0]), at(ends[1])],
  }));
  const more = Math.max(rows.length - SLOPES_AT_MOST, 0) + tally.others.values;
  return { rows: rows.slice(0, SLOPES_AT_MOST), states: [plot.from, plot.to], more };
}

/** Splits a name into the letters a reader sees, each a mono character. */
const LETTERS = new Intl.Segmenter();

/** wide gives the characters `text` takes, mono. */
const wide = (text: string): number => [...LETTERS.segment(text)].length;

/** placed gives `label` standing at `top` of its side, its middle on its end. */
function placed(label: HTMLElement, top: string): HTMLElement {
  label.style.top = top;
  return label;
}

/**
 * ended gives a To end's label: the value's name, whole in its title and cut
 * at LEGEND_NAME_AT_MOST characters, and its number.
 */
function ended(label: string, at: number): HTMLElement {
  const name = label === "" ? m.chart_blank_value() : label;
  const made = el("span", "chart-slope-end");
  made.title = name;
  const named =
    label === ""
      ? el("span", "chart-slope-name chart-blank", name)
      : el("bdi", "chart-slope-name from-file", name);
  made.append(named, " ", el("span", "chart-slope-value", num(at)));
  return made;
}

/** line gives a mark of class `cls` from `x1`, `y1` to `x2`, `y2` of the plot. */
function line(cls: string, x1: string, y1: string, x2: string, y2: string): SVGLineElement {
  const made = mark("line", cls);
  for (const [name, at] of Object.entries({ x1, y1, x2, y2 })) made.setAttribute(name, at);
  return made;
}

/**
 * slopes draws `rows` on two axes named by `states`, a line per value between
 * its ends on one scale over every end, a dot at each end, over every line,
 * each From end's number left of it and each To end's name and number right
 * of it, and a line under them counting the `more` values left out.
 */
export function slopes({ rows, states, more }: Slopes): HTMLElement {
  const box = el("div", "chart-slope");
  box.style.setProperty("--inset", `${BARS_INSET}px`);
  box.style.setProperty("--tip-gap", `${TIP_GAP}px`);
  box.style.setProperty("--name-most", `${LEGEND_NAME_AT_MOST}ch`);
  box.style.setProperty("--ring", `${RING}px`);
  box.style.setProperty("--dot-reach", `${POINT_RADIUS + RING}px`);
  const ends = rows.flatMap(({ ends: both }) => both.filter((at) => at !== undefined));
  const finite = ends.filter(Number.isFinite);
  const scale = finite.length === 0 ? axis(0, 0) : axis(Math.min(...finite), Math.max(...finite));
  const [low, high] = [scale.ticks[0]!, scale.ticks.at(-1)!];
  // SVG counts down from the top, and the scale up from its least.
  const y = (at: number) => percent(1 - Math.min(Math.max((at - low) / (high - low), 0), 1));
  const plot = mark("svg", "chart-slope-plot");
  plot.setAttribute("aria-hidden", "true");
  plot.append(...ENDS_AT.map((x) => gridline("y", x, "0", x, "100%")));
  const dots: SVGCircleElement[] = [];
  for (const [from, to] of rows.map((row) => row.ends)) {
    if (from !== undefined && to !== undefined) {
      plot.append(line("chart-slope-line", ENDS_AT[0], y(from), ENDS_AT[1], y(to)));
    }
    for (const [i, at] of [from, to].entries()) {
      if (at === undefined) continue;
      const dot = mark("circle", "chart-slope-dot");
      dot.setAttribute("cx", ENDS_AT[i]!);
      dot.setAttribute("cy", y(at));
      dot.setAttribute("r", `${POINT_RADIUS}`);
      dots.push(dot);
    }
  }
  // Every dot stands over every line, so no line runs across another's end.
  plot.append(...dots);
  const [from, to] = [el("div", "chart-slope-ends from"), el("div", "chart-slope-ends to")];
  // A side is as wide as its state's name and its widest label, a To end's name cut as a key's.
  const wides = [[wide(states[0])], [wide(states[1])]];
  for (const {
    label,
    ends: [left, right],
  } of rows) {
    if (left !== undefined) {
      from.append(placed(el("span", "chart-slope-value", num(left)), y(left)));
      wides[0]!.push(wide(num(left)));
    }
    if (right === undefined) continue;
    to.append(placed(ended(label, right), y(right)));
    const name = label === "" ? m.chart_blank_value() : label;
    wides[1]!.push(Math.min(wide(name), LEGEND_NAME_AT_MOST) + 1 + wide(num(right)));
  }
  box.style.setProperty("--from-wide", `${Math.max(...wides[0]!)}ch`);
  box.style.setProperty("--to-wide", `${Math.max(...wides[1]!)}ch`);
  const named = el("div", "chart-slope-states");
  named.append(...states.map((state) => el("bdi", "chart-slope-state from-file", state)));
  box.append(named, from, plot, to);
  if (more > 0) box.append(el("div", "chart-bars-line", m.chart_bars_more({ count: num(more) })));
  return box;
}

/**
 * fitSlopes leaves out each end's label that would stand over one placed
 * before it on its side, the largest values' first, as the dataviz skill
 * leaves colliding end labels to the tooltip and the table rather than nudge
 * them off their ends. It measures, so the plot stands in the page by then.
 */
export function fitSlopes(box: HTMLElement): void {
  for (const side of box.querySelectorAll(".chart-slope-ends")) {
    const taken: DOMRect[] = [];
    // A static list, as labels leave the side on the way.
    for (const label of side.querySelectorAll(":scope > *")) {
      const at = label.getBoundingClientRect();
      // A plot not laid out yet has nothing to measure, and draws again as it takes a size.
      if (at.height === 0) return;
      if (taken.some((other) => at.top < other.bottom && other.top < at.bottom)) label.remove();
      else taken.push(at);
    }
  }
}
