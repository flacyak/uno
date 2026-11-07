/**
 * @fileoverview Checks of F6, Shift+F6 and Ctrl+Shift+F under real keys. F6
 * gives the keys from the grid to each window front to back and back to the
 * grid, Shift+F6 goes the other way, and a tucked head past a short room's foot
 * comes into view with them. Ctrl+Shift+F gives them to the window on top.
 *
 * They follow CHARTS, which leaves the first window raised with the keys, and
 * they leave it so for CHART_MOVES.
 */

import { pressing } from "./chart-moves.ts";
import { GEOMETRY, SHORT_SHEET } from "./charts.ts";
import type { Check, Input } from "./check.ts";

const F6 = pressing("F6");
const SHIFT_F6 = pressing("F6", ["shift"]);
const ESCAPE = pressing("Escape");
const FRONT = pressing("F", ["control", "shift"]);

/** Helpers: the two windows, and which of them or the grid has the keys. */
const KEYS = `
  ${GEOMETRY}
  const [upper, lower] = document.querySelectorAll(".chart");
  const keyed = () => {
    const at = document.activeElement;
    if (at === upper) return "the first";
    if (at === lower) return "the second";
    return at === document.querySelector("#content") ? "the grid" : at?.tagName;
  };
  const has = async (want) => (await until(() => keyed() === want)) ? "" : "the keys are in " + keyed();
`;

/** A check that presses `events` and finds the keys in `want`. */
function lands(name: string, events: readonly Input[], want: string): Check {
  return { name, input: { events, through: true }, script: `${KEYS} return has("${want}");` };
}

export const CHART_KEYS: Check[] = [
  lands(
    "Escape gives the grid the keys, and F6 the window on top",
    [...ESCAPE, ...F6],
    "the first",
  ),
  lands("F6 again gives the keys to the window under it", F6, "the second"),
  lands("F6 on the last window gives the keys back to the grid", F6, "the grid"),
  lands("Shift+F6 from the grid gives the keys to the window at the back", SHIFT_F6, "the first"),
  {
    // The sheet is held short by hand, as in CHARTS.
    name: "a short room tucks the heads with the second past its foot, and the grid has the keys",
    script: `
      ${KEYS}
      document.querySelector(".win-sheet").style.maxHeight = ${SHORT_SHEET} + "px";
      const stack = await until(() => heads() && windows()[1].bottom > room().bottom);
      document.querySelector("#content").focus();
      return stack ? has("the grid") : "the windows stand at " + windows().map(edges).join(" and ");
    `,
  },
  {
    name: "Shift+F6 gives the keys to the head past the foot, which comes into view and takes the pointer",
    input: { events: SHIFT_F6, through: true },
    shot: "chart-f6-tucked",
    script: `
      ${KEYS}
      const off = await has("the second");
      if (off !== "") return off;
      const shows = await until(() => within(windows()[1], room()));
      const at = windows()[1];
      if (!shows) return "the head stands at " + edges(at) + " in a room at " + edges(room());
      return lower.contains(document.elementFromPoint((at.left + at.right) / 2, (at.top + at.bottom) / 2)) ? "" : "the head takes no pointer";
    `,
  },
  {
    name: "Ctrl+Shift+F gives the keys to the window on top, and the windows stand whole once the room grows",
    input: { events: [...ESCAPE, ...FRONT], through: true },
    script: `
      ${KEYS}
      const off = await has("the second");
      document.querySelector(".win-sheet").style.maxHeight = "";
      if (off !== "") return off;
      return (await until(() => !heads())) ? "" : "the windows stayed tucked";
    `,
  },
  lands("Shift+F6 goes on to the first window, which keeps the keys after", SHIFT_F6, "the first"),
];
