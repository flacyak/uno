/**
 * @fileoverview Checks of horizon charts in real layout: a row per region
 * with orders, largest first, each three bands of the ramp folded into a
 * row a bar tall, and a chart of one series one row with no name, inside its
 * window, and in both the legend over the bands, its breaks apart, and the
 * months' labels under them, each centred on its month; and a click on a
 * month rings it and says it, and its head and table say what it measures.
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

/** How far a box may stand past where it should, in px, and the place of March among the months. */
const PX_SLACK = 0.5;
const MARCH = 2;
const MONTHS = 12;

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
      if (band.left < box.left || band.right > box.right) return "the row stands past its window";
      for (const win of windows()) {
        const first = win.querySelector(".chart-horizon-bands").getBoundingClientRect();
        const breaks = [...win.querySelectorAll(".chart-scale .chart-tick")].map((b) => b.getBoundingClientRect());
        const keys = [...win.querySelectorAll(".chart-swatch")].map((k) => k.getBoundingClientRect());
        if (keys.length !== ${BANDS} * ${ARMS} && keys.length !== ${BANDS}) return "the legend keys " + keys.length + " bands";
        if (breaks.length < 2 || breaks.some((b, i) => i > 0 && b.left < breaks[i - 1].right)) return "the legend's breaks overlap";
        if (breaks.some((b) => b.top < keys[0].bottom || b.bottom > first.top)) return "a break stands over the swatches or the bands";
        if ([...breaks, ...keys].some((b) => b.left < first.left || b.right > first.right)) return "the legend stands past the bands";
      }
      return "";
    `,
  },
  {
    name: "a horizon chart names its months under its rows, each centred on its month within the bands, none over another",
    script: `
      const rect = (at) => at.getBoundingClientRect();
      for (const win of document.querySelectorAll(".chart")) {
        const bands = rect(win.querySelector(".chart-horizon-bands"));
        const ticks = [...win.querySelectorAll(".chart-heat-periods .chart-tick")].map(rect);
        if (ticks.length < 2 || ticks.some((t, i) => i > 0 && t.left < ticks[i - 1].right)) return "the months' labels overlap";
        if (ticks.some((t) => t.left < bands.left - ${PX_SLACK} || t.right > bands.right + ${PX_SLACK})) return "a month's label stands past the bands";
        const middle = (r) => (r.left + r.right) / 2;
        const march = bands.left + ((${MARCH} + 1 / 2) / ${MONTHS}) * bands.width;
        if (ticks.length > 2 && !ticks.some((t) => Math.abs(middle(t) - march) <= 1)) return "no label centres on March";
      }
      return "";
    `,
  },
  {
    name: "a click on North's December rings it and says its region, its month and its twelve rows",
    click: {
      selector: ".chart:first-child .chart-bar-row:nth-child(2) .chart-horizon-period:last-child",
    },
    shot: "chart-horizon-tip",
    script: `
      const win = document.querySelector(".chart");
      const december = win.querySelector(".chart-horizon-period:last-of-type");
      if (!(await until(() => december.classList.contains("cursor")))) return "North's December wears no cursor";
      const said = win.querySelector(".chart-tip-words").textContent.replace(/\\s/gu, " ");
      return said === "12 North, December 2024" ? "" : "the box says " + said;
    `,
  },
  {
    name: "a horizon's head says what it measures per region per month, and its table lists each region's months, North's December's twelve rows among them",
    click: { selector: ".chart:first-child .chart-table-toggle" },
    shot: "chart-horizon-table",
    script: `
      const win = document.querySelector(".chart");
      const title = win.querySelector(".chart-title").textContent;
      if (title !== "rows per region per month of ordered") return "the head says " + title;
      if (!(await until(() => win.querySelector(".chart-table tbody tr") !== null))) return "the window shows no table";
      const lines = [...win.querySelectorAll(".chart-table tr")].map((tr) => [...tr.children].map((c) => c.textContent).join(" | "));
      if (lines[0] !== "region | month | rows") return "the table's head reads " + lines[0];
      return lines.includes("North | Dec 2024 | 12") ? "" : "North's December is not 12 rows: " + lines.slice(1, 4).join(" / ");
    `,
  },
];
