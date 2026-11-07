/**
 * @fileoverview A chart changed from its own window under a real pointer and
 * real keys. They follow CHART_STATES, whose last window charts a column the
 * second export has not. Carried up clear of the room's foot, a double-click
 * on its head opens the chart form under the head, and Enter applies the first
 * column, which the window draws and which marks the workspace unsaved. F2
 * opens the form again, Escape gives the window the keys back, and Ctrl+Z
 * there undoes nothing and says why.
 */

import { pressing } from "./chart-moves.ts";
import type { Check } from "./check.ts";

/** The last window and its head. */
const LAST = ".chart:last-child";
const LAST_HEAD = `${LAST} .chart-title`;

/** A carry up the room, which leaves the form room to hang under the head. */
const UP = { x: 0, y: -200 };

/** Two presses in a row, which make a double-click. */
const DOUBLE = 2;

/** What the status line says of Ctrl+Z on a chart. */
const UNDO_HINT = "Ctrl+Z undoes edits in the grid · Esc goes back to it";

/** Helpers: the chart form, the last window, and whether it has the keys. */
const FORM = `
  const form = () => document.querySelector(".chart-form");
  const last = () => document.querySelector(${JSON.stringify(LAST)});
  const keyed = () => document.activeElement === last() ? "" : "the keys are in " + document.activeElement?.className;
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
  {
    name: "Enter applies the form, and the window draws the column chosen and marks the workspace unsaved",
    input: { events: pressing("Enter"), through: true },
    script: `
      ${FORM}
      if (!(await until(() => form() === null))) return "the form stayed open";
      if (!(await arrives(() => last().querySelector(".chart-bar-label") !== null))) return "the plot says " + last().querySelector(".chart-plot").textContent;
      return document.querySelector(".ws.open .dirty") === null ? "the workspace is not marked unsaved" : keyed();
    `,
  },
  {
    name: "F2 on the window opens the chart form again",
    input: { events: pressing("F2"), through: true },
    script: `
      ${FORM}
      return (await arrives(() => form() !== null)) ? "" : "no chart form opened";
    `,
  },
  {
    name: "Escape in the form closes it, and the window takes the keys back",
    input: { events: pressing("Escape"), through: true },
    script: `
      ${FORM}
      return (await until(() => form() === null)) ? keyed() : "the form stayed open";
    `,
  },
  {
    name: "Ctrl+Z on the window undoes nothing, and says it undoes edits in the grid",
    input: { events: pressing("Z", ["control"]), through: true },
    script: `
      ${FORM}
      return (await until(() => text("#status-msg") === ${JSON.stringify(UNDO_HINT)})) ? keyed() : "the status line says " + text("#status-msg");
    `,
  },
];
