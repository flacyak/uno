/**
 * @fileoverview Checks of a real wheel over a chart window. The layer stands
 * beside the grid, so no wheel over a window reaches the grid's scroller, and the
 * window hands it on, and Ctrl+wheel stays zoom.
 *
 * They follow CHART_MOVES, which leaves the last window raised over the first.
 */

import type { Check } from "./check.ts";

/** The raised window's plot and head. */
const PLOT = ".chart:last-child .chart-plot";
const HEAD = ".chart:last-child .chart-title";

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
];
