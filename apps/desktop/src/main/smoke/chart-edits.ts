/**
 * @fileoverview A chart changed and removed from its own window under a real
 * pointer and real keys. They follow CHART_STATES, whose last window charts a
 * column the second export has not. Carried up clear of the room's foot, a
 * double-click on its head opens the chart form under the head, and Enter
 * applies the first column, which the window draws and which marks the
 * workspace unsaved. F2 opens the form again, Escape gives the window the keys
 * back, and Ctrl+Z there undoes nothing and says why. A click on the × arms it
 * and the second removes the chart, as two presses of Delete remove another.
 * A chart inserted with the panel closed then stands in from the room's right
 * edge, its × clear of the window's, and one inserted with it open flush. At
 * 200% zoom, in a room narrower than a new window, and in a 640 px window, in
 * a room too narrow for one to stand in by the corner, one stands at the left
 * edge, clear of the window's ×.
 */

import { DEFAULT_WIDTH, STAND_IN_CORNERS } from "@renderer/chart/place";
import { pressing } from "./chart-moves.ts";
import { CLICK_AND_ARROW, DOUBLE_ZOOM, GEOMETRY, NARROW_WIDTH, STATE_WINDOWS } from "./charts.ts";
import type { Check } from "./check.ts";

/** The last window, its head and its ×. */
const LAST = ".chart:last-child";
const LAST_HEAD = `${LAST} .chart-title`;
const LAST_X = `${LAST} .chart-close`;

/** A carry up the room, which leaves the form room to hang under the head. */
const UP = { x: 0, y: -200 };

/** Two presses in a row, which make a double-click. */
const DOUBLE = 2;

/** What the status line says of Ctrl+Z on a chart. */
const UNDO_HINT = "Ctrl+Z undoes edits in the grid · Esc goes back to it";

/**
 * Helpers: the chart form, the last window, the windows left, and whether
 * `windows` stand with a removal ended. A window goes before the engine
 * answers, and the status line says so after, so the checks that follow
 * start once it has.
 */
const FORM = `
  const form = () => document.querySelector(".chart-form");
  const last = () => document.querySelector(${JSON.stringify(LAST)});
  const count = () => document.querySelectorAll(".chart").length;
  const removed = (windows) => count() === windows && text("#status-msg").startsWith("removed ");
  const keyed = () => document.activeElement === last() ? "" : "the keys are in " + document.activeElement?.className;
`;

/** A helper that inserts a chart over the selected column and gives its window. */
const INSERT = `
  const insert = async () => {
    const before = new Set(document.querySelectorAll(".chart"));
    const added = () => [...document.querySelectorAll(".chart")].find((at) => !before.has(at));
    const content = document.querySelector("#content");
    content.focus();
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "G", ctrlKey: true, shiftKey: true, bubbles: true }));
    if (!(await until(() => form() !== null))) return undefined;
    form().querySelector("select").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return (await until(() => added() !== undefined)) ? added() : undefined;
  };
`;

/**
 * A check in `shape` that closes the panel, so the room reaches under the
 * window's ×, and waits for a room that `fits`, a condition on `room()` and on
 * `reach()`, how far the room reaches under the corner. A chart inserted there
 * over the first column, on the room's left half, would go to the right half,
 * and stands at the room's left edge instead, as wide as the room leaves clear
 * of the corner up to a new window's width, its × clear of the window's.
 */
function clearAtLeft(name: string, shape: Check["window"], fits: string, shot: string): Check {
  return {
    name,
    window: shape,
    shot,
    script: `
      ${GEOMETRY}
      ${FORM}
      ${INSERT}
      // The strip the window's × keeps clear at its top right.
      const corner = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--corner"));
      const reach = () => room().right - (innerWidth - corner());
      if (!document.querySelector("#panel").hidden) document.querySelector("#panel-toggle").click();
      if (!(await until(() => reach() > 0 && (${fits})))) return "the room stands at " + edges(room()) + ", so this checks nothing";
      // The first column, on the room's left half, so the chart is sent to the right.
      const cell = document.querySelector("tbody tr:not(.pending)").children[GUTTER];
      cell.click();
      const column = cell.getBoundingClientRect();
      if (column.left + column.right >= room().left + room().right) return "the first column stands at " + edges(column) + ", on the room's right half";
      const at = await insert();
      if (at === undefined) return "no chart was inserted";
      const box = at.getBoundingClientRect();
      const width = Math.min(${DEFAULT_WIDTH}, Math.floor(room().width - reach()));
      if (box.left !== room().left || box.width !== width) {
        return "the new window stands at " + edges(box) + ", not " + width + " px wide at the left of a room at " + edges(room());
      }
      const x = at.querySelector(".chart-close").getBoundingClientRect();
      const own = document.querySelector("#close").getBoundingClientRect();
      return x.right < own.left ? "" : "the new window's × ends at " + x.right + ", over the window's × from " + own.left;
    `,
  };
}

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
  {
    name: "a click on a chart's × arms it, and says what a second does",
    click: { selector: LAST_X },
    script: `
      ${FORM}
      if (!last().querySelector(".chart-close").classList.contains("armed")) return "the × is not armed";
      return text("#status-msg").startsWith("× or Delete again removes the chart") ? "" : "the status line says " + text("#status-msg");
    `,
  },
  {
    name: "with the pointer off it, an armed × keeps the flag's fill and wears a ring",
    hover: LAST_HEAD,
    shot: "chart-remove-armed",
    script: `
      ${FORM}
      const x = last().querySelector(".chart-close");
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.background = "var(--flag)";
      const flag = getComputedStyle(probe).backgroundColor;
      probe.remove();
      if (!(await until(() => getComputedStyle(x).backgroundColor === flag))) return "the × wears " + getComputedStyle(x).backgroundColor;
      return getComputedStyle(x).boxShadow !== "none" ? "" : "the armed × wears no ring";
    `,
  },
  {
    name: "a second click on the × removes the chart, and the grid takes the keys",
    click: { selector: LAST_X },
    script: `
      ${FORM}
      if (!(await until(() => removed(${STATE_WINDOWS - 1})))) return count() + " windows stand · " + text("#status-msg");
      return document.activeElement?.closest("#content") !== null ? "" : "the keys are in " + document.activeElement?.className;
    `,
  },
  {
    // The selection goes below the windows first, so none steps aside from the pointer.
    name: "a click on a head gives its window the keys",
    input: { events: CLICK_AND_ARROW, through: true },
    click: { selector: LAST_HEAD },
    script: `
      ${FORM}
      return (await until(() => keyed() === "")) ? "" : keyed();
    `,
  },
  {
    name: "Delete on the window arms its removal, and a second removes it",
    input: { events: [...pressing("Delete"), ...pressing("Delete")], through: true },
    script: `
      ${FORM}
      return (await until(() => removed(${STATE_WINDOWS - 2}))) ? "" : count() + " windows stand · " + text("#status-msg");
    `,
  },
  {
    // The panel closes, so the room reaches under the window's ×, and opens
    // again for a second insert and the checks that follow.
    name: "a chart inserted at the far edge keeps its × clear of the window's, and stands flush with the panel open",
    script: `
      ${GEOMETRY}
      ${FORM}
      ${INSERT}
      const own = document.querySelector("#close").getBoundingClientRect();
      const open = room().right;
      document.querySelector("#panel-toggle").click();
      const closed = (await until(() => room().right > open)) ? await insert() : undefined;
      const x = closed?.querySelector(".chart-close").getBoundingClientRect();
      const far = x !== undefined && x.left > (room().left + room().right) / 2;
      await openPanel();
      if (!far) return "no chart was inserted on the right with the panel closed, so this checks nothing";
      if (x.right >= own.left) return "the new window's × ends at " + x.right + ", over the window's × from " + own.left;
      const at = (await insert())?.getBoundingClientRect();
      if (at === undefined) return "no chart was inserted with the panel open";
      return at.right === room().right ? "" : "with the panel open the new window stands at " + edges(at) + " in a room at " + edges(room());
    `,
  },
  clearAtLeft(
    "at 200% zoom a chart inserted in a room narrower than it ends where the window's × keeps clear",
    { zoom: DOUBLE_ZOOM },
    `room().width < ${DEFAULT_WIDTH} + reach()`,
    "chart-zoomed-clear",
  ),
  clearAtLeft(
    "in a 640 px window a chart inserted in a room too narrow to stand in by the corner stands clear at the left",
    { width: NARROW_WIDTH },
    `room().width >= ${DEFAULT_WIDTH} + reach() && room().width <= ${DEFAULT_WIDTH} + ${STAND_IN_CORNERS} * reach()`,
    "chart-narrow-clear",
  ),
  {
    name: "back at full zoom with the panel open, the page is as wide as the run began",
    window: {},
    script: `
      await openPanel();
      return (await until(() => innerWidth > ${NARROW_WIDTH})) ? "" : "the page is " + innerWidth + "px wide";
    `,
  },
];
