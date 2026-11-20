/**
 * @fileoverview Checks of box plots in real layout: a row per region, the
 * highest median first, each a box from hinge to hinge in the accent, its
 * median a line of the window's ground inside it, and its whiskers' caps at
 * or past the box's ends; and one box of every amount in a narrow window.
 *
 * They open the workspace smoke.js wrote of four regions' amounts.
 */

import { BAR_THICK } from "@renderer/chart/rows";
import { TICK_GAP } from "@renderer/chart/scatter";
import { RECT_SLACK } from "./charts.ts";
import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two box plots. */
const BOXED = process.env["UNO_SMOKE_BOXED"] ?? "";

/** Its regions by median, the highest first. */
const BY_MEDIAN = ["South", "West", "North", "East"];

/** How far a mark may stand off where it should: a px's rounding. */
const PX_SLACK = 1;

export const CHART_BOX: Check[] = [
  {
    name: "a box plot draws a box per region, the highest median first, from hinge to hinge in the accent with its median inside and its whiskers' caps past its ends, and one of every amount",
    send: ["menu:open-path", BOXED],
    shot: "chart-box",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-box") !== null);
      if (!(await arrives(drawn))) return "the windows draw no boxes";
      const rect = (at) => at.getBoundingClientRect();
      const labels = [...windows()[0].querySelectorAll(".chart-bar-label")].map((label) => label.textContent);
      if (labels.join() !== "${BY_MEDIAN.join()}") return "the rows read " + labels.join();
      if (windows()[1].querySelectorAll(".chart-box").length !== 1) return "the narrow window draws more than one box";
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      for (const track of document.querySelectorAll(".chart-box-track")) {
        const [whisker, box, median] = [".chart-whisker", ".chart-box", ".chart-median"].map((at) => rect(track.querySelector(at)));
        if (box.height > ${BAR_THICK} + ${RECT_SLACK}) return "a box stands " + box.height + " px tall";
        if (getComputedStyle(track.querySelector(".chart-box")).backgroundColor !== accent) return "a box wears another colour";
        if (median.left < box.left - ${PX_SLACK} || median.right > box.right + ${PX_SLACK}) return "a median stands from " + median.left + " to " + median.right + " past a box from " + box.left + " to " + box.right;
        if (whisker.left > box.left + ${PX_SLACK} || whisker.right < box.right - ${PX_SLACK}) return "whiskers from " + whisker.left + " to " + whisker.right + " fall short of a box from " + box.left + " to " + box.right;
      }
      return "";
    `,
  },
  {
    name: "East's two numbers past its whisker are rings on its row, and the axis is labelled under the rows, a gap apart",
    script: `
      const rect = (at) => at.getBoundingClientRect();
      const win = document.querySelector(".chart");
      const east = [...win.querySelectorAll(".chart-bar-row")].find((row) => row.textContent === "East");
      const rings = [...east.querySelectorAll(".chart-past")].map(rect);
      if (rings.length !== 2) return "East draws " + rings.length + " rings";
      const row = rect(east.querySelector(".chart-box-track"));
      if (rings.some((at) => Math.abs(at.top + at.height / 2 - (row.top + row.height / 2)) > ${PX_SLACK})) return "a ring stands off its row";
      const ticks = [...win.querySelectorAll(".chart-box-axis .chart-tick")].map(rect);
      if (ticks.length < 2) return "the axis labels " + ticks.length + " ticks";
      const near = ticks.findIndex((at, i) => i > 0 && at.left - ticks[i - 1].right < ${TICK_GAP} - ${RECT_SLACK});
      return near === -1 ? "" : "two labels stand " + (ticks[near].left - ticks[near - 1].right) + " px apart";
    `,
  },
];
