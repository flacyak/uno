/**
 * @fileoverview Checks of dot plots in real layout: a row per carrier, the
 * highest mean first, each an 8 px dot in the accent centred on its row with
 * its mean past it inside the row, on an axis that does not start at zero and
 * is labelled under them, its gridlines unbroken and a hairline to each dot,
 * and Eagle's row, of no number, saying so; and the same in a narrow window.
 *
 * They open the workspace smoke.js wrote of five carriers' delivery days.
 */

import { pressing } from "./chart-moves.ts";
import { RECT_SLACK } from "./charts.ts";
import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two dot plots. */
const DOTTED = process.env["UNO_SMOKE_DOTTED"] ?? "";

/** Its carriers by mean, the highest first, and the one of no number last. */
const BY_MEAN = ["Acme", "Crane", "Bolt", "Dart", "Eagle"];

/** A dot's size, in px: the dataviz skill's least marker. */
const DOT = 8;

/** How far a mark may stand off where it should: a px's rounding. */
const PX_SLACK = 1;

export const CHART_DOTS: Check[] = [
  {
    name: "a dot plot draws a dot per carrier, the highest mean first, an 8 px accent dot centred on its row with its mean past it, on an axis that does not start at zero",
    send: ["menu:open-path", DOTTED],
    shot: "chart-dots",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-dot") !== null);
      if (!(await arrives(drawn))) return "the windows draw no dots";
      const rect = (at) => at.getBoundingClientRect();
      for (const win of windows()) {
        const labels = [...win.querySelectorAll(".chart-bar-label")].map((label) => label.textContent);
        if (labels.join() !== "${BY_MEAN.join()}") return "the rows read " + labels.join();
        const none = win.querySelectorAll(".chart-dots-none");
        if (none.length !== 1 || !none[0].closest(".chart-bar-row").textContent.startsWith("Eagle")) return "Eagle's row draws a dot";
      }
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      for (const track of document.querySelectorAll(".chart-dot-track:has(.chart-dot)")) {
        const [row, dot] = [rect(track), rect(track.querySelector(".chart-dot"))];
        if (Math.abs(dot.width - ${DOT}) > ${RECT_SLACK} || Math.abs(dot.height - ${DOT}) > ${RECT_SLACK}) return "a dot is " + dot.width + " by " + dot.height;
        if (getComputedStyle(track.querySelector(".chart-dot")).backgroundColor !== accent) return "a dot wears another colour";
        if (Math.abs(dot.top + dot.height / 2 - (row.top + row.height / 2)) > ${PX_SLACK}) return "a dot stands off its row";
        const tip = rect(track.querySelector(".chart-dot-tip"));
        if (tip.left < dot.right || tip.right > row.right + ${PX_SLACK}) return "a mean stands from " + tip.left + " to " + tip.right + " by a dot to " + dot.right + " in a row to " + row.right;
      }
      // Dart's 2.9 stands a tenth past the axis's 2.8, clear of the track's start.
      const dart = [...windows()[0].querySelectorAll(".chart-bar-row")].find((row) => row.querySelector(".chart-bar-label")?.textContent === "Dart");
      const [start, dot] = [rect(dart.querySelector(".chart-dot-track")), rect(dart.querySelector(".chart-dot"))];
      return dot.left - start.left > ${DOT} ? "" : "Dart's dot stands at the axis's start, " + (dot.left - start.left) + " px in";
    `,
  },
  {
    name: "a dot plot's axis is labelled under its rows from 2.8, each label centred on a gridline that runs unbroken through every row, and a hairline runs to each dot",
    script: `
      const rect = (at) => at.getBoundingClientRect();
      const win = document.querySelector(".chart");
      const ticks = [...win.querySelectorAll(".chart-dots-axis .chart-tick")];
      if (ticks[0]?.textContent !== "2.8") return "the axis starts at " + ticks[0]?.textContent;
      const rows = [...win.querySelectorAll(".chart-dot-track")];
      for (const [i, tick] of ticks.entries()) {
        const lines = rows.map((row) => rect(row.querySelectorAll(".chart-dot-line")[i]));
        const middle = rect(tick).left + rect(tick).width / 2;
        if (lines.some((line) => Math.abs(line.left + line.width / 2 - middle) > ${PX_SLACK})) return "the label " + tick.textContent + " centres at " + middle + ", its gridline at " + lines[0].left;
        if (lines.some((line, r) => r > 0 && line.top - lines[r - 1].bottom > ${RECT_SLACK})) return "the gridline at " + tick.textContent + " breaks between rows";
      }
      for (const track of win.querySelectorAll(".chart-dot-track:has(.chart-dot)")) {
        const [guide, dot] = [rect(track.querySelector(".chart-dot-guide")), rect(track.querySelector(".chart-dot"))];
        if (Math.abs(guide.left - rect(track).left) > ${PX_SLACK} || Math.abs(guide.right - (dot.left + dot.width / 2)) > ${PX_SLACK}) return "a hairline runs from " + guide.left + " to " + guide.right;
      }
      return "";
    `,
  },
  {
    name: "the pointer on a carrier's row says its mean, numbers and rows, and its row wears the cursor",
    click: { selector: ".chart:first-child .chart-bar-row:nth-child(2) .chart-bar-label" },
    shot: "chart-dots-tip",
    script: `
      const win = document.querySelector(".chart");
      const rows = win.querySelectorAll(".chart-bar-row");
      if (!(await until(() => rows[1].classList.contains("cursor")))) return "Crane's row wears no cursor";
      const said = win.querySelector(".chart-tip-words").textContent;
      return /^3.25 Crane.*2 numbers.*2 rows$/.test(said) ? "" : "the box says " + said;
    `,
  },
  {
    name: "Down steps the cursor to the next carrier's row",
    input: { events: pressing("Down"), through: true },
    script: `
      const win = document.querySelector(".chart");
      const rows = win.querySelectorAll(".chart-bar-row");
      if (!(await until(() => rows[2].classList.contains("cursor")))) return "Down leaves the cursor off Bolt's row";
      const said = win.querySelector(".chart-tip-words").textContent;
      return /^3.1 Bolt/.test(said) ? "" : "the box says " + said;
    `,
  },
];
