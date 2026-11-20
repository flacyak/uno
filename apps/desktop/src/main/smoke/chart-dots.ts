/**
 * @fileoverview Checks of dot plots in real layout: a row per carrier, the
 * highest mean first, each an 8 px dot in the accent centred on its row, on
 * an axis that does not start at zero, and Eagle's row,
 * of no number, saying so; and the same in a narrow window.
 *
 * They open the workspace smoke.js wrote of five carriers' delivery days.
 */

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
      }
      // Dart's 2.9 stands a tenth past the axis's 2.8, clear of the track's start.
      const dart = [...windows()[0].querySelectorAll(".chart-bar-row")].find((row) => row.textContent === "Dart");
      const [start, dot] = [rect(dart.querySelector(".chart-dot-track")), rect(dart.querySelector(".chart-dot"))];
      return dot.left - start.left > ${DOT} ? "" : "Dart's dot stands at the axis's start, " + (dot.left - start.left) + " px in";
    `,
  },
];
