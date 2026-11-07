/**
 * @fileoverview Checks of a real wheel over a chart window, and of t. The
 * layer stands beside the grid, so no wheel over a window reaches the grid's
 * scroller, and the window hands it on. Ctrl+wheel stays zoom, and Shift+wheel
 * goes along the rows as it does over the grid. t puts the table of a chart's
 * tally in the plot's place, the window's own scrollable, which takes the
 * wheel until it reaches its end, and t again brings the plot back.
 *
 * CHART_WHEEL follows CHART_MOVES, which leaves the last window raised over the
 * first. CHART_TABLE follows CHART_SCATTER, whose one window stands over a
 * scatter of the fixture, with points enough for a table past any plot.
 */

import type { Check, Input } from "./check.ts";

/** The last window's plot and head, and the scrollable t puts in that plot. */
const PLOT = ".chart:last-child .chart-plot";
const HEAD = ".chart:last-child .chart-title";
const SCROLLS = `${PLOT} .chart-scrolls`;
const TOGGLE = ".chart:last-child .chart-table-toggle";

/** A cell of the grid that no window covers. */
const CELL = "tbody tr:nth-child(3) td:nth-child(2)";

/** One notch of a mouse wheel, in px. */
const NOTCH = 120;

/** How far in from its right edge a scrollable's bar stands. */
const ON_BAR = 2;

/** A person's press of t, which puts the table in the plot's place, or the plot back. */
const PRESS_T: readonly Input[] = [
  { type: "keyDown", keyCode: "t" },
  { type: "keyUp", keyCode: "t" },
];

/** Helpers: the sheet and the scrollable in a plot, where each stands, and the points a caption counts. */
const WHEEL = `
  const sheet = document.querySelector(".grid-scroll");
  const inner = () => document.querySelector(${JSON.stringify(SCROLLS)});
  const drawn = () => text(".chart-said").split(" · ").at(-1).split(" of ")[0];
  const reaches = async (to) =>
    (await until(() => sheet.scrollTop === to)) ? "" : "the sheet stands at " + sheet.scrollTop;
  const innerReaches = async (to) =>
    (await until(() => inner().scrollTop === to)) ? "" : "the scrollable stands at " + inner().scrollTop;
  const stays = async (to) => {
    for (let i = 0; i < SETTLE_FRAMES; i++) await frame();
    return sheet.scrollTop === to ? "" : "the sheet went to " + sheet.scrollTop;
  };
  const along = async () => {
    if (!(await until(() => sheet.scrollLeft === ${NOTCH}))) return "the sheet went " + sheet.scrollLeft + " along";
    sheet.scrollLeft = 0;
    return stays(0);
  };
`;

/** A check that turns the wheel, then runs `body` over WHEEL's helpers. */
function turned(name: string, wheel: NonNullable<Check["wheel"]>, body: string): Check {
  return { name, wheel, script: `${WHEEL} ${body}` };
}

export const CHART_WHEEL: Check[] = [
  {
    name: "the sheet goes to its top, for the wheel to take it down",
    script: `${WHEEL} sheet.scrollTop = 0; return reaches(0);`,
  },
  turned(
    "the wheel over a chart's plot scrolls the sheet behind it, and leaves the keys in the window and the marks",
    { selector: PLOT, down: NOTCH },
    `
      const box = document.querySelector(".chart:last-child");
      const failed = await reaches(${NOTCH});
      if (failed !== "") return failed;
      if (!box.contains(document.activeElement)) return "the keys are in #" + document.activeElement?.id;
      return document.querySelector(".ws.open .dirty") === null ? "" : "the wheel marked the workspace unsaved";
    `,
  ),
  turned(
    "the wheel over a chart's head scrolls the sheet back",
    { selector: HEAD, down: -NOTCH },
    "return reaches(0);",
  ),
  turned(
    "Ctrl and the wheel over a chart leave the sheet where it stands",
    { selector: PLOT, down: NOTCH, modifiers: ["control"] },
    "return stays(0);",
  ),
  turned(
    "Shift and the wheel over the grid go along its rows",
    { selector: CELL, down: NOTCH, modifiers: ["shift"] },
    "return along();",
  ),
  turned(
    "Shift and the wheel over a chart go along them too",
    { selector: PLOT, down: NOTCH, modifiers: ["shift"] },
    "return along();",
  ),
];

export const CHART_TABLE: Check[] = [
  {
    name: "the scatter's window takes the keys, and the sheet goes to its top",
    script: `
      ${WHEEL}
      const box = document.querySelector(".chart:last-child");
      box.focus();
      if (document.activeElement !== box) return "the keys are in " + document.activeElement?.tagName;
      sheet.scrollTop = 0;
      return reaches(0);
    `,
  },
  {
    name: "t puts a table of every point drawn in the plot's place, the window's scrollable, which fills the plot and whose bar keeps the pointer from the edge's zone",
    input: { events: PRESS_T, through: true },
    shot: "chart-table",
    script: `
      ${WHEEL}
      const plot = document.querySelector(${JSON.stringify(PLOT)});
      if (!(await until(() => inner() !== null))) return "t put nothing in the plot";
      const held = inner();
      const heads = [...held.querySelectorAll("thead th")].map((th) => th.textContent);
      if (heads.join() !== "units,revenue") return "the table's columns are " + heads.join();
      const rows = held.querySelectorAll("tbody tr").length;
      if (counted(rows) !== drawn()) return "the table has " + rows + " rows of " + drawn() + " points";
      if (held.clientHeight !== plot.clientHeight) return "it fills " + held.clientHeight + " of " + plot.clientHeight;
      const { overscrollBehaviorY } = getComputedStyle(held);
      if (overscrollBehaviorY !== "contain") return "its overscroll is " + overscrollBehaviorY;
      const { right, top, bottom } = held.getBoundingClientRect();
      const hit = document.elementFromPoint(right - ${ON_BAR}, (top + bottom) / 2);
      return hit === held ? "" : "its bar is under " + hit.className;
    `,
  },
  {
    name: "the head's table button is pressed in while the table shows, in the settings toggle's look",
    script: `
      const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
      if (toggle.getAttribute("aria-pressed") !== "true") return "the button says " + toggle.getAttribute("aria-pressed");
      const probe = document.createElement("div");
      document.body.append(probe);
      const computed = (colour) => { probe.style.color = colour; return getComputedStyle(probe).color; };
      const style = getComputedStyle(toggle);
      const worn = [style.backgroundColor, style.borderTopColor, style.color];
      const want = [computed("var(--surface)"), computed("var(--rule)"), computed("var(--ink)")];
      probe.remove();
      return worn.join() === want.join() ? "" : "the button wears " + worn.join(" and ");
    `,
  },
  turned(
    "a chart's scrollable takes the wheel, and the sheet stays where it stands",
    { selector: SCROLLS, down: NOTCH },
    `
      const failed = await innerReaches(${NOTCH});
      return failed === "" ? stays(0) : failed;
    `,
  ),
  {
    name: "a chart's scrollable goes to its end, for the wheel to run past it",
    script: `${WHEEL} inner().scrollTop = inner().scrollHeight; return innerReaches(inner().scrollHeight - inner().clientHeight);`,
  },
  turned(
    "the wheel past the end of a chart's scrollable goes on to the sheet",
    { selector: SCROLLS, down: NOTCH },
    `return reaches(${NOTCH});`,
  ),
  turned(
    "the wheel back up is the scrollable's again",
    { selector: SCROLLS, down: -NOTCH },
    `
      const failed = await innerReaches(inner().scrollHeight - inner().clientHeight - ${NOTCH});
      return failed === "" ? stays(${NOTCH}) : failed;
    `,
  ),
  {
    name: "t again brings the points back, as many as the table had rows, and lets the button out",
    input: { events: PRESS_T, through: true },
    script: `
      ${WHEEL}
      const points = () => document.querySelectorAll(".chart-point").length;
      if (!(await until(() => inner() === null && points() > 0))) return "the plot shows " + (inner() === null ? "no points" : "the table");
      if (counted(points()) !== drawn()) return "the plot draws " + points() + " of " + drawn() + " points";
      const pressed = document.querySelector(${JSON.stringify(TOGGLE)}).getAttribute("aria-pressed");
      return pressed === "false" ? "" : "the button says " + pressed;
    `,
  },
];
