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
    name: "a horizon chart draws a row per region a bar tall, each three bands of the ramp, and one of one series a single row",
    send: ["menu:open-path", HORIZONS],
    shot: "chart-horizon",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-horizon-bands") !== null);
      if (!(await arrives(drawn))) return "the windows draw no horizon charts";
      const [split, alone] = windows();
      const names = [...split.querySelectorAll(".chart-bar-label")].map((l) => l.textContent).join();
      if (names !== "North,South,East,West") return "the rows read " + names;
      const rows = [...split.querySelectorAll(".chart-horizon-bands")];
      if (rows.some((r) => Math.abs(r.getBoundingClientRect().height - ${ROW}) > 0.5)) return "a row is " + rows.map((r) => r.getBoundingClientRect().height).join() + " tall";
      if (rows.some((r) => r.querySelectorAll("path").length !== ${BANDS} * ${ARMS})) return "a row has not three bands each way";
      const fills = [...rows[0].querySelectorAll("path")].map((p) => p.style.fill).slice(0, ${BANDS}).join();
      if (fills !== "var(--seq-2),var(--seq-3),var(--seq-4)") return "North's bands wear " + fills;
      if (alone.querySelectorAll(".chart-horizon-bands").length !== 1 || alone.querySelector(".chart-bar-label") !== null) return "the chart of one series draws more than one nameless row";
      const box = alone.getBoundingClientRect();
      const band = alone.querySelector(".chart-horizon-bands").getBoundingClientRect();
      return band.left >= box.left && band.right <= box.right ? "" : "the row stands past its window";
    `,
  },
];
