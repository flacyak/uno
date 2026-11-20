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
import { RECT_SLACK } from "./charts.ts";
import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two histograms. */
const SPREAD = process.env["UNO_SMOKE_SPREAD"] ?? "";

/** How far a column may stand off its baseline, or the span off its scroller's edge: a px's rounding. */
const PX_SLACK = 1;

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
        const spans = slots.length * 100 / parseFloat(win.querySelector(".chart-periods").style.width);
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
];
