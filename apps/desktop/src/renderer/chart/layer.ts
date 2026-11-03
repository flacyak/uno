/**
 * @fileoverview The layer over the sheet that holds a workspace's chart
 * windows. It stands beside the grid, from its header row's rule to its
 * scrollbars, so no window can cover them and the grid's keys stay the grid's.
 *
 * Each window draws from its chart's place, in the room the layer leaves. A
 * resize changes only what shows, so the layer writes nothing back.
 *
 * It is loaded with the first workspace that has charts.
 */

import "./chart.css";

import type { Charts } from "@renderer/charts";
import { readRowHeight } from "@renderer/grid/view";
import { el, must } from "@renderer/shell/util";
import { placed, tucked, tucks } from "./place.ts";
import type { Rect } from "./place.ts";

/** The thinnest a border draws, in device px. */
const THINNEST_BORDER = 1;

/**
 * borderWidth gives what a 1 px border draws, in CSS px. A browser floors a
 * border to whole device px, so at a zoom it is not the 1 px it says.
 */
function borderWidth(): number {
  return Math.max(Math.floor(devicePixelRatio), THINNEST_BORDER) / devicePixelRatio;
}

/** stand puts a window at `rect`, in the layer's CSS px. */
function stand(box: HTMLElement, rect: Rect): void {
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

export class ChartLayer {
  /** The window of each chart showing, by chart id. */
  private readonly windows = new Map<string, HTMLElement>();
  /** The height of the header row, and of a tucked window. */
  private readonly head: number;
  /** The charts of the open workspace. */
  private charts: Pick<Charts, "all"> = { all: [] };

  constructor(
    private readonly root: HTMLElement,
    /** Every change to the layer's box is a change to this one's. */
    private readonly content: HTMLElement,
  ) {
    this.head = readRowHeight(root);
    new ResizeObserver(() => this.draw()).observe(content);
  }

  /** show takes over from the last workspace's windows with `charts`. */
  show(charts: Pick<Charts, "all">): void {
    this.charts = charts;
    this.windows.clear();
    this.root.replaceChildren();
    this.root.hidden = false;
    this.draw();
  }

  /** relabel redraws the windows for a language change, leaving each one open. */
  relabel(): void {
    this.draw();
  }

  /**
   * draw gives each chart its one window, each at its place in the room, or
   * tucked if the room is too small, and takes away the rest.
   */
  draw(): void {
    const charts = this.charts.all;
    const showing = new Set(charts.map((chart) => chart.id));
    for (const [id, box] of this.windows) {
      if (showing.has(id)) continue;
      box.remove();
      this.windows.delete(id);
    }

    const border = borderWidth();
    this.fit(border);
    const { width: w, height: h } = this.root.getBoundingClientRect();
    const room = { w, h };
    charts.forEach((chart, index) => {
      const rect = tucks(room) ? tucked(index, this.head, room) : placed(chart.place, room);
      stand(this.windowOf(chart.id), rect);
    });
  }

  /**
   * fit sets the layer's box: from the rule under the header row, below any
   * banner, so a window's top border lands on that rule, and, where a browser
   * draws its own wider scrollbars, clear of those.
   */
  private fit(border: number): void {
    const grid = must(this.content.querySelector<HTMLElement>(".grid-scroll"));
    const sheetTop = must(this.root.parentElement).getBoundingClientRect().top;
    const gridTop = this.content.getBoundingClientRect().top - sheetTop;
    this.root.style.top = `${gridTop + this.head - border}px`;
    this.root.style.setProperty("--bar-right", `${grid.offsetWidth - grid.clientWidth}px`);
    this.root.style.setProperty("--bar-bottom", `${grid.offsetHeight - grid.clientHeight}px`);
  }

  /** windowOf returns a chart's window, adding one on top if it has none. */
  private windowOf(id: string): HTMLElement {
    const held = this.windows.get(id);
    if (held !== undefined) return held;
    const box = el("div", "chart");
    this.windows.set(id, box);
    this.root.append(box);
    return box;
  }
}
