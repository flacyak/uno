/**
 * @fileoverview Checks of heatmaps over periods in real layout: a row per
 * region with orders, largest first, a cell per month, each in its class's
 * step of the ramp, West's months of no order in the rule, East's March of
 * returns in the pole's, every cell inside its window and 2 px from the next.
 *
 * They open the workspace smoke.js wrote of a year of four regions' orders.
 */

import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two heatmaps over periods. */
const HEATED = process.env["UNO_SMOKE_HEATED"] ?? "";

/** The months of the year the fixture spans, and March's place among them. */
const MONTHS = 12;
const MARCH = 2;

/** The dataviz skill's gap between fills, in px, and a px's rounding. */
const GAP = 2;
const PX_SLACK = 0.5;

export const CHART_HEAT: Check[] = [
  {
    name: "a heatmap over periods draws a row per region largest first and a cell per month in its class's step, a month of no row in the rule, and below zero in the pole's",
    send: ["menu:open-path", HEATED],
    shot: "chart-heat",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-heat-cell") !== null);
      if (!(await arrives(drawn))) return "the windows draw no heatmaps";
      const painted = (token) => {
        const probe = document.createElement("div");
        probe.style.background = "var(" + token + ")";
        document.body.append(probe);
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
      };
      const wears = (cell, token) => getComputedStyle(cell).backgroundColor === painted(token);
      const [rows, sums] = windows();
      const names = [...rows.querySelectorAll(".chart-bar-label")].map((l) => l.textContent).join();
      if (names !== "North,South,East,West") return "the rows read " + names;
      const strips = [...rows.querySelectorAll(".chart-heat-cells")].map((s) => [...s.children]);
      if (strips.some((cells) => cells.length !== ${MONTHS})) return "a row has no cell per month";
      if (!wears(strips[0][${MONTHS} - 1], "--seq-4")) return "North's December does not wear the darkest step";
      if (!wears(strips[3][0], "--rule")) return "West's January of no order does not wear the rule";
      const east = [...sums.querySelectorAll(".chart-heat-cells")][2];
      if (!wears(east.children[${MARCH}], "--div-4")) return "East's March of returns does not wear the pole's darkest step";
      for (const win of windows()) {
        const box = win.getBoundingClientRect();
        const cells = [...win.querySelectorAll(".chart-heat-cell")].map((c) => c.getBoundingClientRect());
        if (cells.some((c) => c.left < box.left || c.right > box.right || c.bottom > box.bottom)) return "a cell stands past its window";
        if (Math.abs(cells[1].left - cells[0].right - ${GAP}) > ${PX_SLACK}) return "a row's cells stand " + (cells[1].left - cells[0].right) + " px apart";
      }
      return "";
    `,
  },
];
