/**
 * @fileoverview Checks of a real wheel over a chart window. The layer stands
 * beside the grid, so no wheel over a window reaches the grid's scroller, and the
 * window hands it on. Ctrl+wheel stays zoom, Shift+wheel goes along the rows as
 * it does over the grid, and a scrollable inside a window takes the wheel until
 * it reaches its end.
 *
 * They follow CHART_MOVES, which leaves the last window raised over the first.
 */

import type { Check } from "./check.ts";

/** The raised window's plot and head, and what a check puts in that plot. */
const PLOT = ".chart:last-child .chart-plot";
const HEAD = ".chart:last-child .chart-title";
const SCROLLS = `${PLOT} .chart-scrolls`;

/** A cell of the grid that no window covers. */
const CELL = "tbody tr:nth-child(3) td:nth-child(2)";

/** One notch of a mouse wheel, in px. */
const NOTCH = 120;

/** How tall a scrollable's content is: past any plot, by more than NOTCH. */
const LONG = 2000;

/** How far in from its right edge a scrollable's bar stands. */
const ON_BAR = 2;

/** Helpers: the sheet and what a check puts in a plot, and where each one stands. */
const WHEEL = `
  const sheet = document.querySelector(".grid-scroll");
  const inner = () => document.querySelector(${JSON.stringify(SCROLLS)});
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
    "the wheel over a chart's plot scrolls the sheet behind it, and leaves the keys and the marks",
    { selector: PLOT, down: NOTCH },
    `
      const box = document.querySelector(".chart:last-child");
      const failed = await reaches(${NOTCH});
      if (failed !== "") return failed;
      if (document.activeElement !== box) return "the keys are in #" + document.activeElement?.id;
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
  {
    // No window holds a scrollable of its own yet, so this one takes the place of its bars.
    name: "a chart's scrollable fills its plot, and its bar keeps the pointer from the edge's zone",
    script: `
      ${WHEEL}
      const plot = document.querySelector(${JSON.stringify(PLOT)});
      const held = document.createElement("div");
      held.className = "chart-scrolls";
      const rows = document.createElement("div");
      rows.style.height = "${LONG}px";
      held.append(rows);
      plot.replaceChildren(held);
      await frame();
      if (held.clientHeight !== plot.clientHeight) return "it fills " + held.clientHeight + " of " + plot.clientHeight;
      const { overscrollBehaviorY } = getComputedStyle(held);
      if (overscrollBehaviorY !== "contain") return "its overscroll is " + overscrollBehaviorY;
      const { right, top, bottom } = held.getBoundingClientRect();
      const hit = document.elementFromPoint(right - ${ON_BAR}, (top + bottom) / 2);
      return hit === held ? "" : "its bar is under " + hit.className;
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
    script: `${WHEEL} inner().scrollTop = ${LONG}; return innerReaches(inner().scrollHeight - inner().clientHeight);`,
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
      inner().remove();
      return failed === "" ? stays(${NOTCH}) : failed;
    `,
  ),
];
