/**
 * @fileoverview Checks of heatmaps over periods in real layout: a row per
 * region with orders, largest first, a cell per month, each in its class's
 * step of the ramp, West's months of no order in the rule, East's March of
 * returns in the pole's, every cell inside its window and 2 px from the next,
 * and the legend over the cells, its breaks apart.
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
        const breaks = [...win.querySelectorAll(".chart-scale .chart-tick")].map((b) => b.getBoundingClientRect());
        const keys = [...win.querySelectorAll(".chart-swatch")].map((k) => k.getBoundingClientRect());
        if (breaks.length < 2 || breaks.some((b, i) => i > 0 && b.left < breaks[i - 1].right)) return "the legend's breaks overlap";
        if (breaks.some((b) => b.top < keys[0].bottom || b.bottom > cells[0].top)) return "a break stands over the swatches or the cells";
        if ([...breaks, ...keys].some((b) => b.left < cells[0].left || b.right > box.right)) return "the legend stands past the cells";
      }
      return "";
    `,
  },
  {
    name: "a heatmap names its months under their columns, each centred on its column within the cells, none over another",
    script: `
      const rect = (at) => at.getBoundingClientRect();
      for (const win of document.querySelectorAll(".chart")) {
        const cells = [...win.querySelector(".chart-heat-cells").children].map(rect);
        const ticks = [...win.querySelectorAll(".chart-heat-periods .chart-tick")].map(rect);
        if (ticks.length < 2 || ticks.some((t, i) => i > 0 && t.left < ticks[i - 1].right)) return "the months' labels overlap";
        if (ticks.some((t) => t.left < cells[0].left - ${PX_SLACK} || t.right > cells.at(-1).right + ${PX_SLACK})) return "a month's label stands past the cells";
        const middle = (r) => (r.left + r.right) / 2;
        const mar = ticks.find((t) => Math.abs(middle(t) - middle(cells[${MARCH}])) <= 1);
        if (mar === undefined && ticks.length > 2) return "no label centres on March";
      }
      return "";
    `,
  },
  {
    name: "a click on North's December says its region, its month and its twelve rows, and Down steps to South's",
    click: {
      selector: ".chart:first-child .chart-bar-row:nth-child(2) .chart-heat-cell:last-child",
    },
    shot: "chart-heat-tip",
    script: `
      const win = document.querySelector(".chart");
      const strips = [...win.querySelectorAll(".chart-heat-cells")];
      if (!(await until(() => strips[0].lastElementChild.classList.contains("cursor")))) return "North's December wears no cursor";
      const said = win.querySelector(".chart-tip-words").textContent.replace(/\\s/gu, " ");
      return said === "12 North, December 2024" ? "" : "the box says " + said;
    `,
  },
];
