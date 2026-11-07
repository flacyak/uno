/**
 * @fileoverview Checks of the box that says what a mark is worth, under a
 * real pointer and real keys. The pointer over a bar's row shows the box
 * right of the pointer, inside the window, the row wearing the cursor, or
 * left of it by the window's edge; the box's words keep the accent over a
 * capital whole; the plot takes the keys; Right and End step the cursor
 * down the rows, the box standing by each bar's value; and the pointer
 * leaving the plot takes it away.
 *
 * CHART_TIP follows CHART_WHEEL, which leaves the charted workspace's last
 * window, bars of the fixture's regions, raised over the first.
 */

import { TIP_EDGE, TIP_OFFSET } from "@renderer/chart/tooltip";
import { pressing } from "./chart-moves.ts";
import { A_KEY } from "./charts.ts";
import type { Check } from "./check.ts";

/** The last window's rows, counted from one. */
const row = (nth: number): string => `.chart:last-child .chart-bar-row:nth-child(${nth})`;

/** A cell of the grid that no window covers. */
const CELL = "tbody tr:nth-child(3) td:nth-child(2)";

/** How far a box may stand from where tooltip.ts puts it, as a window stands on half px. */
const NEAR_PX = 0.5;

/** A capital whose accent stands above the box's line. */
const ACCENTED = "Ñ";

/** Helpers: the window, its plot, box and rows, which row wears the cursor, and what each says. */
const TIP = `
  const win = document.querySelector(".chart:last-child");
  const plot = win.querySelector(".chart-plot");
  const tip = win.querySelector(".chart-tip");
  const rows = () => [...win.querySelectorAll(".chart-bar-row")];
  const worn = () => rows().findIndex((one) => one.classList.contains("cursor"));
  const says = (one) => one.querySelector(".chart-bar-tip").textContent + " " + one.querySelector(".chart-bar-label").textContent;
  const said = () => tip.querySelector(".chart-tip-words").textContent;
  const edges = (r) => [r.left, r.top, r.right, r.bottom].map(Math.round).join(" ");
  const near = (a, b) => Math.abs(a - b) <= ${NEAR_PX};
  const inside = () => {
    const box = tip.getBoundingClientRect();
    const room = win.getBoundingClientRect();
    const [left, top, right, bottom] = [room.left + ${TIP_EDGE}, room.top + ${TIP_EDGE}, room.right - ${TIP_EDGE}, room.bottom - ${TIP_EDGE}];
    const fits = box.left >= left && box.top >= top && box.right <= right && box.bottom <= bottom;
    return fits ? "" : "the box stands at " + edges(box) + " in a window at " + edges(room);
  };
  const computed = (colour) => {
    const probe = document.createElement("div");
    probe.style.color = colour;
    document.body.append(probe);
    const shown = getComputedStyle(probe).color;
    probe.remove();
    return shown;
  };
`;

export const CHART_TIP: Check[] = [
  {
    name: "the pointer over a bar's row shows what it is worth in a box right of the pointer, inside the window, and the row darkens its bar over a wash",
    hover: row(2),
    shot: "chart-tip",
    script: `
      ${TIP}
      const one = rows()[1];
      if (!(await until(() => one.classList.contains("cursor")))) return "the cursor is on row " + worn();
      if (said() !== says(one)) return "the box says " + JSON.stringify(said()) + ", and the row " + JSON.stringify(says(one));
      const [at, box] = [one.getBoundingClientRect(), tip.getBoundingClientRect()];
      const pointer = { x: Math.round((at.left + at.right) / 2), y: Math.round((at.top + at.bottom) / 2) };
      if (!near(box.left, pointer.x + ${TIP_OFFSET}) || !near((box.top + box.bottom) / 2, pointer.y)) {
        return "the box stands at " + edges(box) + ", and the pointer at " + pointer.x + " " + pointer.y;
      }
      const bar = getComputedStyle(one.querySelector(".chart-bar")).backgroundColor;
      const dark = computed("color-mix(in srgb, var(--accent) 80%, var(--ink))");
      if (bar !== dark) return "the bar is " + bar + ", and the cursor's " + dark;
      const wash = getComputedStyle(one).backgroundColor;
      if (wash !== computed("var(--accent-b)")) return "the row is " + wash;
      const look = getComputedStyle(tip);
      if (look.backgroundColor !== computed("var(--surface)")) return "the box is " + look.backgroundColor;
      if (look.pointerEvents !== "none") return "the box takes the pointer";
      return inside();
    `,
  },
  {
    name: "the pointer over a bar's value by the window's right edge shows the box left of the pointer",
    hover: `${row(1)} .chart-bar-tip`,
    script: `
      ${TIP}
      if (!(await until(() => worn() === 0))) return "the cursor is on row " + worn();
      const { left, right } = rows()[0].querySelector(".chart-bar-tip").getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      return near(box.right, Math.round((left + right) / 2) - ${TIP_OFFSET}) ? inside() : "the box stands at " + edges(box);
    `,
  },
  {
    name: "the box's words keep the accent over a capital whole",
    script: `
      ${TIP}
      // The nearest box that clips stands above the accent's ink, which
      // stands its ascent above the line, where an empty inline block sits.
      const probe = tip.cloneNode(true);
      const words = probe.querySelector(".chart-tip-words");
      const line = document.createElement("span");
      line.style.display = "inline-block";
      words.replaceChildren("${ACCENTED}", line);
      tip.after(probe);
      let clip = words;
      while (clip.parentElement && getComputedStyle(clip).overflowY === "visible") clip = clip.parentElement;
      const pen = document.createElement("canvas").getContext("2d");
      pen.font = getComputedStyle(words).font;
      const ink = line.getBoundingClientRect().bottom - pen.measureText("${ACCENTED}").actualBoundingBoxAscent;
      const top = clip.getBoundingClientRect().top;
      probe.remove();
      return ink >= top ? "" : "the accent's ink starts at " + ink + ", above the clip at " + top;
    `,
  },
  {
    name: "the plot takes the keys, and shows it inside its own edge, in the accent, and the keys leaving it take the cursor away",
    input: { events: A_KEY, through: true },
    script: `
      ${TIP}
      // After a key, focus from a script shows as it will when Tab moves it
      // here. The keys leave the plot on the way, and the cursor goes with them.
      const shows = () => {
        plot.blur();
        plot.focus();
        return plot.matches(":focus-visible");
      };
      if (!(await until(shows))) return "the plot does not show its focus, so this checks nothing";
      const { outlineWidth, outlineColor } = getComputedStyle(plot);
      if (outlineWidth !== "1px" || outlineColor !== computed("var(--accent)")) return "the plot's outline is " + outlineWidth + " " + outlineColor;
      win.dataset.stood = edges(win.getBoundingClientRect());
      if (!tip.hidden) return "the box still says " + JSON.stringify(said());
      return worn() === -1 ? "" : "the cursor stayed on row " + worn();
    `,
  },
  {
    name: "Right puts the cursor on the first row, and the box stands right of its value, or left of it over the bar, halfway down, with the window where it was",
    input: { events: pressing("Right"), through: true },
    script: `
      ${TIP}
      if (!(await until(() => worn() === 0))) return "the cursor is on row " + worn();
      const one = rows()[0];
      if (said() !== says(one)) return "the box says " + JSON.stringify(said()) + ", and the row " + JSON.stringify(says(one));
      const value = one.querySelector(".chart-bar-tip").getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      const beside = near(box.left, value.right + ${TIP_OFFSET}) || near(box.right, value.left - ${TIP_OFFSET});
      if (!beside || !near((box.top + box.bottom) / 2, (value.top + value.bottom) / 2)) {
        return "the box stands at " + edges(box) + ", and the value at " + edges(value);
      }
      const stood = edges(win.getBoundingClientRect());
      if (stood !== win.dataset.stood) return "the window moved to " + stood + " from " + win.dataset.stood;
      return inside();
    `,
  },
  {
    name: "End takes the cursor to the last row",
    input: { events: pressing("End"), through: true },
    script: `
      ${TIP}
      if (!(await until(() => worn() === rows().length - 1))) return "the cursor is on row " + worn();
      return said() === says(rows().at(-1)) ? inside() : "the box says " + JSON.stringify(said());
    `,
  },
  {
    name: "the pointer leaving the plot takes the box and the cursor away",
    hover: CELL,
    script: `
      ${TIP}
      if (!(await until(() => tip.hidden))) return "the box still says " + JSON.stringify(said());
      plot.blur();
      return worn() === -1 ? "" : "the cursor stayed on row " + worn();
    `,
  },
];
