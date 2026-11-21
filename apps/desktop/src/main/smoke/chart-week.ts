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

import type { Check, Input } from "./check.ts";

/** The workspace smoke.js wrote of two week heatmaps. */
const WEEKLY = process.env["UNO_SMOKE_WEEKLY"] ?? "";

/** The workspace smoke.js wrote of a week heatmap of plain dates. */
const DAILY = process.env["UNO_SMOKE_DAILY"] ?? "";

/** The hours of a week, and the places of Sunday 03:00 and 20:00 and Monday 13:00 among them. */
const WEEK_HOURS = 168;
const SUNDAY_NIGHT = 3;
const SUNDAY_EVENING = 20;
const MONDAY_PEAK = 24 + 13;

/** A real press of `key`. */
const press = (key: string): readonly Input[] => [
  { type: "keyDown", keyCode: key },
  { type: "keyUp", keyCode: key },
];

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
    name: "a week heatmap names its days from Sunday each centred on its row, its hours under their columns, and its legend's breaks over them, none over another or past the cells",
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
        const breaks = [...win.querySelectorAll(".chart-scale .chart-tick")].map(rect);
        const keys = [...win.querySelectorAll(".chart-swatch")].map(rect);
        if (breaks.length < 2 || breaks.some((b, i) => i > 0 && b.left < breaks[i - 1].right)) return "the legend's breaks overlap";
        if ([...breaks, ...keys].some((b) => b.left < rect(cells[0]).left || b.right > rect(cells.at(-1)).right)) return "the legend stands past the cells";
        if (keys.some((k) => k.bottom > rect(cells[0]).top)) return "the legend stands over the cells";
      }
      return "";
    `,
  },
  {
    name: "a click on Monday 13:00 says its hour and its twenty rows, and its cell wears the cursor",
    click: { selector: `.chart:first-child .chart-week-cell:nth-child(${MONDAY_PEAK + 1})` },
    shot: "chart-week-tip",
    script: `
      const win = document.querySelector(".chart");
      const cell = win.querySelectorAll(".chart-week-cell")[${MONDAY_PEAK}];
      if (!(await until(() => cell.classList.contains("cursor")))) return "Monday 13:00 wears no cursor";
      if (getComputedStyle(cell).outlineStyle !== "solid") return "the cursor's cell has no ring";
      const said = win.querySelector(".chart-tip-words").textContent.replace(/\\s/gu, " ");
      return /^20 Monday, 1:00 PM to 2:00 PM$/.test(said) ? "" : "the box says " + said;
    `,
  },
  {
    name: "Down, End and Up step the cursor to Tuesday 13:00, Tuesday 23:00 and Monday 23:00",
    input: { events: [...press("Down"), ...press("End"), ...press("Up")], through: true },
    script: `
      const win = document.querySelector(".chart");
      const cells = [...win.querySelectorAll(".chart-week-cell")];
      if (!(await until(() => cells[24 + 23].classList.contains("cursor")))) return "the cursor is on cell " + cells.findIndex((c) => c.classList.contains("cursor"));
      const said = win.querySelector(".chart-tip-words").textContent.replace(/\\s/gu, " ");
      return /^0 Monday, 11:00 PM to 12:00 AM$/.test(said) ? "" : "the box says " + said;
    `,
  },
  {
    name: "a week heatmap's head says what it measures per hour of the week, and its table lists every hour from Sunday 00:00, Monday 13:00's twenty rows among them",
    click: { selector: ".chart:first-child .chart-table-toggle" },
    shot: "chart-week-table",
    script: `
      const win = document.querySelector(".chart");
      const title = win.querySelector(".chart-title").textContent;
      if (title !== "rows per hour of the week of ordered") return "the head says " + title;
      if (!(await until(() => win.querySelector(".chart-table tbody tr") !== null))) return "the window shows no table";
      const lines = [...win.querySelectorAll(".chart-table tr")].map((tr) => [...tr.children].map((cell) => cell.textContent.replace(/\\s/gu, " ")).join(" | "));
      if (lines.length !== 1 + ${WEEK_HOURS}) return "the table has " + lines.length + " lines";
      const want = ["day | hour | rows", "Sunday | 12:00 AM | 0"];
      if (lines.slice(0, 2).join(" / ") !== want.join(" / ")) return "the table starts " + lines.slice(0, 2).join(" / ");
      return lines[1 + ${MONDAY_PEAK}] === "Monday | 1:00 PM | 20" ? "" : "Monday 13:00 reads " + lines[1 + ${MONDAY_PEAK}];
    `,
  },
  {
    name: "a week heatmap of plain dates draws a cell per day from Sunday, each beside its name, with no hours under them, and says it draws days",
    send: ["menu:open-path", DAILY],
    shot: "chart-week-days",
    script: `
      const drawn = () => document.querySelectorAll(".chart .chart-week-cell").length === 7;
      if (!(await arrives(drawn))) return "the window draws no grid of days";
      const win = document.querySelector(".chart");
      const rect = (at) => at.getBoundingClientRect();
      const middle = (r) => r.top + r.height / 2;
      const cells = [...win.querySelectorAll(".chart-week-cell")];
      const days = [...win.querySelectorAll(".chart-week-days .chart-tick")];
      if (days.some((d, i) => Math.abs(middle(rect(d)) - middle(rect(cells[i]))) > ${PX_SLACK} + 0.5)) return "a day's name stands off its cell";
      if (win.querySelector(".chart-week-hours") !== null) return "the grid of days names hours";
      if (!win.textContent.includes("drawn per day")) return "the window does not say it draws days";
      // Weekdays hold 25 orders a day over four weeks, and each weekend day 1 a week.
      const steps = cells.map((c) => c.dataset.step).join();
      return steps === "1,4,4,4,4,4,1" ? "" : "the days' classes are " + steps;
    `,
  },
];
