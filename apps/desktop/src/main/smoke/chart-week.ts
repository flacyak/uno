/**
 * @fileoverview Checks of week heatmaps in real layout: a cell per hour of the
 * week in each window, Monday 13:00's twenty orders in the accent's darkest
 * step, a Sunday night of none in the rule, Sunday evenings' returns in the
 * pole's third step, every cell inside its window and 2 px from the next;
 * and the days named beside their rows from Sunday, the hours under their
 * columns, apart.
 *
 * They open the workspace smoke.js wrote of four weeks of orders.
 */

import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two week heatmaps. */
const WEEKLY = process.env["UNO_SMOKE_WEEKLY"] ?? "";

/** The hours of a week, and the places of Sunday 03:00 and 20:00 and Monday 13:00 among them. */
const WEEK_HOURS = 168;
const SUNDAY_NIGHT = 3;
const SUNDAY_EVENING = 20;
const MONDAY_PEAK = 24 + 13;

/** The dataviz skill's gap between fills, in px, and a px's rounding. */
const GAP = 2;
const PX_SLACK = 0.5;

export const CHART_WEEK: Check[] = [
  {
    name: "a week heatmap draws a cell per hour of the week, each in its class's step of the ramp, an empty hour in the rule, and below zero in the pole's",
    send: ["menu:open-path", WEEKLY],
    shot: "chart-week",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelectorAll(".chart-week-cell").length === ${WEEK_HOURS});
      if (!(await arrives(drawn))) return "the windows draw no week heatmaps";
      const painted = (token) => {
        const probe = document.createElement("div");
        probe.style.background = "var(" + token + ")";
        document.body.append(probe);
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
      };
      const [rows, sums] = windows().map((win) => [...win.querySelectorAll(".chart-week-cell")]);
      const wears = (cell, token) => getComputedStyle(cell).backgroundColor === painted(token);
      if (!wears(rows[${MONDAY_PEAK}], "--seq-4")) return "Monday 13:00 does not wear the ramp's darkest step";
      if (!wears(rows[${SUNDAY_NIGHT}], "--rule")) return "an hour of no orders does not wear the rule";
      if (!wears(sums[${SUNDAY_EVENING}], "--div-3")) return "Sunday evening's returns do not wear the pole's third step";
      if (!wears(sums[${MONDAY_PEAK}], "--seq-4")) return "Monday 13:00's revenue does not wear the ramp's darkest step";
      for (const [w, cells] of [rows, sums].entries()) {
        const win = windows()[w].getBoundingClientRect();
        const rect = (i) => cells[i].getBoundingClientRect();
        if (cells.some((c, i) => rect(i).left < win.left || rect(i).right > win.right || rect(i).bottom > win.bottom)) return "a cell stands past its window";
        if (Math.abs(rect(1).left - rect(0).right - ${GAP}) > ${PX_SLACK}) return "the cells of an hour stand " + (rect(1).left - rect(0).right) + " px apart";
        if (Math.abs(rect(24).top - rect(0).bottom - ${GAP}) > ${PX_SLACK}) return "the cells of a day stand " + (rect(24).top - rect(0).bottom) + " px apart";
      }
      return "";
    `,
  },
  {
    name: "a week heatmap names its days from Sunday each centred on its row, and its hours under their columns, none over another or past the window",
    script: `
      const rect = (at) => at.getBoundingClientRect();
      const middle = (r) => r.top + r.height / 2;
      for (const win of document.querySelectorAll(".chart")) {
        const days = [...win.querySelectorAll(".chart-week-days .chart-tick")];
        const cells = [...win.querySelectorAll(".chart-week-cell")];
        if (days.map((d) => d.textContent).join() !== "Sun,Mon,Tue,Wed,Thu,Fri,Sat") return "the days read " + days.map((d) => d.textContent).join();
        if (days.some((d, i) => Math.abs(middle(rect(d)) - middle(rect(cells[i * 24]))) > ${PX_SLACK} + 0.5)) return "a day's name stands off its row";
        const hours = [...win.querySelectorAll(".chart-week-hours .chart-tick")].map(rect);
        if (hours.length < 4) return "the window names " + hours.length + " hours";
        if (hours.some((h, i) => i > 0 && h.left < hours[i - 1].right)) return "two hours' labels overlap";
        const box = rect(win);
        if (hours.some((h) => h.left < box.left || h.right > box.right || h.bottom > box.bottom)) return "an hour's label stands past its window";
        if (hours.some((h) => h.top < rect(cells.at(-1)).bottom)) return "an hour's label stands over the cells";
      }
      return "";
    `,
  },
];
