/**
 * @fileoverview Checks of parallel coordinates in real layout: an axis per
 * column, a faint accent line per drawn row, each column's name over its axis
 * inside the window, and eight axes at least 40 px apart in a narrow window,
 * which scrolls sideways; a click puts the cursor on a line, and End and
 * Home step it along to its ends, scrolled into sight; the table lists the
 * rows drawn with a line of those it did not draw.
 *
 * They open the workspace smoke.js wrote of a thousand orders' eight numbers.
 */

import { LINES_DRAWN } from "@renderer/chart/parallel";
import type { Check, Input } from "./check.ts";

/** The workspace smoke.js wrote of two parallel coordinates. */
const PARALLELED = process.env["UNO_SMOKE_PARALLELED"] ?? "";

/** The rows of the file. */
const ROWS = 1_000;
/** The axes of the wide window and the narrow one, and the least px between two. */
const WIDE_AXES = 4;
const NARROW_AXES = 8;
const PITCH_LEAST = 40;
/** How far a measure may stand off: half a px of rounding. */
const PX_SLACK = 0.5;
/** The narrow window's scroller, in sight wherever it scrolls. */
const NARROW = ".chart:nth-child(2) .chart-along";

/** A real press of `key`. */
const press = (key: string): readonly Input[] => [
  { type: "keyDown", keyCode: key },
  { type: "keyUp", keyCode: key },
];

export const CHART_PARALLEL: Check[] = [
  {
    name: "parallel coordinates draw an axis per column and a faint accent line per drawn row, titled by their axes, its names inside the window, and eight axes apart in a narrow window that scrolls",
    send: ["menu:open-path", PARALLELED],
    shot: "chart-parallel",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-parallel-line") !== null);
      if (!(await arrives(drawn))) return "the windows draw no lines";
      const [wide, narrow] = windows();
      const axes = (win) => [...win.querySelectorAll(".chart-parallel-axis")].map((axis) => axis.getBoundingClientRect().left);
      if (axes(wide).length !== ${WIDE_AXES} || axes(narrow).length !== ${NARROW_AXES}) return "the windows draw " + axes(wide).length + " and " + axes(narrow).length + " axes";
      const apart = axes(narrow).slice(1).map((x, i) => x - axes(narrow)[i]);
      if (Math.min(...apart) < ${PITCH_LEAST} - ${PX_SLACK}) return "two axes stand " + Math.min(...apart) + " px apart";
      const scroller = narrow.querySelector(".chart-along");
      if (scroller.scrollWidth <= scroller.clientWidth) return "the narrow window does not scroll";
      if (wide.querySelectorAll(".chart-parallel-line").length !== ${LINES_DRAWN}) return "the wide window draws " + wide.querySelectorAll(".chart-parallel-line").length + " lines";
      const line = getComputedStyle(wide.querySelector(".chart-parallel-line"));
      if (Number(line.strokeOpacity) >= 1) return "a line is not faint";
      const title = wide.querySelector(".chart-title").textContent;
      if (title !== "units, revenue, discount, and days") return "the wide window's title reads " + title;
      const box = wide.getBoundingClientRect();
      for (const head of wide.querySelectorAll(".chart-parallel-heads .chart-parallel-label")) {
        const at = head.getBoundingClientRect();
        if (at.left < box.left - ${PX_SLACK} || at.right > box.right + ${PX_SLACK}) return "a name stands past its window";
      }
      return "";
    `,
  },
  {
    name: "the narrow window scrolled to its end holds its last axis's name, clear of the name two axes in, and scrolls no further than its drawing",
    script: `
      const along = document.querySelector(${JSON.stringify(NARROW)});
      along.scrollLeft = along.scrollWidth;
      const box = along.querySelector(".chart-parallel").getBoundingClientRect();
      const heads = [...along.querySelectorAll(".chart-parallel-heads .chart-parallel-label")];
      const [name, before, sight] = [heads.at(-1), heads.at(-3), along].map((at) => at.getBoundingClientRect());
      along.scrollLeft = 0;
      if (name.right > sight.right + ${PX_SLACK}) return heads.at(-1).title + " ends at " + name.right + " past the window's " + sight.right;
      if (name.left < before.right - ${PX_SLACK}) return heads.at(-1).title + " runs into " + heads.at(-3).title;
      return along.scrollWidth <= box.width + ${PX_SLACK} ? "" : "the window scrolls " + along.scrollWidth + " px over a drawing " + box.width + " wide";
    `,
  },
  {
    name: "a click on parallel coordinates puts the cursor on the line nearest it, drawn strong, and the box says its number at the axis nearest it and its row",
    click: { selector: NARROW },
    script: `
      const win = document.querySelector(${JSON.stringify(NARROW)}).closest(".chart");
      if (!(await until(() => win.querySelector(".chart-parallel-line.cursor") !== null))) return "no line wears the cursor";
      const line = getComputedStyle(win.querySelector(".chart-parallel-line.cursor"));
      if (Number(line.strokeOpacity) !== 1 || line.strokeWidth !== "2px") return "the line with the cursor draws " + line.strokeWidth + " at " + line.strokeOpacity;
      const said = win.querySelector(".chart-tip-words").textContent.replace(/\\s/gu, " ");
      return /^-?[\\d,.]+ [a-z]+, row [\\d,]+$/u.test(said) ? "" : "the box says " + said;
    `,
  },
  {
    name: "End steps the cursor along its line to the last axis, scrolled into sight, the box inside the window, and Home back to the start",
    input: { events: press("End"), through: true },
    shot: "chart-parallel-end",
    script: `
      const along = document.querySelector(${JSON.stringify(NARROW)});
      const win = along.closest(".chart");
      const said = () => win.querySelector(".chart-tip-words").textContent;
      if (!(await until(() => / gross_margin, /u.test(said())))) return "the box says " + said();
      const [sight, tip, room] = [along, win.querySelector(".chart-tip"), win].map((at) => at.getBoundingClientRect());
      const last = win.querySelectorAll(".chart-parallel-axis")[${NARROW_AXES} - 1].getBoundingClientRect();
      if (last.left > sight.right + ${PX_SLACK} || last.left < sight.left - ${PX_SLACK}) return "the last axis stands at " + last.left + " out of a scroller from " + sight.left + " to " + sight.right;
      if (tip.left < room.left || tip.right > room.right) return "the box stands from " + tip.left + " to " + tip.right + " in a window from " + room.left + " to " + room.right;
      return "";
    `,
  },
  {
    name: "Home steps the cursor back to the first axis, scrolled to the scroller's start",
    input: { events: press("Home"), through: true },
    script: `
      const along = document.querySelector(${JSON.stringify(NARROW)});
      const said = () => along.closest(".chart").querySelector(".chart-tip-words").textContent;
      if (!(await until(() => / units, /u.test(said())))) return "the box says " + said();
      return along.scrollLeft < ${PX_SLACK} ? "" : "the scroller stands " + along.scrollLeft + " px along";
    `,
  },
  {
    name: "parallel coordinates' table lists the rows drawn by their row, their number at every axis, and a line of the rows not drawn",
    click: { selector: ".chart:first-child .chart-table-toggle" },
    shot: "chart-parallel-table",
    script: `
      const win = document.querySelector(".chart");
      if (!(await until(() => win.querySelector(".chart-table tbody tr") !== null))) return "the window shows no table";
      const lines = [...win.querySelectorAll(".chart-table tr")].map((tr) => [...tr.children].map((c) => c.textContent).join(" | "));
      if (lines[0] !== "row | units | revenue | discount | days") return "the table's head reads " + lines[0];
      if (lines.length !== ${LINES_DRAWN} + 2) return "the table has " + lines.length + " lines";
      if (lines.at(-1) !== (${ROWS} - ${LINES_DRAWN}).toLocaleString("en-US") + " rows not sampled") return "the last line reads " + lines.at(-1);
      const caption = win.querySelector(".chart-caption").textContent;
      return caption.includes("${LINES_DRAWN} of 1,000 rows, a sample") ? "" : "the caption reads " + caption;
    `,
  },
];
