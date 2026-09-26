// Checks that the fixture opened: the bridge, the header, the virtualiser, and a
// window that takes no input from the person at the desktop.

import type { Check, Input } from "./check.ts";
import { DATE, DOM_ROWS, REP, ROWS, UNITS } from "./fixture.ts";

/** A point over a cell in the grid, and a turn of the wheel up it. */
const OVER_GRID = { x: 400, y: 300 };
const WHEEL_UP = -600;

/**
 * What a person at the desktop might do to the window mid-run: a key that moves
 * the selection, a click on a cell, and the wheel over the grid.
 */
const PERSON: readonly Input[] = [
  { type: "keyDown", keyCode: "Down" },
  { type: "keyUp", keyCode: "Down" },
  { type: "mouseDown", ...OVER_GRID, button: "left", clickCount: 1 },
  { type: "mouseUp", ...OVER_GRID, button: "left", clickCount: 1 },
  { type: "mouseWheel", ...OVER_GRID, deltaY: WHEEL_UP },
];

export const OPEN: Check[] = [
  {
    name: "the preload bridge is there",
    run: async (page) => ((await page.bridgeExposed()) ? "" : "window.uno is missing"),
  },
  {
    name: "the fixture opened",
    run: async (page) => {
      const s = await page.text("#status-file");
      return s.includes(ROWS.toLocaleString() + " rows") ? "" : "status bar says: " + s;
    },
  },
  {
    // The file is still on disk, so a workspace nobody has touched has nothing to lose.
    name: "a file just opened has nothing unsaved",
    run: async (page) => ((await page.count(".tab .dirty")) === 0 ? "" : "the tab has a dirty dot"),
  },
  {
    name: "the delimiter was sniffed from the bytes",
    run: async (page) => {
      const s = await page.text("#status-file");
      return s.includes("delimiter ','") ? "" : "status bar says: " + s;
    },
  },
  {
    name: "the columns are named and badged",
    run: async (page) => {
      const heads = await page.ownText("thead th .colhead");
      const want = ["date", "region", "rep", "channel", "units", "revenue"];
      return JSON.stringify(heads) === JSON.stringify(want)
        ? ""
        : "headers are " + JSON.stringify(heads);
    },
  },
  {
    name: "units is flagged as numeric data in a costume",
    run: async (page) => {
      const badges = await page.allText("thead th .badge");
      const flagged = await page.hasClass("thead th .badge", "flagged", UNITS);
      const unit = badges[UNITS] ?? "";
      return flagged && unit === "text" ? "" : "units badge is " + unit + " flagged=" + flagged;
    },
  },
  {
    name: "the first row shows what the file holds",
    run: async (page) => {
      const [row] = await page.rows();
      // The gutter goes back in front, so a failure reads exactly as the row it names.
      const cells = [row?.gutter ?? "", ...(row?.cells ?? [])];
      const date = row?.cells[DATE] ?? "";
      const units = row?.cells[UNITS] ?? "";
      return date === "2026-07-01" && units === "1,204" ? "" : "row 1 is " + JSON.stringify(cells);
    },
  },
  {
    name: "it opens in view, where typing changes nothing",
    run: async (page) => {
      const mode = await page.text("#status-mode");
      if (mode !== "VIEW") return "the status bar's mode is " + JSON.stringify(mode);

      await page.clickCell(0, UNITS);
      await page.settle(2);
      await page.press("9");

      if ((await page.editorValue()) !== undefined) return "typing in view opened an editor";
      const said = await page.text("#status-msg");
      return said === "View · Ctrl+E to transform"
        ? ""
        : "the status bar says " + JSON.stringify(said);
    },
  },
  {
    // Needs the real preload bridge -- `webUtils.getPathForFile` -- which only
    // a real Electron window exposes. Window-bound.
    name: "a file that is not on disk is refused by name",
    script: `
      try {
        window.uno.dropped(new File(["a,b\\n1,2\\n"], "memory.csv"));
        return "a file with no path was accepted";
      } catch (err) {
        return err.message.includes("memory.csv") ? "" : err.message;
      }
    `,
  },
  {
    name: "only the visible rows are in the DOM",
    run: async (page) => {
      const n = await page.count("tbody tr");
      // A viewport shows a few dozen. Anything near 4,812 means the virtualiser
      // is not virtualising, which is the whole reason it exists.
      return n > 0 && n < DOM_ROWS ? "" : n + " rows in the DOM";
    },
  },
  {
    // Compares getBoundingClientRect() of the header against the scroller: real
    // layout, which nothing but a real window can give an honest answer to.
    // Window-bound.
    name: "scrolling to the end renders the last row",
    script: `
      const sc = document.querySelector(".grid-scroll");
      sc.scrollTop = sc.scrollHeight;

      // The rows at the end are not in the band the file opened with, so they
      // are drawn pending until the engine sends them.
      let rows = [];
      for (let i = 0; i < TRIES; i++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        rows = [...document.querySelectorAll("tbody tr")];
        const last = rows[rows.length - 1];
        if (last.children[0].textContent === String(ROWS) && !last.classList.contains("pending")) {
          const date = last.children[1].textContent;
          if (rows.length >= DOM_ROWS) return rows.length + " rows in the DOM";
          if (date === "") return "row 4,812 arrived empty";

          // The header has to have come along. It once stuck to where the table
          // started and scrolled out of sight with it.
          const head = document.querySelector("thead th").getBoundingClientRect().top;
          const view = sc.getBoundingClientRect().top;
          return Math.abs(head - view) <= 1 ? "" : "the header is at " + head + ", the view starts at " + view;
        }
      }
      const last = rows[rows.length - 1];
      return "last gutter is " + last.children[0].textContent + ", class " + JSON.stringify(last.className);
    `,
  },
  {
    name: "the selection follows a click",
    run: async (page) => {
      await page.scrollTo(0);
      await page.settle(2);
      await page.clickCell(2, REP);
      await page.settle(1);

      const status = await page.text("#status-cell");
      const selected = await page.count("td.sel");
      return status === "rep · row 3" && selected === 1
        ? ""
        : "status is " + JSON.stringify(status) + " with " + selected + " selected";
    },
  },
  {
    // Whether a person's own input reaches a driven window is exactly what
    // `input.through` decides. Window-bound: see src/main/driven.ts.
    name: "a person's key, click and wheel do not reach the page",
    input: { events: PERSON, through: false },
    script: `
      for (let i = 0; i < SETTLE_FRAMES; i++) await frame();
      const sc = document.querySelector(".grid-scroll");
      if (sc.scrollTop !== 0) return "the grid scrolled to " + sc.scrollTop;
      return text("#status-cell") === "rep · row 3" ? "" : "the selection moved to " + text("#status-cell");
    `,
  },
  {
    // Without this, the check before it would pass on input that went nowhere.
    // The wheel stays out: its scroll follows it later, and through does not
    // wait. Window-bound, for the same reason as the check above.
    name: "the same key and click let through do reach it",
    input: { events: PERSON.filter((e) => e.type !== "mouseWheel"), through: true },
    script: `
      if (!(await until(() => text("#status-cell") !== "rep · row 3"))) {
        return "the selection is still at " + text("#status-cell");
      }

      // Back where the checks after this one expect.
      document.querySelectorAll("tbody tr")[2].children[GUTTER + REP].click();
      await frame();
      return text("#status-cell") === "rep · row 3" ? "" : "the selection went back to " + text("#status-cell");
    `,
  },
];
