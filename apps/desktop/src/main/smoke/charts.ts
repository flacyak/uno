/**
 * @fileoverview Checks of the chart windows in real layout: the layer over the
 * sheet keeps a window below the header row and any banner, and clear of both
 * scrollbars and the ×, and the grid still takes the pointer and the keys
 * beside a window.
 *
 * They open the workspace smoke.js wrote, whose two charts stand at the sheet's
 * right edge, one at the top and one at the foot.
 */

import type { Check, Input } from "./check.ts";

/** The workspace smoke.js wrote. */
const CHARTED = process.env["UNO_SMOKE_CHARTED"] ?? "";

/** A point over the grid's tenth row, left of the windows, and one over the top window. */
const BESIDE = { x: 400, y: 300 };
const OVER_WINDOW = { x: 900, y: 150 };

/** The row the selection reaches: the one clicked, then the one below it. */
const ROW_BELOW = 11;

/** A person's click on the grid, and the arrow they press after it. */
const CLICK_AND_ARROW: readonly Input[] = [
  { type: "mouseDown", ...BESIDE, button: "left", clickCount: 1 },
  { type: "mouseUp", ...BESIDE, button: "left", clickCount: 1 },
  { type: "keyDown", keyCode: "Down" },
  { type: "keyUp", keyCode: "Down" },
];

/** Helpers: the boxes of the windows and the layer, and what the checks ask of them. */
const GEOMETRY = `
  const windows = () => [...document.querySelectorAll(".chart")].map((w) => w.getBoundingClientRect());
  const room = () => document.querySelector("#charts").getBoundingClientRect();
  const header = () => document.querySelector("thead").getBoundingClientRect();
  const edges = (at) => [at.left, at.top, at.right, at.bottom].join(" ");
  const unsaved = () => document.querySelector(".ws.open .dirty") !== null;
`;

export const CHARTS: Check[] = [
  {
    name: "the chart layer waits hidden, its stylesheet unloaded, until a workspace has charts",
    script: `
      const layer = document.querySelector("#charts");
      if (!layer.hidden) return "the layer shows";
      const position = getComputedStyle(layer).position;
      return position === "static" ? "" : "the layer is already " + position;
    `,
  },
  {
    name: "a workspace's charts open below the header row, clear of both scrollbars and the ×",
    send: ["menu:open-path", CHARTED],
    shot: "charts-layer",
    script: `
      ${GEOMETRY}
      if (!(await arrives(() => windows().length === 2))) return "the windows are " + windows().length + " · " + JSON.stringify(text("#status-msg"));
      const scroller = document.querySelector(".grid-scroll");
      if (scroller.scrollWidth <= scroller.clientWidth || scroller.scrollHeight <= scroller.clientHeight) {
        return "both scrollbars should show, so this checks nothing";
      }
      const sheet = scroller.getBoundingClientRect();
      const right = sheet.left + scroller.clientWidth;
      const bottom = sheet.top + scroller.clientHeight;
      const close = document.querySelector("#close").getBoundingClientRect();
      const [top, foot] = windows();
      if (top.top !== header().bottom) return "the top window starts at " + top.top + ", and the header row ends at " + header().bottom;
      if (top.right !== right) return "the top window ends at " + top.right + ", and the scrollbar starts at " + right;
      if (foot.right !== right) return "the foot window ends at " + foot.right + ", and the scrollbar starts at " + right;
      if (foot.bottom !== bottom) return "the foot window ends at " + foot.bottom + ", and the scrollbar starts at " + bottom;
      if (top.top < close.bottom) return "the top window starts at " + top.top + ", beside the × to " + close.bottom;
      return unsaved() ? "opening the workspace marked it unsaved" : "";
    `,
  },
  {
    // An offer takes three fixes by hand, so this shows the banner itself: the
    // layer answers to the grid's box, however that moves.
    name: "a banner pushes the layer down, and the layer comes back up with it",
    script: `
      ${GEOMETRY}
      const banner = document.querySelector("#banner");
      const bare = room().top;
      banner.textContent = "remove commas";
      banner.hidden = false;
      const under = await until(() => room().top > bare && room().top === header().bottom);
      banner.hidden = true;
      if (!under) return "the layer starts at " + room().top + ", and the header row ends at " + header().bottom;
      return (await until(() => room().top === bare)) ? "" : "the layer stayed at " + room().top;
    `,
  },
  {
    // A scrollbar-color drops uno's own bars for the browser's wider ones, as
    // Firefox draws them. The layer measures them when the banner moves it.
    name: "the layer stays clear of the wider scrollbars a browser draws for itself",
    script: `
      ${GEOMETRY}
      const scroller = document.querySelector(".grid-scroll");
      const banner = document.querySelector("#banner");
      const bar = () => scroller.offsetWidth - scroller.clientWidth;
      const clear = () => {
        const sheet = scroller.getBoundingClientRect();
        return room().right === sheet.left + scroller.clientWidth && room().bottom === sheet.top + scroller.clientHeight;
      };
      const ours = bar();
      scroller.style.scrollbarColor = "gray transparent";
      banner.hidden = false;
      const wider = await until(() => bar() > ours && clear());
      const stood = edges(room());
      scroller.style.scrollbarColor = "";
      banner.hidden = true;
      if (!wider) return "the layer stands at " + stood + " beside bars of " + bar() + "px";
      return (await until(() => bar() === ours && clear())) ? "" : "the layer stayed at " + edges(room());
    `,
  },
  {
    name: "the grid takes a click and its keys beside a window, and a window takes the pointer over itself",
    input: { events: CLICK_AND_ARROW, through: true },
    script: `
      const cell = () => text("#status-cell");
      if (!(await until(() => cell().endsWith("row ${ROW_BELOW}")))) return "the selection is at " + cell();
      const at = (point) => document.elementFromPoint(point.x, point.y);
      const beside = at(${JSON.stringify(BESIDE)});
      if (beside.closest("#content") === null) return "beside the windows is " + beside.tagName;
      const over = at(${JSON.stringify(OVER_WINDOW)});
      return over.closest(".chart") === null ? "over the window is " + over.tagName : "";
    `,
  },
];
