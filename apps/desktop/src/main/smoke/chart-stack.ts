/**
 * @fileoverview Checks of stacked bar charts in real layout: each value's bar
 * runs in a segment per series from zero, in slot order and the slots' chart
 * colours, then Other in the caption's ink, each a gap of the window's ground
 * from the one before, as thick as a bar and ending where the next begins,
 * with the value's total past the last.
 *
 * They open the workspace smoke.js wrote of a small export of four regions'
 * sales in eight channels: rows per region by channel in a new window, and
 * the sum of revenue the same way in one of the least width.
 */

import { TIP_GAP } from "@renderer/chart/bars";
import { BAR_THICK } from "@renderer/chart/rows";
import { SEGMENT_GAP } from "@renderer/chart/stack";
import { SERIES_AT_MOST } from "@tally";
import { RECT_SLACK } from "./charts.ts";
import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two stacked charts. */
const STACKED = process.env["UNO_SMOKE_STACKED"] ?? "";

/** Its regions, the largest first, and its channels, of which two are Other. */
const STACKED_REGIONS = ["West", "East", "South", "North"];
const STACKED_SEGMENTS = SERIES_AT_MOST + 1;

export const CHART_STACK: Check[] = [
  {
    name: "a stacked chart draws each value's bar as a segment per series in slot order, then Other, each in its colour, a gap from the one before, as thick as a bar, with its total at the tip",
    send: ["menu:open-path", STACKED],
    shot: "chart-stack",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-segment") !== null);
      if (!(await arrives(drawn))) return "the windows draw no segments";
      const rect = (at) => at.getBoundingClientRect();
      const style = (at) => getComputedStyle(at);
      const computed = (colour) => {
        const probe = document.createElement("div");
        probe.style.color = colour;
        document.body.append(probe);
        const worn = style(probe).color;
        probe.remove();
        return worn;
      };
      const keys = [...Array(${SERIES_AT_MOST}).keys()].map((i) => computed("var(--chart-" + (i + 1) + ")"));
      keys.push(computed("var(--ink-3)"));
      for (const win of windows()) {
        const labels = [...win.querySelectorAll(".chart-bar-label")].map((label) => label.textContent);
        if (labels.join() !== "${STACKED_REGIONS.join()}") return "a window draws " + labels.join();
        for (const track of win.querySelectorAll(".chart-bar-track")) {
          const segments = [...track.querySelectorAll(".chart-segment")];
          if (segments.length !== ${STACKED_SEGMENTS}) return "a bar draws " + segments.length + " segments";
          const worn = segments.map((segment) => style(segment).backgroundColor);
          if (worn.join() !== keys.join()) return "a bar's segments wear " + worn.join(" | ");
          const bar = rect(track);
          for (const [i, segment] of segments.entries()) {
            const at = rect(segment);
            if (Math.abs(at.height - ${BAR_THICK}) > ${RECT_SLACK} || Math.abs(at.top - bar.top) > ${RECT_SLACK}) return "a segment stands " + at.top + " to " + at.bottom + " in a row " + bar.top + " to " + bar.bottom;
            if (i === 0) continue;
            const before = rect(segments[i - 1]);
            if (Math.abs(at.left - before.right) > ${RECT_SLACK}) return "segment " + (i + 1) + " starts at " + at.left + ", the one before ends at " + before.right;
            const gap = style(segment).borderLeftWidth;
            if (gap !== "${SEGMENT_GAP}px") return "segment " + (i + 1) + " stands " + gap + " from the one before";
          }
          const tip = track.querySelector(".chart-bar-tip");
          if (tip !== null && Math.abs(rect(tip).left - rect(segments.at(-1)).right - ${TIP_GAP}) > ${RECT_SLACK}) return "a total stands at " + rect(tip).left + " past a bar ending at " + rect(segments.at(-1)).right;
        }
      }
      return "";
    `,
  },
];
