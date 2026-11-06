/**
 * @fileoverview Checks of the box that says what a mark is worth, under a
 * real pointer. The pointer over a bar's row shows the box right of the
 * pointer, inside the window, the row wearing the cursor, or left of it by
 * the window's edge, and the pointer leaving the plot takes it away.
 *
 * CHART_TIP follows CHART_WHEEL, which leaves the charted workspace's last
 * window, bars of the fixture's regions, raised over the first.
 */

import { TIP_EDGE, TIP_OFFSET } from "@renderer/chart/tooltip";
import type { Check } from "./check.ts";

/** The last window's rows, counted from one. */
const row = (nth: number): string => `.chart:last-child .chart-bar-row:nth-child(${nth})`;

/** A cell of the grid that no window covers. */
const CELL = "tbody tr:nth-child(3) td:nth-child(2)";

/** How far a box may stand from where tooltip.ts puts it, as a window stands on half px. */
const NEAR_PX = 0.5;

/** Helpers: the window, its plot, box and rows, which row wears the cursor, and what each says. */
const TIP = `
  const win = document.querySelector(".chart:last-child");
  const plot = win.querySelector(".chart-plot");
  const tip = win.querySelector(".chart-tip");
  const rows = () => [...win.querySelectorAll(".chart-bar-row")];
  const worn = () => rows().findIndex((one) => one.classList.contains("cursor"));
  const says = (one) => one.querySelector(".chart-bar-tip").textContent + " " + one.querySelector(".chart-bar-label").textContent;
  const said = () => tip.querySelector(".chart-tip-words").textContent;
  const edges = (r) => [r.left, r.top, r.right, r.bottom].map(Math.round).join(" ");
  const near = (a, b) => Math.abs(a - b) <= ${NEAR_PX};
  const inside = () => {
    const box = tip.getBoundingClientRect();
    const room = win.getBoundingClientRect();
    const [left, top, right, bottom] = [room.left + ${TIP_EDGE}, room.top + ${TIP_EDGE}, room.right - ${TIP_EDGE}, room.bottom - ${TIP_EDGE}];
    const fits = box.left >= left && box.top >= top && box.right <= right && box.bottom <= bottom;
    return fits ? "" : "the box stands at " + edges(box) + " in a window at " + edges(room);
  };
  const computed = (colour) => {
    const probe = document.createElement("div");
    probe.style.color = colour;
    document.body.append(probe);
    const shown = getComputedStyle(probe).color;
    probe.remove();
    return shown;
  };
`;

export const CHART_TIP: Check[] = [
  {
    name: "the pointer over a bar's row shows what it is worth in a box right of the pointer, inside the window, and the row darkens its bar over a wash",
    hover: row(2),
    shot: "chart-tip",
    script: `
      ${TIP}
      const one = rows()[1];
      if (!(await until(() => one.classList.contains("cursor")))) return "the cursor is on row " + worn();
      if (said() !== says(one)) return "the box says " + JSON.stringify(said()) + ", and the row " + JSON.stringify(says(one));
      const [at, box] = [one.getBoundingClientRect(), tip.getBoundingClientRect()];
      const pointer = { x: Math.round((at.left + at.right) / 2), y: Math.round((at.top + at.bottom) / 2) };
      if (!near(box.left, pointer.x + ${TIP_OFFSET}) || !near((box.top + box.bottom) / 2, pointer.y)) {
        return "the box stands at " + edges(box) + ", and the pointer at " + pointer.x + " " + pointer.y;
      }
      const bar = getComputedStyle(one.querySelector(".chart-bar")).backgroundColor;
      const dark = computed("color-mix(in srgb, var(--accent) 80%, var(--ink))");
      if (bar !== dark) return "the bar is " + bar + ", and the cursor's " + dark;
      const wash = getComputedStyle(one).backgroundColor;
      if (wash !== computed("var(--accent-b)")) return "the row is " + wash;
      const look = getComputedStyle(tip);
      if (look.backgroundColor !== computed("var(--surface)")) return "the box is " + look.backgroundColor;
      if (look.pointerEvents !== "none") return "the box takes the pointer";
      return inside();
    `,
  },
  {
    name: "the pointer over a bar's value by the window's right edge shows the box left of the pointer",
    hover: `${row(1)} .chart-bar-tip`,
    script: `
      ${TIP}
      if (!(await until(() => worn() === 0))) return "the cursor is on row " + worn();
      const { left, right } = rows()[0].querySelector(".chart-bar-tip").getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      return near(box.right, Math.round((left + right) / 2) - ${TIP_OFFSET}) ? inside() : "the box stands at " + edges(box);
    `,
  },
  {
    name: "the pointer leaving the plot takes the box and the cursor away",
    hover: CELL,
    script: `
      ${TIP}
      if (!(await until(() => tip.hidden))) return "the box still says " + JSON.stringify(said());
      return worn() === -1 ? "" : "the cursor stayed on row " + worn();
    `,
  },
];
