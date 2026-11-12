/**
 * @fileoverview Checks of the status bar on a narrow page: the file line ends
 * in an ellipsis after its row count, the clock and the mode switch give way,
 * and the mode, the cell and the panel toggle stay whole on the window.
 *
 * They run after panel.ts, over the bucket's ads-q3.csv, whose Conversion Rate
 * is the longest column name in the run.
 */

import { DOUBLE_ZOOM, NARROW_WIDTH } from "./charts.ts";
import type { Check } from "./check.ts";

/** The longest column name in the run. */
const LONG = "Conversion Rate";

/** What the bar's checks measure, beside the PRELUDE's helpers. */
const BAR = `
  const el = (s) => document.querySelector(s);
  const shown = (s) => el(s).getClientRects().length > 0;
  const cut = (s) => el(s).scrollWidth > el(s).clientWidth;
  // The mode, the cell's row and the panel toggle, each whole and on the page.
  const whole = () => {
    const off = ["#status-mode", "#status-cell .row", "#panel-toggle"].filter((s) => {
      const at = el(s).getBoundingClientRect();
      return !shown(s) || cut(s) || at.left < 0 || at.right > innerWidth;
    });
    return off.length === 0 ? "" : JSON.stringify(off) + " are cut or off the " + innerWidth + "px page";
  };
  // The file line's row count, the text before its first " · ", laid out whole
  // inside the line, and the rest given an ellipsis.
  const keepsRowCount = () => {
    const file = el("#status-file");
    const words = document.createRange();
    words.setStart(file.firstChild, 0);
    words.setEnd(file.firstChild, file.textContent.indexOf(" · "));
    return cut("#status-file") && words.getBoundingClientRect().right <= file.getBoundingClientRect().right;
  };
  const showing = (...all) => all.filter(shown);
  // What a page wide enough for everything shows, that is hidden.
  const missing = () => ["#status-file", "#status-clock", "#mode-switch"].filter((s) => !shown(s));
`;

/**
 * A check at a narrow page that still has room for the file line, once the
 * page's width meets `reached`.
 */
function narrowed(name: string, window: Check["window"], shot: string, reached: string): Check {
  return {
    name,
    window,
    shot,
    script: `
      ${BAR}
      if (!(await until(() => ${reached}))) return "the page is " + innerWidth + "px wide";
      await frame();
      if (!keepsRowCount()) return "the file line is " + el("#status-file").clientWidth + "px of " + JSON.stringify(text("#status-file"));
      const left = showing("#status-clock", "#mode-switch");
      if (left.length > 0) return JSON.stringify(left) + " still show";
      return cut("#status-cell .col") ? "the column name is cut" : whole();
    `,
  };
}

export const STATUS: Check[] = [
  {
    name: "in transform with " + LONG + " selected, the bar shows everything at full width",
    shot: "status-full",
    script: `
      ${BAR}
      const col = [...document.querySelectorAll("thead th .colhead")].findIndex((h) => h.firstChild?.textContent === ${JSON.stringify(LONG)});
      document.querySelectorAll("tbody tr")[0].children[GUTTER + col].click();
      await press("e", { ctrlKey: true });
      if (!(await until(() => text("#status-mode") === "TRANSFORM" && text("#status-cell .col") === ${JSON.stringify(LONG)}))) {
        return "the bar shows " + JSON.stringify([text("#status-mode"), text("#status-cell")]);
      }
      return missing().length === 0 ? whole() : JSON.stringify(missing()) + " are hidden";
    `,
  },
  narrowed(
    "at 200% zoom, the file line keeps its row count, the clock and switch give way, and the panel toggle stays on",
    { zoom: DOUBLE_ZOOM },
    "status-zoomed",
    `innerWidth < ${NARROW_WIDTH}`,
  ),
  narrowed(
    "in a narrow window, the file line keeps its row count, the clock and switch give way, and the panel toggle stays on",
    { width: NARROW_WIDTH },
    "status-narrow",
    `innerWidth === ${NARROW_WIDTH}`,
  ),
  {
    name: "at 200% zoom in a narrow window, the file line gives way, and the column name ends in an ellipsis before its row",
    window: { zoom: DOUBLE_ZOOM, width: NARROW_WIDTH },
    shot: "status-zoomed-narrow",
    script: `
      ${BAR}
      if (!(await until(() => innerWidth <= ${NARROW_WIDTH / DOUBLE_ZOOM}))) return "the page is " + innerWidth + "px wide";
      await frame();
      const left = showing("#status-file", "#status-msg", "#status-clock", "#mode-switch");
      if (left.length > 0) return JSON.stringify(left) + " still show";
      return cut("#status-cell .col") ? whole() : "the column name is whole, so nothing was asked of it";
    `,
  },
  {
    name: "back at full width, the bar shows everything again, and Ctrl+E goes back to view",
    window: {},
    script: `
      ${BAR}
      if (!(await until(() => innerWidth > ${NARROW_WIDTH}))) return "the page is " + innerWidth + "px wide";
      await frame();
      if (missing().length > 0) return JSON.stringify(missing()) + " are hidden";
      await press("e", { ctrlKey: true });
      return (await until(() => text("#status-mode") === "VIEW")) ? "" : "the mode is " + text("#status-mode");
    `,
  },
];
