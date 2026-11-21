/**
 * @fileoverview Checks of slope charts in real layout: a line per region from
 * its 2024 end to its 2025 end in the accent, 2 px, an 8 px dot at each end,
 * West of no 2025 row one dot and no line, every dot inside its window, and
 * the years named over the ends; and the same in a narrow window.
 *
 * They open the workspace smoke.js wrote of four regions' revenue.
 */

import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two slope charts. */
const SLOPED = process.env["UNO_SMOKE_SLOPED"] ?? "";

/** How far a mark may stand off where it should: a px's rounding. */
const PX_SLACK = 1;

/** A line's width, and a dot's radius, in px: the dataviz skill's. */
const LINE = 2;
const RADIUS = 4;

export const CHART_SLOPE: Check[] = [
  {
    name: "a slope chart draws a line per region between its two years in the accent, a dot at each end, West one dot, the years over the ends, and each end's label on its own side",
    send: ["menu:open-path", SLOPED],
    shot: "chart-slope",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-slope-line") !== null);
      if (!(await arrives(drawn))) return "the windows draw no slopes";
      const rect = (at) => at.getBoundingClientRect();
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      for (const win of windows()) {
        const lines = [...win.querySelectorAll(".chart-slope-line")];
        const dots = [...win.querySelectorAll(".chart-slope-dot")];
        if (lines.length !== 3 || dots.length !== 7) return lines.length + " lines and " + dots.length + " dots";
        for (const line of lines) {
          const style = getComputedStyle(line);
          if (style.stroke !== accent || parseFloat(style.strokeWidth) !== ${LINE}) return "a line is " + style.strokeWidth + " of " + style.stroke;
        }
        if (dots.some((dot) => Number(dot.getAttribute("r")) !== ${RADIUS} || getComputedStyle(dot).fill !== accent)) return "a dot is not an 8 px accent dot";
        if (dots.some((dot) => rect(dot).left < rect(win).left || rect(dot).right > rect(win).right)) return "a dot stands past the window";
        const plot = rect(win.querySelector(".chart-slope-plot"));
        const [from, to] = [...win.querySelectorAll(".chart-slope-state")].map(rect);
        if (from.right > plot.left || to.left < plot.right) return "a year stands over the plot, not over its end";
        // Each end's label centres on its dot, on its own side of the plot.
        for (const label of win.querySelectorAll(".chart-slope-ends > *")) {
          const at = rect(label);
          const middle = at.top + at.height / 2;
          const near = dots.some((dot) => Math.abs(rect(dot).top + rect(dot).height / 2 - middle) <= ${PX_SLACK});
          if (!near || (at.right > plot.left && at.left < plot.right)) return "the label " + label.textContent + " stands off its end";
        }
      }
      return "";
    `,
  },
  {
    name: "North's 140 at South's 150 is left out at the To end, as the larger South's stands there, and no two labels on a side overlap",
    script: `
      const rect = (at) => at.getBoundingClientRect();
      for (const win of document.querySelectorAll(".chart")) {
        const to = [...win.querySelectorAll(".chart-slope-ends.to > *")].map((label) => label.textContent);
        if (to.join() !== "South 150,East 90") return "the To end says " + to.join();
        for (const side of win.querySelectorAll(".chart-slope-ends")) {
          const at = [...side.children].map(rect);
          if (at.some((one, i) => at.some((other, j) => i !== j && one.top < other.bottom && other.top < one.bottom))) return "two labels overlap";
        }
      }
      return "";
    `,
  },
  {
    name: "the pointer on North's line says its change, its 2024 and its 2025, and fades the other lines",
    // The axes are the plot's first two lines, and South's and North's its next.
    hover: ".chart:first-child .chart-slope-plot > line:nth-of-type(4)",
    shot: "chart-slope-tip",
    script: `
      const win = document.querySelector(".chart");
      if (!(await until(() => win.querySelector(".chart-slope-value.cursor") !== null))) return "no line wears the cursor";
      const said = win.querySelector(".chart-tip-words").textContent;
      if (!/^\\+40% North.*100 in 2024.*140 in 2025$/.test(said)) return "the box says " + said;
      const faded = [...win.querySelectorAll(".chart-slope-plot > .chart-slope-line")].every((line) => Number(getComputedStyle(line).opacity) < 1);
      return faded ? "" : "the other lines stand at full strength";
    `,
  },
];
