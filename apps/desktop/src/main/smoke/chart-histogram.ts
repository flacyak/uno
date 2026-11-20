/**
 * @fileoverview Checks of histograms in real layout: a column per bin in the
 * accent, from the zero gridline, at most a bar thick and a gap from the
 * next, the span of the 1st to 99th percentile filling the plot's width with
 * the bins past it beyond its edges, in a scroller first shown at the span.
 *
 * They open the workspace smoke.js wrote of an export of amounts over two
 * decades, with a few far past them: a histogram of them in a new window,
 * and one in a window of the least width.
 */

import { BAR_GAP, BAR_THICK } from "@renderer/chart/rows";
import { TICK_GAP } from "@renderer/chart/scatter";
import { RECT_SLACK } from "./charts.ts";
import type { Check, Input } from "./check.ts";

/** The workspace smoke.js wrote of two histograms. */
const SPREAD = process.env["UNO_SMOKE_SPREAD"] ?? "";

/** How far a column may stand off its baseline, or the span off its scroller's edge: a px's rounding. */
const PX_SLACK = 1;

/** The new window's bin a pointer clicks: the span's third. */
const THIRD_BIN = ".chart:first-child .chart-period:nth-child(4)";

/** The new window's button that puts its table in the plot's place, and back. */
const TABLE = ".chart:first-child .chart-table-toggle";

/** A real press of `key`. */
const press = (key: string): readonly Input[] => [
  { type: "keyDown", keyCode: key },
  { type: "keyUp", keyCode: key },
];

export const CHART_HISTOGRAM: Check[] = [
  {
    name: "a histogram draws a column per bin in the accent from the zero gridline, a bar thick at most and a gap apart, its span filling the plot's width and the bins past it beyond its edges, scrolled to the span",
    send: ["menu:open-path", SPREAD],
    shot: "chart-histogram",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-column") !== null);
      if (!(await arrives(drawn))) return "the windows draw no columns";
      const rect = (at) => at.getBoundingClientRect();
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      // The plot has the keys, so Tab passes its scroller by.
      const stops = [...document.querySelectorAll(".chart-along")].filter((along) => along.tabIndex >= 0);
      if (stops.length > 0) return "Tab stops at " + stops.length + " scrollers";
      for (const win of windows()) {
        const along = win.querySelector(".chart-along");
        if (along.scrollWidth <= along.clientWidth) return "a histogram's bins fit its scroller, with none past the span";
        const zero = [...win.querySelectorAll(".chart-grid.y")].find((line) => line.getAttribute("y1") === "100%");
        const base = (rect(zero).top + rect(zero).bottom) / 2;
        const columns = [...win.querySelectorAll(".chart-column")];
        const off = columns.map(rect).find((at) => Math.abs(at.bottom - base) > ${PX_SLACK} || at.width > ${BAR_THICK} + ${RECT_SLACK});
        if (off !== undefined) return "a column stands at " + [off.left, off.top, off.right, off.bottom].join(" ") + " over a baseline at " + base;
        const near = columns.map(rect).findIndex((at, i, all) => i > 0 && at.left - all[i - 1].right < ${BAR_GAP} - ${RECT_SLACK});
        if (near !== -1 && !win.querySelector(".chart-histogram").classList.contains("crowded")) return "two columns stand closer than a gap";
        const worn = columns.find((column) => getComputedStyle(column).backgroundColor !== accent);
        if (worn !== undefined) return "a column wears " + getComputedStyle(worn).backgroundColor;
        // The span's first bin starts at the scroller's left edge, and its last ends at its right.
        const box = win.querySelector(".chart-histogram");
        const slots = [...win.querySelectorAll(".chart-period")];
        const spans = slots.length * 100 / parseFloat(win.querySelector(".chart-bins").style.width);
        const at = Math.round(parseFloat(box.style.getPropertyValue("--span-at")) * spans);
        const [first, last] = [rect(slots[at]), rect(slots[at + Math.round(spans) - 1])];
        const room = rect(along);
        if (Math.abs(first.left - room.left) > ${PX_SLACK} || Math.abs(last.right - room.right) > ${PX_SLACK}) return "the span runs from " + first.left + " to " + last.right + " in a scroller from " + room.left + " to " + room.right;
        // The y axis's 0 stands on the zero gridline, over the scroller's bar.
        const foot = rect(win.querySelector(".chart-ticks.y .chart-tick:first-child"));
        if (Math.abs((foot.top + foot.bottom) / 2 - base) > ${PX_SLACK}) return "the y axis's 0 centres at " + (foot.top + foot.bottom) / 2 + " off the baseline at " + base;
      }
      return "";
    `,
  },
  {
    name: "a histogram labels round edges under its bins, a gap apart and under the y axis's 0, each under its edge or kept inside the bins",
    script: `
      const rect = (at) => at.getBoundingClientRect();
      for (const win of document.querySelectorAll(".chart")) {
        const ticks = [...win.querySelectorAll(".chart-ticks.x .chart-tick")];
        if (ticks.length < 2) return "a histogram labels " + ticks.length + " edges";
        const bins = rect(win.querySelector(".chart-bins"));
        const foot = rect(win.querySelector(".chart-ticks.y .chart-tick:first-child"));
        for (const [i, tick] of ticks.entries()) {
          const at = rect(tick);
          const edge = bins.left + parseFloat(tick.style.getPropertyValue("--at")) * bins.width;
          const kept = at.left <= bins.left + ${PX_SLACK} || at.right >= bins.right - ${PX_SLACK};
          if (!kept && Math.abs((at.left + at.right) / 2 - edge) > ${PX_SLACK}) return tick.textContent + " centres at " + (at.left + at.right) / 2 + " off its edge at " + edge;
          if (i > 0 && at.left - rect(ticks[i - 1]).right < ${TICK_GAP} - ${RECT_SLACK}) return tick.textContent + " stands " + (at.left - rect(ticks[i - 1]).right) + " px from the label before it";
          if (at.top - foot.bottom < ${TICK_GAP} - ${RECT_SLACK}) return tick.textContent + " stands " + (at.top - foot.bottom) + " px under the y axis's 0";
        }
      }
      return "";
    `,
  },
  {
    name: "the pointer on a bin names its edges with its rows and their share, and its column darkens over a wash of its slot",
    click: { selector: THIRD_BIN },
    script: `
      const slot = document.querySelector(${JSON.stringify(THIRD_BIN)});
      if (!(await until(() => slot.classList.contains("cursor")))) return "the bin wears no cursor";
      const said = slot.closest(".chart").querySelector(".chart-tip-words").textContent;
      return /^[\\d,]+ [\\d,.]+ to [\\d,.]+ · [\\d.]+% share$/.test(said) ? "" : "the box says " + said;
    `,
  },
  {
    name: "End steps the cursor to the last bin past the span, scrolled into sight, the box by it inside the window",
    input: { events: press("End"), through: true },
    shot: "chart-histogram-end",
    script: `
      const win = document.querySelector(".chart");
      const slots = [...win.querySelectorAll(".chart-period")];
      if (!(await until(() => slots.at(-1).classList.contains("cursor")))) return "the last bin wears no cursor";
      const rect = (at) => at.getBoundingClientRect();
      const [last, sight, tip, room] = [slots.at(-1), win.querySelector(".chart-along"), win.querySelector(".chart-tip"), win].map(rect);
      if (last.right > sight.right + ${PX_SLACK} || last.left < sight.left - ${PX_SLACK}) return "the last bin stands from " + last.left + " to " + last.right + " out of a scroller from " + sight.left + " to " + sight.right;
      if (win.querySelector(".chart-tip").hidden || tip.left < room.left || tip.right > room.right) return "the box stands from " + tip.left + " to " + tip.right + " in a window from " + room.left + " to " + room.right;
      return "";
    `,
  },
  {
    name: "Home steps the cursor to the first bin, scrolled to the scroller's start",
    input: { events: press("Home"), through: true },
    script: `
      const win = document.querySelector(".chart");
      const first = win.querySelector(".chart-period");
      if (!(await until(() => first.classList.contains("cursor")))) return "the first bin wears no cursor";
      const scrolled = win.querySelector(".chart-along").scrollLeft;
      return scrolled < ${PX_SLACK} ? "" : "the scroller stands " + scrolled + " px along";
    `,
  },
  {
    name: "a histogram's table lists every bin with its rows and share, the rows under and over them, and adds up to every row read",
    click: { selector: TABLE },
    shot: "chart-histogram-table",
    script: `
      const win = document.querySelector(".chart");
      if (!(await until(() => win.querySelector(".chart-table tbody tr") !== null))) return "the window shows no table";
      const bins = win.querySelectorAll(".chart-period").length;
      const lines = [...win.querySelectorAll(".chart-table tbody tr")];
      const counted = lines.filter((tr) => tr.children.length === 3);
      if (counted.length < bins) return "the table lists " + counted.length + " lines for " + bins + " bins";
      const rows = counted.reduce((sum, tr) => sum + Number(tr.children[1].textContent.replace(/[^0-9]/g, "")), 0);
      const read = Number(win.querySelector(".chart-said").textContent.replace(/[^0-9]/g, ""));
      return rows === read ? "" : "the table counts " + rows + " of " + read + " rows";
    `,
  },
  {
    name: "the same button puts the histogram back",
    click: { selector: TABLE },
    script: `
      const win = document.querySelector(".chart");
      return (await until(() => win.querySelector(".chart-column") !== null)) ? "" : "the window draws no columns";
    `,
  },
];
