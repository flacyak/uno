/**
 * @fileoverview Checks of horizon charts in real layout: a row per region
 * with orders, largest first, each three bands of the ramp folded into a
 * row a bar tall, and a chart of one series one row with no name, inside its
 * window.
 *
 * They open the workspace smoke.js wrote of a year of four regions' orders.
 */

import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two horizon charts. */
const HORIZONS = process.env["UNO_SMOKE_HORIZONS"] ?? "";

/** A bar's thickness, which a horizon row takes, and the bands and arms a row folds. */
const ROW = 24;
const BANDS = 3;
const ARMS = 2;

export const CHART_HORIZON: Check[] = [
  {
    name: "a horizon chart of one series draws a row a bar tall of three bands of the ramp, inside its window",
    send: ["menu:open-path", HORIZONS],
    shot: "chart-horizon",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows()[1].querySelector(".chart-horizon-bands") !== null;
      if (!(await arrives(drawn))) return "the window draws no horizon chart";
      const [, alone] = windows();
      const band = alone.querySelector(".chart-horizon-bands");
      if (Math.abs(band.getBoundingClientRect().height - ${ROW}) > 0.5) return "the row is not a bar tall";
      if (band.querySelectorAll("path").length !== ${BANDS} * ${ARMS}) return "the row has not three bands each way";
      const fills = [...band.querySelectorAll("path")].map((p) => p.style.fill).slice(0, ${BANDS}).join();
      if (fills !== "var(--seq-2),var(--seq-3),var(--seq-4)") return "the bands wear " + fills;
      if (alone.querySelectorAll(".chart-horizon-bands").length !== 1 || alone.querySelector(".chart-bar-label") !== null) return "the chart of one series draws more than one nameless row";
      const [box, at] = [alone.getBoundingClientRect(), band.getBoundingClientRect()];
      return at.left >= box.left && at.right <= box.right ? "" : "the row stands past its window";
    `,
  },
];
