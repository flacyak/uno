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
  {
    name: "a box plot first shows its span, and scrolls sideways to East's far numbers, apart, its labels standing still",
    script: `
      const rect = (at) => at.getBoundingClientRect();
      const win = document.querySelector(".chart");
      const along = win.querySelector(".chart-along");
      if (along.scrollWidth <= along.clientWidth) return "the box plot reaches nothing past its span";
      const label = rect(win.querySelector(".chart-bar-label"));
      along.scrollLeft = along.scrollWidth;
      await frame();
      const moved = rect(win.querySelector(".chart-bar-label"));
      if (Math.abs(moved.left - label.left) > ${PX_SLACK}) return "the labels moved from " + label.left + " to " + moved.left;
      const east = [...win.querySelectorAll(".chart-bar-row")].find((row) => row.textContent === "East");
      const rings = [...east.querySelectorAll(".chart-past")].map(rect);
      const sight = rect(along);
      if (rings.some((at) => at.right > sight.right + ${PX_SLACK})) return "a ring stands past the scroller's end";
      return rings[1].left - rings[0].right > 0 ? "" : "East's rings stand together";
    `,
  },
  {
    name: "the pointer on a region's row says its median, middle half, whiskers, rows past them and mean, and its row wears the cursor",
    click: { selector: ".chart:first-child .chart-bar-row:nth-child(2) .chart-bar-label" },
    shot: "chart-box-tip",
    script: `
      const win = document.querySelector(".chart");
      const row = win.querySelectorAll(".chart-bar-row")[1];
      if (!(await until(() => row.classList.contains("cursor")))) return "West's row wears no cursor";
      // The box stands over the rows' scroller, which stands over the window's edge.
      const z = (at) => Number(getComputedStyle(at).zIndex) || 0;
      if (z(win.querySelector(".chart-tip")) <= z(win.querySelector(".chart-along"))) return "the box stands under the rows";
      const said = win.querySelector(".chart-tip-words").textContent;
      return /median of West .* middle half .* whiskers .* past them .* mean$/.test(said) ? "" : "the box says " + said;
    `,
  },
];
