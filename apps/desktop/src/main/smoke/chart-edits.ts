/**
 * @fileoverview A chart changed from its own window under a real pointer. They
 * follow CHART_STATES, whose last window charts a column the second export has
 * not. Carried up clear of the room's foot, a double-click on its head opens
 * the chart form under the head.
 */

import type { Check } from "./check.ts";

/** The last window and its head. */
const LAST = ".chart:last-child";
const LAST_HEAD = `${LAST} .chart-title`;

/** A carry up the room, which leaves the form room to hang under the head. */
const UP = { x: 0, y: -200 };

/** Two presses in a row, which make a double-click. */
const DOUBLE = 2;

/** Helpers: the chart form and the last window. */
const FORM = `
  const form = () => document.querySelector(".chart-form");
  const last = () => document.querySelector(${JSON.stringify(LAST)});
`;

export const CHART_EDITS: Check[] = [
  {
    name: "a drag carries the last window up, clear of the room's foot by the carry",
    drag: { selector: LAST_HEAD, by: UP },
    script: `
      ${FORM}
      const clear = () => document.querySelector("#charts").getBoundingClientRect().bottom - last().getBoundingClientRect().bottom;
      return (await until(() => Math.round(clear()) >= ${-UP.y})) ? "" : "the window ends " + clear() + " px above the foot";
    `,
  },
  {
    name: "a double-click on a chart's head opens the chart form on it, its border on the window's and the head's rule",
    click: { selector: LAST_HEAD, count: DOUBLE },
    shot: "chart-edit-form",
    script: `
      ${FORM}
      if (!(await arrives(() => form() !== null))) return "no chart form opened";
      const head = last().querySelector(".chart-head");
      const rule = parseFloat(getComputedStyle(head).borderBottomWidth);
      const under = [last().getBoundingClientRect().left, head.getBoundingClientRect().bottom - rule].map(Math.round);
      const box = form().getBoundingClientRect();
      const at = [box.left, box.top].map(Math.round);
      if (at.join() !== under.join()) return "the form stands at " + at + ", not under the head at " + under;
      const primary = form().querySelector("button.primary").textContent;
      return primary === "Apply" ? "" : "the form's button says " + primary;
    `,
  },
];
