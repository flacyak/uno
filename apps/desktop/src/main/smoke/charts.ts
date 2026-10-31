/**
 * @fileoverview Checks of the chart windows in real layout: the layer over the
 * sheet keeps a window below the header row and clear of both scrollbars and
 * the ×.
 *
 * They open the workspace smoke.js wrote, whose two charts stand at the sheet's
 * right edge, one at the top and one at the foot.
 */

import type { Check } from "./check.ts";

/** The workspace smoke.js wrote. */
const CHARTED = process.env["UNO_SMOKE_CHARTED"] ?? "";

/** Helpers: the boxes of the windows and the layer, and what the checks ask of them. */
const GEOMETRY = `
  const windows = () => [...document.querySelectorAll(".chart")].map((w) => w.getBoundingClientRect());
  const header = () => document.querySelector("thead").getBoundingClientRect();
  const unsaved = () => document.querySelector(".ws.open .dirty") !== null;
`;

export const CHARTS: Check[] = [
  {
    name: "the chart layer waits hidden, its stylesheet unloaded, until a workspace has charts",
    script: `
      const layer = document.querySelector("#charts");
      if (!layer.hidden) return "the layer shows";
      const position = getComputedStyle(layer).position;
      return position === "static" ? "" : "the layer is already " + position;
    `,
  },
  {
    name: "a workspace's charts open below the header row, clear of both scrollbars and the ×",
    send: ["menu:open-path", CHARTED],
    shot: "charts-layer",
    script: `
      ${GEOMETRY}
      if (!(await arrives(() => windows().length === 2))) return "the windows are " + windows().length + " · " + JSON.stringify(text("#status-msg"));
      const scroller = document.querySelector(".grid-scroll");
      if (scroller.scrollWidth <= scroller.clientWidth || scroller.scrollHeight <= scroller.clientHeight) {
        return "both scrollbars should show, so this checks nothing";
      }
      const sheet = scroller.getBoundingClientRect();
      const right = sheet.left + scroller.clientWidth;
      const bottom = sheet.top + scroller.clientHeight;
      const close = document.querySelector("#close").getBoundingClientRect();
      const [top, foot] = windows();
      if (top.top !== header().bottom) return "the top window starts at " + top.top + ", and the header row ends at " + header().bottom;
      if (top.right !== right) return "the top window ends at " + top.right + ", and the scrollbar starts at " + right;
      if (foot.right !== right) return "the foot window ends at " + foot.right + ", and the scrollbar starts at " + right;
      if (foot.bottom !== bottom) return "the foot window ends at " + foot.bottom + ", and the scrollbar starts at " + bottom;
      if (top.top < close.bottom) return "the top window starts at " + top.top + ", beside the × to " + close.bottom;
      return unsaved() ? "opening the workspace marked it unsaved" : "";
    `,
  },
];
