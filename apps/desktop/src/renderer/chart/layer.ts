/**
 * @fileoverview The layer over the sheet that holds a workspace's chart
 * windows. It stands beside the grid, from its header row's rule to its
 * scrollbars, so no window can cover them and the grid's keys stay the grid's.
 *
 * Each window draws from its chart's place, in the room the layer leaves. A
 * resize of the room changes only what shows. A window reports back through
 * Stage, which stores its place for the next save and raises it, and hands the
 * grid what the window does not take.
 *
 * It is loaded with the first workspace that has charts.
 */

import "./chart.css";

import type { Chart, ChartColumn, ChartPlace } from "@document";
import type { Charts, Heard } from "@renderer/charts";
import { readRowHeight } from "@renderer/grid/view";
import type { ColumnSpan } from "@renderer/grid/view";
import type { MenuPlace } from "@renderer/shell/menu";
import { el, must } from "@renderer/shell/util";
import { fresh, overfull, placed, stackHeight, thin, tucked, tucks } from "./place.ts";
import type { Room } from "./place.ts";
import { ChartWindow } from "./window.ts";
import type { Stage } from "./window.ts";

/** What a window asks of the shell, which the layer hands on. */
export type Asks = Pick<Stage, "leave" | "wheelBy" | "repoint" | "notNumbers" | "edit" | "remove">;

/** What the layer reads of a workspace's charts, and where it stands one. */
type Shown = Pick<Charts, "all" | "sourceLabel" | "move" | "heard">;

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
  private charts: Shown = {
    all: [],
    sourceLabel: () => undefined,
    move: () => undefined,
    heard: () => undefined,
  };
  /** Fills the grid's scroller inside its bars, so the two boxes differ by a bar. */
  private readonly gauge = el("div", "chart-gauge");
  /** The z-index the last window raised took. */
  private raised = 0;

  constructor(
    private readonly root: HTMLElement,
    /** Every change to the layer's box is a change to this one's. */
    private readonly content: HTMLElement,
    private readonly asks: Asks,
  ) {
    this.head = readRowHeight(root);
    must(content.querySelector<HTMLElement>(".grid-scroll")).append(this.gauge);
    new ResizeObserver(() => this.draw()).observe(content);
  }

  /** show takes over from the last workspace's windows with `charts`, if it
   * is not showing them already. */
  show(charts: Shown): void {
    if (charts === this.charts) return;
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

  /** fresh gives a new chart's place, away from `column`, which stands
   * across the window. */
  fresh(column: ColumnSpan): ChartPlace {
    const { left } = this.root.getBoundingClientRect();
    const inRoom = { left: column.left - left, right: column.right - left };
    return fresh(this.charts.all.length, inRoom, this.room());
  }

  /** focus gives chart `id`'s window the keys, which raises it. */
  focus(id: string): void {
    this.windows.get(id)?.box.focus({ preventScroll: true });
  }

  /** leave gives the keys back to the grid. */
  leave(): void {
    this.asks.leave();
  }

  /** wheelBy scrolls the sheet by a wheel turned over a window. */
  wheelBy(dx: number, dy: number, deltaMode: number): void {
    this.asks.wheelBy(dx, dy, deltaMode);
  }

  /** repoint opens the sources panel on `source`. */
  repoint(source: string): void {
    this.asks.repoint(source);
  }

  /** notNumbers shows `source`, and finds the cells of `columns` that were not numbers. */
  notNumbers(source: string, columns: readonly ChartColumn[]): void {
    this.asks.notNumbers(source, columns);
  }

  /** edit opens the chart form on chart `id`, hung at `place`. */
  edit(id: string, place: MenuPlace): void {
    this.asks.edit(id, place);
  }

  /** remove removes chart `id`, titled `title`, on the second ask. */
  remove(id: string, title: string): void {
    this.asks.remove(id, title);
  }

  /** arm shows chart `id`'s × as the one whose next press removes it, and no other. */
  arm(id: string | undefined): void {
    for (const [shown, held] of this.windows) held.arm(shown === id);
  }

  /** heard gives what chart `id` last heard, for its window to draw. */
  heard(id: string): Heard | undefined {
    return this.charts.heard(id);
  }

  /** tallied draws chart `id`'s window again, as the chart heard a tally. */
  tallied(id: string): void {
    this.windows.get(id)?.redraw();
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
