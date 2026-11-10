/**
 * @fileoverview Checks of a chart window over the selected cell, under real
 * keys. An arrow into the cells a window covers fades it and lets the cell take
 * the pointer, and the cell editor opened there takes it too. F6 giving the
 * window the keys, or the selection leaving it, brings it back whole.
 *
 * They follow CHART_KEYS, which leaves the first window on top, and they leave
 * the grid the keys, with the selection where CHARTS put it, for CHART_MOVES.
 */

import { pressing } from "./chart-moves.ts";
import { CLICK_AND_ARROW, GEOMETRY, ROW_BELOW } from "./charts.ts";
import type { Check } from "./check.ts";

/**
 * Helpers: the two windows, the selected cell, whether a window stands aside,
 * and what takes the pointer over the part of a box the first window covers.
 */
const ASIDE = `
  ${GEOMETRY}
  const [upper, lower] = document.querySelectorAll(".chart");
  const selected = () => document.querySelector("td.sel");
  const faded = (box) => {
    const style = getComputedStyle(box);
    return Number(style.opacity) === Number(style.getPropertyValue("--ghost-opacity")) && style.pointerEvents === "none";
  };
  const covered = (at, by = windows()[0]) =>
    document.elementFromPoint((Math.max(at.left, by.left) + Math.min(at.right, by.right)) / 2, (at.top + at.bottom) / 2);
  const opacity = () => "the first window stands at opacity " + getComputedStyle(upper).opacity;
`;

export const CHART_ASIDE: Check[] = [
  {
    // The cell is picked by script, as the fixture's column widths put it.
    name: "the grid has the keys with the selection just left of the first window, which covers the next cell",
    input: { events: pressing("Escape"), through: true },
    script: `
      ${ASIDE}
      if (!(await until(() => document.activeElement === document.querySelector("#content")))) return "the keys are in #" + document.activeElement?.id;
      const at = windows()[0];
      const y = (at.top + at.bottom) / 2;
      const row = [...document.querySelectorAll("tbody tr")].find((tr) => tr.getBoundingClientRect().top <= y && y < tr.getBoundingClientRect().bottom);
      const left = [...row.children].findLast((td) => td.getBoundingClientRect().right <= at.left);
      left.click();
      if (!(await until(() => selected() === left))) return "the selection is not left of the window";
      return upper.contains(covered(left.nextElementSibling.getBoundingClientRect())) ? "" : "the window covers no cell";
    `,
  },
  {
    name: "an arrow under the window fades it, and the cell shows through and takes the pointer",
    input: { events: pressing("Right"), through: true },
    shot: "chart-aside",
    script: `
      ${ASIDE}
      if (!(await until(() => faded(upper)))) return opacity();
      if (faded(lower)) return "the window clear of the cell faded too";
      return covered(selected().getBoundingClientRect()) === selected() ? "" : "the cell takes no pointer";
    `,
  },
  {
    name: "the cell editor opened under the faded window takes the pointer",
    input: { events: [...pressing("E", ["control"]), ...pressing("Return")], through: true },
    script: `
      ${ASIDE}
      const editor = () => document.querySelector(".cell-editor");
      if (!(await until(() => editor() !== null))) return "no cell opened";
      const open = editor();
      const [hit, stays] = [covered(open.getBoundingClientRect()), faded(upper)];
      await press("Escape");
      await press("e", { ctrlKey: true });
      if (!stays) return "the window came back over the open cell";
      return hit === open ? "" : "over the open cell is " + hit?.tagName;
    `,
  },
  {
    name: "F6 gives the faded window the keys, and brings it back whole",
    input: { events: pressing("F6"), through: true },
    script: `
      ${ASIDE}
      if (!(await until(() => document.activeElement === upper))) return "the keys are in " + document.activeElement?.className;
      return (await until(() => !faded(upper))) ? "" : opacity();
    `,
  },
  {
    name: "the click and the arrow CHARTS made take the selection from under the window, which comes back whole and takes the pointer",
    input: { events: [...pressing("Escape"), ...CLICK_AND_ARROW], through: true },
    script: `
      ${ASIDE}
      if (!(await until(() => text("#status-cell").endsWith("row ${ROW_BELOW}")))) return "the selection is at " + text("#status-cell");
      if (!(await until(() => !faded(upper)))) return opacity();
      return upper.contains(covered(windows()[0])) ? "" : "the window takes no pointer";
    `,
  },
];
