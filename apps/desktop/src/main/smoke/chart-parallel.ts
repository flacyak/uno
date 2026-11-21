/**
 * @fileoverview Checks of parallel coordinates in real layout: an axis per
 * column, and eight axes at least 40 px apart in a narrow window, which
 * scrolls sideways.
 *
 * They open the workspace smoke.js wrote of a thousand orders' eight numbers.
 */

import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two parallel coordinates. */
const PARALLELED = process.env["UNO_SMOKE_PARALLELED"] ?? "";

/** The axes of the wide window and the narrow one, and the least px between two. */
const WIDE_AXES = 4;
const NARROW_AXES = 8;
const PITCH_LEAST = 40;
/** How far a measure may stand off: half a px of rounding. */
const PX_SLACK = 0.5;

export const CHART_PARALLEL: Check[] = [
  {
    name: "parallel coordinates draw an axis per column, its name inside the window, and eight axes apart in a narrow window that scrolls",
    send: ["menu:open-path", PARALLELED],
    shot: "chart-parallel",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-parallel-axis") !== null);
      if (!(await arrives(drawn))) return "the windows draw no axes";
      const [wide, narrow] = windows();
      const axes = (win) => [...win.querySelectorAll(".chart-parallel-axis")].map((axis) => axis.getBoundingClientRect().left);
      if (axes(wide).length !== ${WIDE_AXES} || axes(narrow).length !== ${NARROW_AXES}) return "the windows draw " + axes(wide).length + " and " + axes(narrow).length + " axes";
      const apart = axes(narrow).slice(1).map((x, i) => x - axes(narrow)[i]);
      if (Math.min(...apart) < ${PITCH_LEAST} - ${PX_SLACK}) return "two axes stand " + Math.min(...apart) + " px apart";
      const scroller = narrow.querySelector(".chart-along");
      if (scroller.scrollWidth <= scroller.clientWidth) return "the narrow window does not scroll";
      const box = wide.getBoundingClientRect();
      for (const head of wide.querySelectorAll(".chart-parallel-heads .chart-parallel-label")) {
        const at = head.getBoundingClientRect();
        if (at.left < box.left - ${PX_SLACK} || at.right > box.right + ${PX_SLACK}) return "a name stands past its window";
      }
      return "";
    `,
  },
];
