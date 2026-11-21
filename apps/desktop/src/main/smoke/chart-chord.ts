/**
 * @fileoverview Checks of chord charts in real layout: a ring of an arc per
 * airport of the six with the most flights and Other, each in its slot's
 * colour and Other in the caption's ink, inside its window, in a window of a
 * new chart's size and one of the least.
 *
 * They open the workspace smoke.js wrote of flights between nine airports.
 */

import { CHORD_NODES_AT_MOST } from "@tally";
import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two chord charts. */
const CHORDED = process.env["UNO_SMOKE_CHORDED"] ?? "";

/** How far a measure may stand off: half a px of rounding. */
const PX_SLACK = 0.5;

export const CHART_CHORD: Check[] = [
  {
    name: "a chord chart draws a ring of an arc per airport of the six busiest and Other, in their slots' colours and Other in the caption's ink, inside its window",
    send: ["menu:open-path", CHORDED],
    shot: "chart-chord",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-chord-arc[d]") !== null);
      if (!(await arrives(drawn))) return "the windows draw no arcs";
      const colour = (value) => {
        const probe = document.createElement("div");
        probe.style.color = value;
        document.body.append(probe);
        const read = getComputedStyle(probe).color;
        probe.remove();
        return read;
      };
      const keys = [...Array(${CHORD_NODES_AT_MOST}).keys()].map((i) => colour("var(--chart-" + (i + 1) + ")"));
      keys.push(colour("var(--ink-3)"));
      for (const win of windows()) {
        const arcs = [...win.querySelectorAll(".chart-chord-arc")];
        if (arcs.length !== keys.length) return "a window draws " + arcs.length + " arcs";
        const worn = arcs.map((arc) => getComputedStyle(arc).fill);
        if (worn.join() !== keys.join()) return "the arcs wear " + worn.join();
        const box = win.querySelector(".chart-plot").getBoundingClientRect();
        for (const arc of arcs) {
          const at = arc.getBoundingClientRect();
          if (at.left < box.left - ${PX_SLACK} || at.right > box.right + ${PX_SLACK} || at.top < box.top - ${PX_SLACK} || at.bottom > box.bottom + ${PX_SLACK}) return "an arc stands past its plot";
        }
      }
      return "";
    `,
  },
];
