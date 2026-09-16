// Checks that the fixture opened: the bridge, the header, the virtualiser, and a
// window that takes no input from the person at the desktop.

import type { Check, Input } from "./check.ts";

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
    script: `return typeof window.uno?.open === "function" ? "" : "window.uno is missing"`,
  },
  {
    name: "the fixture opened",
    script: `
      const s = document.querySelector("#status-file").textContent;
      return s.includes(ROWS.toLocaleString() + " rows") ? "" : "status bar says: " + s;
    `,
  },
  {
    name: "the delimiter was sniffed from the bytes",
    script: `
      const s = document.querySelector("#status-file").textContent;
      return s.includes("delimiter ','") ? "" : "status bar says: " + s;
    `,
  },
  {
    name: "the columns are named and badged",
    script: `
      const heads = [...document.querySelectorAll("thead th .colhead")]
        .map((h) => h.firstChild.textContent);
      return JSON.stringify(heads) === JSON.stringify(
        ["date","region","rep","channel","units","revenue"]
      ) ? "" : "headers are " + JSON.stringify(heads);
    `,
  },
  {
    name: "units is flagged as numeric data in a costume",
    script: `
      const badges = [...document.querySelectorAll("thead th .badge")];
      const units = badges[UNITS];
      return units.classList.contains("flagged") && units.textContent === "text"
        ? ""
        : "units badge is " + units.textContent + " flagged=" + units.classList.contains("flagged");
    `,
  },
  {
    name: "the first row shows what the file holds",
    script: `
      const cells = [...document.querySelectorAll("tbody tr")[0].children]
        .map((c) => c.textContent);
      return cells[GUTTER + DATE] === "2026-07-01" && cells[GUTTER + UNITS] === "1,204"
        ? ""
        : "row 1 is " + JSON.stringify(cells);
    `,
  },
  {
    name: "it opens in view, where typing changes nothing",
    script: `
      const mode = text("#status-mode");
      if (mode !== "VIEW") return "the status bar's mode is " + JSON.stringify(mode);

      document.querySelectorAll("tbody tr")[0].children[GUTTER + UNITS].click();
      await frame();
      await press("9");

      if (document.querySelector(".cell-editor") !== null) return "typing in view opened an editor";
      const said = text("#status-msg");
      return said === "View · Ctrl+E to transform" ? "" : "the status bar says " + JSON.stringify(said);
    `,
  },
  {
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
    script: `
      const n = document.querySelectorAll("tbody tr").length;
      // A viewport shows a few dozen. Anything near 4,812 means the virtualiser
      // is not virtualising, which is the whole reason it exists.
      return n > 0 && n < DOM_ROWS ? "" : n + " rows in the DOM";
    `,
  },
  {
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
    script: `
      const sc = document.querySelector(".grid-scroll");
      sc.scrollTop = 0;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const cell = document.querySelectorAll("tbody tr")[2].children[GUTTER + REP];
      cell.click();
      await new Promise((r) => requestAnimationFrame(r));

      const status = document.querySelector("#status-cell").textContent;
      const selected = document.querySelectorAll("td.sel").length;
      return status === "rep · row 3" && selected === 1
        ? ""
        : "status is " + JSON.stringify(status) + " with " + selected + " selected";
    `,
  },
  {
    // Whoever is at the desktop keeps working while this runs. See src/main/driven.ts.
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
    // The wheel stays out: its scroll follows it later, and through does not wait.
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
