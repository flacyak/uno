/**
 * @fileoverview The layer over the sheet that holds a workspace's chart
 * windows. It stands beside the grid, below its header row and clear of its
 * scrollbars, so no window can cover them and the grid's keys stay the grid's.
 * Each window draws from its chart's place, in the room the layer leaves.
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
  /** The height of the header row. */
  private readonly head: number;

  constructor(
    private readonly root: HTMLElement,
    /** #content, which the layer stands over. */
    private readonly content: HTMLElement,
  ) {
    this.head = readRowHeight(root);
  }

  /** show gives each of `charts` a window, in place of the last workspace's. */
  show(charts: Pick<Charts, "all">): void {
    this.root.replaceChildren();
    this.root.hidden = false;
    this.fit();
    const { width: w, height: h } = this.root.getBoundingClientRect();
    const room = { w, h };
    for (const chart of charts.all) {
      const box = el("div", "chart");
      stand(box, placed(chart.place, room));
      this.root.append(box);
    }
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
}
