/**
 * @fileoverview The layer over the sheet that holds a workspace's chart
 * windows. It stands beside the grid, from its header row's rule to its
 * scrollbars, so no window can cover them and the grid's keys stay the grid's.
 *
 * Each window draws from its chart's place, in the room the layer leaves. A
 * resize of the room changes only what shows. A window reports back through
 * Stage, which stores its place for the next save and raises it.
 *
 * It is loaded with the first workspace that has charts.
 */

import "./chart.css";

import type { Chart, ChartPlace } from "@document";
import type { Charts } from "@renderer/charts";
import { readRowHeight } from "@renderer/grid/view";
import { el, must } from "@renderer/shell/util";
import { overfull, placed, stackHeight, thin, tucked, tucks } from "./place.ts";
import type { Room } from "./place.ts";
import { ChartWindow } from "./window.ts";
import type { Stage } from "./window.ts";

/** What the layer reads of a workspace's charts, and where it stands one. */
type Shown = Pick<Charts, "all" | "sourceLabel" | "move">;

/** The thinnest a border draws, in device px. */
const THINNEST_BORDER = 1;

/**
 * borderWidth gives what a 1 px border draws, in CSS px. A browser floors a
 * border to whole device px, so at a zoom it is not the 1 px it says.
 */
function borderWidth(): number {
  return Math.max(Math.floor(devicePixelRatio), THINNEST_BORDER) / devicePixelRatio;
}

export class ChartLayer implements Stage {
  /** The window of each chart showing, by chart id. */
  private readonly windows = new Map<string, ChartWindow>();
  /** The height of the header row, and of a tucked window's head. */
  private readonly head: number;
  /** The charts of the open workspace. */
  private charts: Shown = { all: [], sourceLabel: () => undefined, move: () => undefined };
  /** Fills the grid's scroller inside its bars, so the two boxes differ by a bar. */
  private readonly gauge = el("div", "chart-gauge");
  /** The z-index the last window raised took. */
  private raised = 0;

  constructor(
    private readonly root: HTMLElement,
    /** Every change to the layer's box is a change to this one's. */
    private readonly content: HTMLElement,
    /** Gives the keys back to the grid. */
    readonly leave: () => void,
  ) {
    this.head = readRowHeight(root);
    must(content.querySelector<HTMLElement>(".grid-scroll")).append(this.gauge);
    new ResizeObserver(() => this.draw()).observe(content);
  }

  /** show takes over from the last workspace's windows with `charts`. */
  show(charts: Shown): void {
    this.charts = charts;
    this.windows.clear();
    this.root.replaceChildren();
    this.root.hidden = false;
    this.draw();
  }

  /** relabel rewrites the windows for a language change, leaving each one open. */
  relabel(): void {
    for (const held of this.windows.values()) held.relabel();
    this.draw();
  }

  /** room gives the layer's box as it measures now. */
  room(): Room {
    const { width: w, height: h } = this.root.getBoundingClientRect();
    return { w, h };
  }

  /** move stores where chart `id`'s window stands, which the next draw shows. */
  move(id: string, place: ChartPlace): void {
    this.charts.move(id, place);
  }

  /**
   * raise stands `box` over every other window, and it stays there once it has
   * given up the keys. It goes by z-index, as moving the node would blur it.
   */
  raise(box: HTMLElement): void {
    box.style.zIndex = `${++this.raised}`;
  }

  /**
   * draw gives each chart its one window, each saying what the chart says now,
   * at its place in the room, or tucked if the room is too small, and takes away
   * the rest.
   */
  draw(): void {
    const charts = this.charts.all;
    const showing = new Set(charts.map((chart) => chart.id));
    for (const [id, held] of this.windows) {
      if (showing.has(id)) continue;
      held.box.remove();
      this.windows.delete(id);
    }

    const border = borderWidth();
    this.fit(border);
    const room = this.room();
    const tucking = tucks(room);
    charts.forEach((chart, index) => {
      const held = this.windowOf(chart);
      held.show(chart, this.charts.sourceLabel(chart.source));
      held.stand(tucking ? tucked(index, this.head, border, room) : placed(chart.place, room));
    });
    const spills = tucking && overfull(charts.length, this.head, border, room);
    const stack = stackHeight(charts.length, this.head, border);
    this.root.style.setProperty("--stack-height", `${stack}px`);
    this.root.classList.toggle("tucked", tucking && charts.length > 0);
    this.root.classList.toggle("overfull", spills);
    this.root.classList.toggle("thin", thin(room));
  }

  /**
   * fit sets the layer's box: from the rule under the header row, below any
   * banner, so a window's top border lands on that rule, and clear of the
   * scrollbars as they stood at the last resize. A bar draws a whole number of
   * device px, which clientWidth would round to a whole CSS px, so the bars come
   * from the two boxes' rects. A sheet with no scrollbars keeps the last
   * measure, so the room holds still from tab to tab.
   */
  private fit(border: number): void {
    const sheetTop = must(this.root.parentElement).getBoundingClientRect().top;
    const gridTop = this.content.getBoundingClientRect().top - sheetTop;
    this.root.style.top = `${gridTop + this.head - border}px`;
    this.root.style.setProperty("--window-border", `${border}px`);
    const grid = must(this.gauge.parentElement).getBoundingClientRect();
    const inside = this.gauge.getBoundingClientRect();
    const right = grid.width - inside.width;
    const bottom = grid.height - inside.height;
    if (right > 0) this.root.style.setProperty("--bar-right", `${right}px`);
    if (bottom > 0) this.root.style.setProperty("--bar-bottom", `${bottom}px`);
  }

  /** windowOf returns a chart's window, adding one over those never raised if it has none. */
  private windowOf(chart: Chart): ChartWindow {
    const held = this.windows.get(chart.id);
    if (held !== undefined) return held;
    const made = new ChartWindow(chart, this);
    this.windows.set(chart.id, made);
    this.root.append(made.box);
    return made;
  }
}
