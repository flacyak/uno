/**
 * @fileoverview Checks of a real wheel over a chart window. The layer stands
 * beside the grid, so no wheel over a window reaches the grid's scroller, and the
 * window hands it on. Ctrl+wheel stays zoom, and Shift+wheel goes along the rows
 * as it does over the grid.
 *
 * They follow CHART_MOVES, which leaves the last window raised over the first.
 */

import type { Check } from "./check.ts";

/** The raised window's plot and head. */
const PLOT = ".chart:last-child .chart-plot";
const HEAD = ".chart:last-child .chart-title";

/** A cell of the grid that no window covers. */
const CELL = "tbody tr:nth-child(3) td:nth-child(2)";

/** One notch of a mouse wheel, in px. */
const NOTCH = 120;

/** Helpers: the sheet, and where it stands. */
const WHEEL = `
  const sheet = document.querySelector(".grid-scroll");
  const reaches = async (to) =>
    (await until(() => sheet.scrollTop === to)) ? "" : "the sheet stands at " + sheet.scrollTop;
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
];
