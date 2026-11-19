/**
 * @fileoverview Checks of stacked bar charts in real layout: each value's bar
 * runs in a segment per series from zero, in slot order and the slots' chart
 * colours, then Other in the caption's ink, each a gap of the window's ground
 * from the one before, as thick as a bar and ending where the next begins,
 * with the value's total past the last. A part below zero stacks leftward
 * from the same zero. A legend over the bars keys the series in the same
 * colours and order, clear of the first bar and inside the plot. The pointer
 * on a segment lists its value's series in its box, its own apart, and Down
 * steps to the next value's bar, keeping the series. t puts a table of a
 * column per series, Other and the total in the plot's place, and the
 * summary says what splits the bars.
 *
 * They open the workspace smoke.js wrote of a small export of four regions'
 * sales in eight channels: rows per region by channel in a new window, and
 * the sum of revenue the same way in one of the least width, whose fair paid
 * back what it took, below zero.
 */

import { TIP_GAP } from "@renderer/chart/bars";
import { BAR_THICK } from "@renderer/chart/rows";
import { SEGMENT_GAP } from "@renderer/chart/stack";
import { SERIES_AT_MOST } from "@tally";
import { RECT_SLACK } from "./charts.ts";
import { BARS_INSET } from "@renderer/chart/rows";
import type { Check, Input } from "./check.ts";

/** The workspace smoke.js wrote of two stacked charts. */
const STACKED = process.env["UNO_SMOKE_STACKED"] ?? "";

/** Its regions, the largest first, and its channels, of which two are Other. */
const STACKED_REGIONS = ["West", "East", "South", "North"];
const STACKED_SEGMENTS = SERIES_AT_MOST + 1;

/** The rows window's East bar's second segment, direct, under the pointer. */
const EAST_DIRECT = ".chart .chart-bar-row:nth-child(2) .chart-segment:nth-child(2)";
/** What its box says, line by line: East's rows per channel, then Other and the total. */
const EAST_LINES = [
  "10 web",
  "9 direct",
  "8 partner",
  "7 mail",
  "6 phone",
  "5 shop",
  "7 Other",
  "52 total",
];
/** A real Down. */
const DOWN_KEY: readonly Input[] = [
  { type: "keyDown", keyCode: "Down" },
  { type: "keyUp", keyCode: "Down" },
];

/** The rows window's table's heads, and what its summary says of its split. */
const STACKED_HEADS = [
  "region",
  "web",
  "direct",
  "partner",
  "mail",
  "phone",
  "shop",
  "Other",
  "total",
];
const STACKED_SPLIT = "Split by channel into 7 series.";

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
          const slot = (segment) => keys.indexOf(computed(segment.style.getPropertyValue("--key")));
          const off = segments.find((segment) => style(segment).backgroundColor !== keys[slot(segment)]);
          if (off !== undefined) return "a segment of " + off.style.getPropertyValue("--key") + " wears " + style(off).backgroundColor;
          const slots = segments.map(slot).sort((a, b) => a - b);
          if (slots.join() !== keys.map((_, i) => i).join()) return "a bar's segments wear the slots " + slots.join();
          const bar = rect(track);
          // Above zero each segment starts where the one before ends, and under it ends where the one before starts.
          for (const [side, edge, gap] of [["above", "left", "borderLeftWidth"], ["under", "right", "borderRightWidth"]]) {
            const parts = segments.filter((segment) => segment.classList.contains(side));
            const order = parts.map(slot);
            if (order.join() !== [...order].sort((a, b) => a - b).join()) return "the segments " + side + " zero run in the slots " + order.join();
            for (const [i, segment] of parts.entries()) {
              const at = rect(segment);
              if (Math.abs(at.height - ${BAR_THICK}) > ${RECT_SLACK} || Math.abs(at.top - bar.top) > ${RECT_SLACK}) return "a segment stands " + at.top + " to " + at.bottom + " in a row " + bar.top + " to " + bar.bottom;
              if (i === 0) continue;
              const before = rect(parts[i - 1]);
              const meets = edge === "left" ? at.left - before.right : before.left - at.right;
              if (Math.abs(meets) > ${RECT_SLACK}) return "a segment " + side + " zero stands " + meets + " px from the one before";
              if (style(segment)[gap] !== "${SEGMENT_GAP}px") return "a segment " + side + " zero stands " + style(segment)[gap] + " from the one before";
            }
          }
          const tip = track.querySelector(".chart-bar-tip");
          const last = segments.filter((segment) => segment.classList.contains("above")).at(-1);
          if (tip !== null && Math.abs(rect(tip).left - rect(last).right - ${TIP_GAP}) > ${RECT_SLACK}) return "a total stands at " + rect(tip).left + " past a bar ending at " + rect(last).right;
        }
        // The bars share one zero, where the parts under it end.
        const zeros = [...win.querySelectorAll(".chart-segment.under")].map((segment) => rect(segment).right);
        if (zeros.some((zero) => Math.abs(zero - zeros[0]) > ${RECT_SLACK})) return "the parts under zero end at " + zeros.join();
      }
      const under = document.querySelectorAll(".chart-segment.under").length;
      if (under !== ${STACKED_REGIONS.length}) return "the sums draw " + under + " parts under zero";
      return "";
    `,
  },
  {
    name: "a stacked chart's legend keys its series in slot order, then Other, in the segments' colours, inside the plot and over its first bar",
    shot: "chart-stack-legend",
    script: `
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
      const slots = [...Array(${SERIES_AT_MOST}).keys()].map((i) => computed("var(--chart-" + (i + 1) + ")"));
      slots.push(computed("var(--ink-3)"));
      for (const win of document.querySelectorAll(".chart")) {
        const list = win.querySelector(".chart-key-list");
        if (list === null) return "a window has no legend";
        const keys = [...list.querySelectorAll(".chart-legend-key")].map((key) => style(key).backgroundColor);
        const worn = [...win.querySelectorAll(".chart-segment")].map((segment) => style(segment).backgroundColor);
        const order = keys.map((key) => slots.indexOf(key));
        if (order.some((at, i) => at !== i) || keys.some((key) => !worn.includes(key))) return "the keys wear " + keys.join(" | ");
        const more = list.querySelector(".chart-key-more");
        if (keys.length !== ${STACKED_SEGMENTS} && more === null) return "the legend keys " + keys.length + " and counts no more";
        const plot = rect(win.querySelector(".chart-plot"));
        for (const entry of list.children) {
          const at = rect(entry);
          if (at.left < plot.left + ${BARS_INSET} - ${RECT_SLACK} || at.right > plot.right - ${BARS_INSET} + ${RECT_SLACK}) return entry.textContent + " runs from " + at.left + " to " + at.right + " in a plot from " + plot.left + " to " + plot.right;
        }
        const bar = rect(win.querySelector(".chart-bar-row"));
        if (rect(list).bottom > bar.top + ${RECT_SLACK}) return "the legend runs to " + rect(list).bottom + " over a bar at " + bar.top;
      }
      return "";
    `,
  },
  {
    name: "the pointer on a stack's segment lists its value's series in its box, its own line apart, and the segment darkens over a wash of its row",
    click: { selector: EAST_DIRECT },
    shot: "chart-stack-tip",
    script: `
      const style = (at) => getComputedStyle(at);
      const computed = (colour) => {
        const probe = document.createElement("div");
        probe.style.color = colour;
        document.body.append(probe);
        const worn = style(probe).color;
        probe.remove();
        return worn;
      };
      const win = document.querySelector(".chart");
      const segment = document.querySelector(${JSON.stringify(EAST_DIRECT)});
      if (!(await until(() => segment.classList.contains("cursor")))) return "East's direct wears no cursor";
      const lines = [...win.querySelectorAll(".chart-tip-line")];
      const said = lines.map((line) => line.textContent);
      if (said.join(" | ") !== ${JSON.stringify(EAST_LINES.join(" | "))}) return "the box says " + said.join(" | ");
      const own = lines.findIndex((line) => line.classList.contains("own"));
      if (own !== 1) return "the box's own line is " + own;
      const darker = computed("color-mix(in srgb, var(--chart-2) 80%, var(--ink))");
      if (style(segment).backgroundColor !== darker) return "the segment is " + style(segment).backgroundColor;
      const row = segment.closest(".chart-bar-row");
      return style(row).backgroundColor === computed("var(--accent-b)") ? "" : "the row is " + style(row).backgroundColor;
    `,
  },
  {
    name: "Down steps a stack's cursor to the next value's bar, keeping the series",
    input: { events: DOWN_KEY, through: true },
    script: `
      const south = document.querySelector(".chart .chart-bar-row:nth-child(3) .chart-segment:nth-child(2)");
      if (!(await until(() => south.classList.contains("cursor")))) return "South's direct wears no cursor";
      const said = document.querySelector(".chart .chart-tip-line.own").textContent;
      return said === "8 direct" ? "" : "the box's own line says " + said;
    `,
  },
  {
    name: "t puts a stacked chart's table in its plot's place, a column per series, Other and the total, and the summary says what splits its bars",
    shot: "chart-stack-table",
    script: `
      const win = document.querySelector(".chart");
      const plot = () => win.querySelector(".chart-plot");
      plot().dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
      const heads = () => [...win.querySelectorAll(".chart-table thead th")].map((th) => th.textContent);
      if (!(await until(() => heads().length > 0))) return "t puts no table in place";
      if (heads().join() !== ${JSON.stringify(STACKED_HEADS.join())}) return "the table heads " + heads().join();
      const rows = win.querySelectorAll(".chart-table tbody tr").length;
      if (rows !== ${STACKED_REGIONS.length}) return "the table has " + rows + " rows";
      const told = win.querySelector(".chart-summary").textContent;
      if (!told.includes(${JSON.stringify(STACKED_SPLIT)})) return "the summary says " + told;
      plot().dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
      return (await until(() => win.querySelector(".chart-segment") !== null)) ? "" : "t brings no bars back";
    `,
  },
];
