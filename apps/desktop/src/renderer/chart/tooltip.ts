/**
 * @fileoverview What a chart says of one of its marks, under the pointer or
 * stepped to with the keys: a box of the pop-up menu's kind beside the mark,
 * inside the window, with the colour the mark wears as its key, what the
 * mark is worth strong, and what that is of in the caption's ink, while the
 * mark wears the cursor. A bar's row is its hit target, a slice its own
 * shape, and a point snaps to the nearest within HIT_RADIUS, so none has to
 * be hit dead on. Right, Left, Home and End on the plot step the cursor
 * through the marks in the order they were drawn, a scatter's from left to
 * right.
 *
 * A value from the file is set as text alone, and a number is written in the
 * app's language.
 */

import type { ChartColumn, Plot } from "@document";
import type { Groups, GroupsTally, Sample, SampleTally } from "@engine";
import { m } from "@paraglide/messages";
import type { Press } from "@renderer/keys";
import { columnLabel, unnamed } from "@renderer/grid/rows";
import { num, percent } from "@renderer/locale";
import { EDGE } from "@renderer/shell/menu";
import { el } from "@renderer/shell/util";
import { slices, wholeOf } from "./pie.ts";
import type { Room } from "./place.ts";

/**
 * How near a pointer has to come to a point, in px: half the dataviz skill's
 * least hit area, 24 px across.
 */
export const HIT_RADIUS = 12;

/**
 * How far the box stands from its anchor, in px: clear of a pointer's arrow,
 * which reaches about 12 px right of its point.
 */
export const TIP_OFFSET = 16;

/**
 * How far the box keeps inside the window's edge, in px: as far as the
 * pop-up menu keeps inside the app's.
 */
export const TIP_EDGE = EDGE;

/** What the bars and the points wear, as the box's key. */
const ACCENT = "var(--accent)";

/** What a mark wears while the cursor is on it. */
const CURSOR = "cursor";

/** The pointer a finger is, which leaves the plot as it lifts off. */
const TOUCH = "touch";

/** Where a key steps the cursor, from `at` among marks up to `last`. */
type Step = (at: number | undefined, last: number) => number;

/**
 * Where each key steps the cursor: Right and Left to the next mark and the
 * one before, from the first or the last where no mark has the cursor, and
 * Home and End to the first and the last.
 */
const STEPS: ReadonlyMap<string, Step> = new Map<string, Step>([
  ["ArrowRight", (at, last) => (at === undefined ? 0 : Math.min(at + 1, last))],
  ["ArrowLeft", (at, last) => (at === undefined ? last : Math.max(at - 1, 0))],
  ["Home", () => 0],
  ["End", (_at, last) => last],
]);

/** What parts a label's words, as the caption's. */
const SEP = " · ";

/** What a share of the whole reads as, where scatter.ts wrote it as a percent. */
const WHOLE_PERCENT = 100;

/** What a bar chart, a pie and a scatter draw. */
type Bars = Extract<Plot, { t: "bars" }>;
type Pie = Extract<Plot, { t: "pie" }>;
type Scatter = Extract<Plot, { t: "scatter" }>;

/** One of a mark's readings: a number, and what it is of. */
export interface Reading {
  value: string;
  label: Node;
}

/** A mark a person can point at or step to. */
export interface Target {
  /** The mark that wears the cursor. */
  mark: Element;
  /** The mark the box stands by when the keys step to it. */
  at: Element;
  /** Whether the mark comes in front of the marks drawn after it while it has the cursor. */
  front: boolean;
  /** The colour the mark wears, as CSS. */
  key: string;
  /** What the mark is worth, read when the box says it. */
  said: () => Reading[];
}

/** The marks of a drawing, in the order the keys step through them. */
export interface Targets {
  all: Target[];
  /**
   * Which of `all` a pointer at `x`, `y` is over, where `hit` is what it is
   * over, or none.
   */
  under: (hit: EventTarget | null, x: number, y: number) => number | undefined;
}

/** The marks of nothing a pointer can point at. */
export const NONE: Targets = { all: [], under: () => undefined };

/**
 * named gives a value as the box says it: the file's text, marked as the
 * file's, or the app's word for the rows whose cell is blank.
 */
function named(value: string): HTMLElement {
  if (value === "") return el("span", "", m.chart_blank_value());
  return el("bdi", "from-file", value);
}

/**
 * column gives a column's name as the box says it: the file's header, marked
 * as the file's, or the app's name for one with none.
 */
function column({ header, col }: ChartColumn): HTMLElement {
  const label = columnLabel(header, col);
  return unnamed(header) ? el("span", "", label) : el("bdi", "from-file", label);
}

/** among gives the hit test of `all`, whose marks are the `selector` a pointer is over. */
function among(all: readonly Target[], selector: string): Targets["under"] {
  return (hit) => {
    const mark = hit instanceof Element ? hit.closest(selector) : null;
    const at = all.findIndex((target) => target.mark === mark);
    return at === -1 ? undefined : at;
  };
}

/**
 * barTargets gives the targets of `box`, as bars drew `groups` for `plot`:
 * each value's row, worth the rows it counts or the sum of its cells. The
 * box stands by the bar's value, or by the bar where the plot has no room
 * for values.
 */
export function barTargets(plot: Bars, groups: Groups, box: HTMLElement): Targets {
  const measure = (g: { rows: number; sum: number }): number =>
    plot.sum === undefined ? g.rows : g.sum;
  const all = [...box.querySelectorAll(".chart-bar-row")].map((row, i) => {
    const g = groups.groups[i]!;
    return {
      mark: row,
      at: row.querySelector(".chart-bar-tip") ?? row.querySelector(".chart-bar")!,
      front: false,
      key: ACCENT,
      said: () => [{ value: num(measure(g)), label: named(g.value) }],
    };
  });
  return { all, under: among(all, ".chart-bar-row") };
}

/**
 * sliceTargets gives the targets of `box`, as pie drew `groups` for `plot`:
 * each slice, worth what it measures, labelled by its value, or the app's
 * word for Other, and its share of the whole.
 */
export function sliceTargets(plot: Pie, groups: Groups, box: HTMLElement): Targets {
  const drawn = slices(plot, groups);
  const whole = wholeOf(drawn);
  const all = [...box.querySelectorAll<SVGElement>(".chart-slice")].map((slice, i) => {
    const { value, size } = drawn[i]!;
    const said = (): Reading[] => {
      const label = el("span");
      const name = value === undefined ? el("span", "", m.chart_pie_other()) : named(value);
      label.append(name, `${SEP}${percent(size / whole)}`);
      return [{ value: num(size), label }];
    };
    return {
      mark: slice,
      at: slice,
      front: false,
      key: slice.style.getPropertyValue("--key"),
      said,
    };
  });
  return { all, under: among(all, ".chart-slice") };
}

/** share reads where a point stands along `name`, as a share of the plot. */
function share(point: Element, name: string): number {
  return parseFloat(point.getAttribute(name) ?? "") / WHOLE_PERCENT;
}

/**
 * pointTargets gives the targets of `box`, as scatter drew `sample` for
 * `plot`: each point, worth its x and its y, named by their columns, from
 * left to right. The target of a pointer is the nearest point within
 * HIT_RADIUS of it.
 */
export function pointTargets(plot: Scatter, sample: Sample, box: HTMLElement): Targets {
  const points = [...box.querySelectorAll(".chart-point")]
    .map((point, i) => ({ point, i, x: share(point, "cx"), y: share(point, "cy") }))
    .sort((a, b) => a.x - b.x);
  const all = points.map(({ point, i }) => ({
    mark: point,
    at: point,
    front: true,
    key: ACCENT,
    said: () => [
      { value: num(sample.x[i]!), label: column(plot.x) },
      { value: num(sample.y[i]!), label: column(plot.y) },
    ],
  }));
  const svg = box.querySelector(".chart-points");
  const under = (_hit: EventTarget | null, x: number, y: number): number | undefined => {
    if (svg === null) return undefined;
    const { left, top, width, height } = svg.getBoundingClientRect();
    let near: number | undefined;
    let least = HIT_RADIUS ** 2;
    for (const [i, at] of points.entries()) {
      const apart = (left + at.x * width - x) ** 2 + (top + at.y * height - y) ** 2;
      if (apart <= least) {
        least = apart;
        near = i;
      }
    }
    return near;
  };
  return { all, under };
}

/**
 * targets gives the marks of `drawn`, as `plot` reads `tally`, or none of a
 * drawing of another kind.
 */
export function targets(plot: Plot, tally: GroupsTally | SampleTally, drawn: HTMLElement): Targets {
  if (plot.t === "bars" && tally.t === "groups") return barTargets(plot, tally, drawn);
  if (plot.t === "pie" && tally.t === "groups") return sliceTargets(plot, tally, drawn);
  if (plot.t === "scatter" && tally.t === "sample") return pointTargets(plot, tally, drawn);
  return NONE;
}

/** A point in the page, or in the window's own px. */
export interface Point {
  x: number;
  y: number;
}

/**
 * stood gives where a box `size` stands by `anchor`, a mark's box or a
 * pointer's point: TIP_OFFSET right of it, or left of it where `room` has
 * too little room on its right, and centred on it, moved as far as keeps the
 * whole of it TIP_EDGE inside the room, and TIP_EDGE from the room's corner
 * where it is larger than the room.
 */
export function stood(anchor: DOMRectReadOnly, size: Room, room: Room): Point {
  const right = anchor.right + TIP_OFFSET;
  const x = right + size.w <= room.w - TIP_EDGE ? right : anchor.left - TIP_OFFSET - size.w;
  const y = (anchor.top + anchor.bottom - size.h) / 2;
  return {
    x: Math.max(TIP_EDGE, Math.min(x, room.w - size.w - TIP_EDGE)),
    y: Math.max(TIP_EDGE, Math.min(y, room.h - size.h - TIP_EDGE)),
  };
}

/**
 * Tooltip is the box that says what a mark is worth. It hears the pointer
 * over `plot`, or a tap on it, and stands in `within`, the window, by the
 * mark the pointer is over, which wears the cursor, and a screen reader
 * hears it as what the plot describes. The keys step the cursor while the
 * plot has them, and it goes with them. A new drawing keeps a cursor the
 * keys put on the mark at the same place among its marks, and puts one the
 * pointer put on the mark under the pointer then.
 */
export class Tooltip {
  /** The box, which the window holds beside its plot. */
  readonly box = el("div", "chart-tip");
  private readonly key = el("span", "chart-tip-key");
  private readonly words = el("span", "chart-tip-words");
  private targets: Targets = NONE;
  /** The mark wearing the cursor. */
  private worn: Element | undefined;
  /** Where the cursor is among the marks, and the pointer's point where a pointer put it there. */
  private cursor: { at: number; point?: Point } | undefined;

  constructor(
    plot: HTMLElement,
    private readonly within: HTMLElement,
    id: string,
  ) {
    this.box.id = id;
    this.box.hidden = true;
    this.box.setAttribute("role", "tooltip");
    this.box.style.setProperty("--tip-edge", `${TIP_EDGE}px`);
    this.box.append(this.key, this.words);
    plot.setAttribute("aria-describedby", id);
    // A screen reader says which keys step the cursor, as STEPS reads them.
    plot.setAttribute("aria-keyshortcuts", [...STEPS.keys()].join(" "));
    plot.addEventListener("pointermove", (e) => this.point(e));
    plot.addEventListener("pointerdown", (e) => this.point(e));
    // A finger lifting off leaves the plot, so a tap's cursor stays for the next tap.
    plot.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== TOUCH) this.clear();
    });
    plot.addEventListener("focusout", () => this.clear());
  }

  /**
   * show takes the marks of a new drawing: a cursor the pointer put goes to
   * the mark under the pointer now, and any other stays where it stood among
   * them.
   */
  show(targets: Targets): void {
    this.targets = targets;
    const count = targets.all.length;
    const point = this.cursor?.point;
    if (point !== undefined) this.hover(document.elementFromPoint(point.x, point.y), point);
    else if (this.cursor === undefined || count === 0) this.clear();
    else this.place(Math.min(this.cursor.at, count - 1));
  }

  /**
   * step moves the cursor where `press` says, as STEPS reads it, and returns
   * whether it is one of those keys alone, with marks to step through.
   */
  step(press: Press): boolean {
    const last = this.targets.all.length - 1;
    const to = STEPS.get(press.key)?.(this.cursor?.at, last);
    if (to === undefined || last < 0 || press.ctrl || press.alt || press.meta || press.shift) {
      return false;
    }
    this.place(to);
    return true;
  }

  /** clear takes the cursor off its mark and hides the box, emptied, so the plot describes no mark. */
  clear(): void {
    this.worn?.classList.remove(CURSOR);
    this.worn = undefined;
    this.cursor = undefined;
    this.box.hidden = true;
    this.words.replaceChildren();
  }

  /** point puts the cursor on the mark under the pointer at `e`. */
  private point(e: PointerEvent): void {
    this.hover(e.target, { x: e.clientX, y: e.clientY });
  }

  /**
   * hover puts the cursor on the mark a pointer at `point` is over, `hit`
   * being what it is over, or takes it off where there is none.
   */
  private hover(hit: EventTarget | null, point: Point): void {
    const at = this.targets.under(hit, point.x, point.y);
    if (at === undefined) this.clear();
    else this.place(at, point);
  }

  /**
   * place puts the cursor on mark `at`, says what it is worth, and stands the
   * box by `point`, or beside the mark where no pointer put it there.
   */
  private place(at: number, point?: Point): void {
    const target = this.targets.all[at]!;
    if (this.worn !== target.mark) {
      this.worn?.classList.remove(CURSOR);
      target.mark.classList.add(CURSOR);
      this.worn = target.mark;
      if (target.front) target.mark.parentElement?.append(target.mark);
      this.say(target);
    }
    this.cursor = { at, point };
    this.box.hidden = false;
    this.stand(
      point === undefined ? target.at.getBoundingClientRect() : new DOMRect(point.x, point.y),
    );
  }

  /** say writes `target`'s key and its readings in the box, each value strong before its label. */
  private say({ key, said }: Target): void {
    this.key.style.setProperty("--key", key);
    this.words.replaceChildren(
      ...said().flatMap(({ value, label }, i) => {
        const muted = el("span", "chart-tip-label");
        muted.append(label);
        return [...(i > 0 ? [SEP] : []), el("strong", "chart-tip-value", value), " ", muted];
      }),
    );
  }

  /**
   * stand puts the box by `by`, where a mark or a pointer's point stands in
   * the page, inside the window.
   */
  private stand(by: DOMRectReadOnly): void {
    const room = this.within.getBoundingClientRect();
    const { clientLeft, clientTop, clientWidth, clientHeight } = this.within;
    const [left, top] = [room.left + clientLeft, room.top + clientTop];
    const anchor = new DOMRect(by.x - left, by.y - top, by.width, by.height);
    const size = { w: this.box.offsetWidth, h: this.box.offsetHeight };
    const { x, y } = stood(anchor, size, { w: clientWidth, h: clientHeight });
    this.box.style.left = `${x}px`;
    this.box.style.top = `${y}px`;
  }
}
