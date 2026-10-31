/**
 * @fileoverview The layer over the sheet that holds a workspace's chart
 * windows. It stands beside the grid, so the grid's keys stay the grid's. Each
 * window draws from its chart's place, in the room the layer leaves.
 */

import "./chart.css";

import type { Charts } from "@renderer/charts";
import { el } from "@renderer/shell/util";
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
  constructor(private readonly root: HTMLElement) {}

  /** show gives each of `charts` a window, in place of the last workspace's. */
  show(charts: Pick<Charts, "all">): void {
    this.root.replaceChildren();
    this.root.hidden = false;
    const { width: w, height: h } = this.root.getBoundingClientRect();
    const room = { w, h };
    for (const chart of charts.all) {
      const box = el("div", "chart");
      stand(box, placed(chart.place, room));
      this.root.append(box);
    }
  }
}
