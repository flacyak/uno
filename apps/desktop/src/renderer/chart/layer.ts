/**
 * @fileoverview The layer over the sheet that holds a workspace's chart
 * windows. It stands beside the grid, below its header row and clear of its
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
import { placed } from "./place.ts";
import type { Rect } from "./place.ts";

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
  /** The height of the header row. */
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

  /** draw gives each chart its one window, at its place in the room. */
  draw(): void {
    this.fit();
    const { width: w, height: h } = this.root.getBoundingClientRect();
    const room = { w, h };
    for (const chart of this.charts.all) stand(this.windowOf(chart.id), placed(chart.place, room));
  }

  /**
   * fit sets the layer's box: from under the banner and the header row, and,
   * where a browser draws its own wider scrollbars, clear of those.
   */
  private fit(): void {
    const grid = must(this.content.querySelector<HTMLElement>(".grid-scroll"));
    this.root.style.top = `${this.content.offsetTop + this.head}px`;
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
