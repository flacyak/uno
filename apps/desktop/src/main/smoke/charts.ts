/**
 * @fileoverview Checks of the chart windows in real layout: the layer over the
 * sheet lands a window on the rules around it, clear of both scrollbars and the
 * ×, inside its room at 200% zoom, and tucked to its head where the side columns
 * leave too little room. None of it marks the workspace unsaved, and the grid
 * still takes the pointer and the keys beside a window.
 *
 * They open the workspace smoke.js wrote, whose two charts stand at the sheet's
 * right edge, one at the top and one at the foot.
 */

import { DEFAULT_HEIGHT } from "@renderer/chart/place";
import type { Check, Input } from "./check.ts";

/** The workspace smoke.js wrote. */
const CHARTED = process.env["UNO_SMOKE_CHARTED"] ?? "";

/** The zoom that halves the room. */
const DOUBLE_ZOOM = 2;

/** The window's least width, where both side columns leave too little room. */
const NARROW_WIDTH = 640;

/**
 * The View menu's Zoom In pressed five times: Electron's factor is 1.2 to the
 * zoom level, and a press adds half a level. Each scrollbar is a fraction of a
 * CSS px here, which clientWidth rounds one way and clientHeight the other.
 */
const MENU_ZOOM = 1.2 ** 2.5;

/** How close devicePixelRatio comes to that factor. */
const ZOOM_SLACK = 0.002;

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
  const border = () => parseFloat(getComputedStyle(document.querySelector("thead th")).borderBottomWidth);
  const rule = () => header().bottom - border();
  const within = (at, box) => at.left >= box.left && at.top >= box.top && at.right <= box.right && at.bottom <= box.bottom;
  const edges = (at) => [at.left, at.top, at.right, at.bottom].join(" ");
  const unsaved = () => document.querySelector(".ws.open .dirty") !== null;
  const HEAD = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h"));
  const heads = () => windows().every((at) => at.height === HEAD && at.width === room().width);
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
    name: "a workspace's charts open on the header row's rule, over it, clear of both scrollbars and the ×",
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
      if (top.top !== rule()) return "the top window starts at " + top.top + ", and the header row's rule at " + rule();
      const edge = document.elementFromPoint((top.left + top.right) / 2, top.top);
      if (edge.closest(".chart") === null) return "the top window's border is under the " + edge.tagName;
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
      const under = await until(() => room().top > bare && room().top === rule());
      banner.hidden = true;
      if (!under) return "the layer starts at " + room().top + ", and the header row's rule at " + rule();
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
  {
    // A window's last device px stands over the grid, and the next on the bar.
    name: "at the View menu's 158%, a window meets both scrollbars with no grid past it",
    window: { zoom: MENU_ZOOM },
    script: `
      ${GEOMETRY}
      const middle = (px) => (px + 0.5) / devicePixelRatio;
      const grid = (x, y) => document.elementsFromPoint(x, y).some((hit) => hit.matches("td, th"));
      const meets = () => {
        const [top, foot] = windows();
        const right = Math.round(top.right * devicePixelRatio);
        const bottom = Math.round(foot.bottom * devicePixelRatio);
        const y = (top.top + top.bottom) / 2;
        const x = (foot.left + foot.right) / 2;
        return grid(middle(right - 1), y) && !grid(middle(right), y) && grid(x, middle(bottom - 1)) && !grid(x, middle(bottom));
      };
      if (await until(() => Math.abs(devicePixelRatio - ${MENU_ZOOM}) < ${ZOOM_SLACK} && meets())) return "";
      return "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
    `,
  },
  {
    name: "at 200% zoom the windows stay inside the room",
    window: { zoom: DOUBLE_ZOOM },
    shot: "charts-zoomed",
    script: `
      ${GEOMETRY}
      if (!(await until(() => innerWidth < ${NARROW_WIDTH}))) return "the page is " + innerWidth + "px wide";
      await frame();
      if (room().top !== rule()) return "the layer starts at " + room().top + ", and the header row's rule at " + rule();
      for (const at of windows()) {
        if (!within(at, room())) return "a window stands at " + edges(at) + " in a room at " + edges(room());
        if (at.height === HEAD) return "a window is tucked in a room at " + edges(room());
      }
      return unsaved() ? "the zoom marked the workspace unsaved" : "";
    `,
  },
  {
    // Tucked here, the windows are what the next check's reshape lands on, so
    // that check has to tell them from the ones it waits for.
    name: "at 200% zoom with both side columns open, each window tucks to its head",
    script: `
      ${GEOMETRY}
      await openPanel();
      return (await until(heads)) ? "" : "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
    `,
  },
  {
    name: "in a narrow window with both side columns open, each window tucks to its head",
    window: { width: NARROW_WIDTH },
    shot: "charts-tucked",
    script: `
      ${GEOMETRY}
      // The zoomed page is narrower, and its windows are tucked as well.
      const tucked = () => innerWidth >= ${NARROW_WIDTH} && heads();
      if (!(await until(tucked))) return "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
      const [top, foot] = windows();
      if (top.left !== room().left) return "the top window stands at " + edges(top) + " in a room at " + edges(room());
      if (top.top !== room().top || foot.top !== top.bottom) return "the heads stand at " + edges(top) + " and " + edges(foot);
      return unsaved() ? "tucking marked the workspace unsaved" : "";
    `,
  },
  {
    name: "with room again, each window goes back to its place",
    window: {},
    script: `
      ${GEOMETRY}
      document.querySelector("#panel-toggle").click();
      const back = () => {
        const [top, foot] = windows();
        return top.height === ${DEFAULT_HEIGHT} && top.top === room().top && top.right === room().right && foot.bottom === room().bottom;
      };
      if (!(await until(back))) return "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
      return unsaved() ? "going back marked the workspace unsaved" : "";
    `,
  },
];
