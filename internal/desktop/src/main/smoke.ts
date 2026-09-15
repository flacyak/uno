// The assertions the smoke test makes against a running window.
//
// This is test code living in the app, which is a smell worth naming: it is
// here because a virtualiser, a preload bridge and an IPC round trip cannot be
// checked anywhere but inside a real Electron, and the alternative was a
// browser-automation dependency larger than the app it would be testing.
//
// It is reached only when UNO_SMOKE is set in the environment, it is the only
// thing in `src/main` that knows what a test is, and nothing in the app calls
// it.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserWindow } from "electron";

import { through } from "./driven.ts";

type Input = Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0];

interface Check {
  name: string;
  /**
   * A menu item's message and what it carries, sent before the script runs the
   * way the menu sends it. An accelerator is the main process's, so a key the
   * page dispatches never reaches one.
   */
  send?: readonly [channel: string, ...args: unknown[]];
  /**
   * Input sent before the script runs, down the path the window system sends a
   * person's. The window is driven, so it drops all of it unless `through` is set.
   */
  input?: { events: readonly Input[]; through: boolean };
  /** Runs in the renderer. Returns a message on failure, or "" when it passes. */
  script: string;
}

/**
 * What a person at the desktop might do to the window mid-run: a key that moves
 * the selection, a click on a cell, and the wheel over the grid.
 */
const PERSON: readonly Input[] = [
  { type: "keyDown", keyCode: "Down" },
  { type: "keyUp", keyCode: "Down" },
  { type: "mouseDown", x: 400, y: 300, button: "left", clickCount: 1 },
  { type: "mouseUp", x: 400, y: 300, button: "left", clickCount: 1 },
  { type: "mouseWheel", x: 400, y: 300, deltaY: -600 },
];

/**
 * What a person would look at to decide the app works.
 *
 * Each one is a claim about the real fixture: 4,812 rows of a real export, the
 * units column wearing thousands separators, and a grid that must not put all
 * of it in the DOM.
 */
const CHECKS: Check[] = [
  {
    name: "the preload bridge is there",
    script: `return typeof window.uno?.open === "function" ? "" : "window.uno is missing"`,
  },
  {
    name: "the fixture opened",
    script: `
      const s = document.querySelector("#status-file").textContent;
      return s.includes("4,812 rows") ? "" : "status bar says: " + s;
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
      const units = badges[4];
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
      return cells[1] === "2026-07-01" && cells[5] === "1,204"
        ? ""
        : "row 1 is " + JSON.stringify(cells);
    `,
  },
  {
    name: "it opens in view, where typing changes nothing",
    script: `
      const mode = text("#status-mode");
      if (mode !== "VIEW") return "the status bar's mode is " + JSON.stringify(mode);

      document.querySelectorAll("tbody tr")[0].children[5].click();
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
      return n > 0 && n < 120 ? "" : n + " rows in the DOM";
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
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        rows = [...document.querySelectorAll("tbody tr")];
        const last = rows[rows.length - 1];
        if (last.children[0].textContent === "4812" && !last.classList.contains("pending")) {
          const date = last.children[1].textContent;
          if (rows.length >= 120) return rows.length + " rows in the DOM";
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

      const cell = document.querySelectorAll("tbody tr")[2].children[3];
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
      for (let i = 0; i < 10; i++) await frame();
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
      document.querySelectorAll("tbody tr")[2].children[3].click();
      await frame();
      return text("#status-cell") === "rep · row 3" ? "" : "the selection went back to " + text("#status-cell");
    `,
  },
  {
    name: "Ctrl+E switches to transform",
    script: `
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true }));
      const mode = document.querySelector("#status-mode");
      for (let i = 0; i < 100 && mode.textContent !== "TRANSFORM"; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => requestAnimationFrame(r));

      const on = document.querySelector(".seg .on")?.textContent;
      if (mode.textContent !== "TRANSFORM") return "the mode is still " + mode.textContent;
      return on === "Transform" ? "" : "the switch shows " + JSON.stringify(on);
    `,
  },
  {
    name: "typing into a cell records an edit",
    script: `
      const content = document.querySelector("#content");
      const cell = document.querySelectorAll("tbody tr")[0].children[5];
      cell.click();
      await new Promise((r) => requestAnimationFrame(r));

      // Enter opens the editor over the selected cell, the way it does in the
      // Go build's grid.
      content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));

      const input = document.querySelector(".cell-editor");
      if (input === null) return "Enter did not open an editor";
      if (input.value !== "1,204") return "the editor started at " + JSON.stringify(input.value);

      input.value = "1204";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      // The value shows before the engine has recorded it.
      const shown = document.querySelectorAll("tbody tr")[0].children[5].textContent;
      if (shown !== "1204") return "the cell shows " + JSON.stringify(shown);

      let status = "";
      for (let i = 0; i < 100; i++) {
        status = document.querySelector("#status-file").textContent;
        if (status.includes("1 edit")) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      if (!status.includes("1 edit")) return "status bar says: " + status;
      if (document.querySelector(".tab .dirty") === null) return "the tab is not marked dirty";
      return "";
    `,
  },
  {
    name: "the editor closes when the edit is committed",
    script: `
      const content = document.querySelector("#content");
      const cell = document.querySelectorAll("tbody tr")[1].children[5];
      cell.click();
      await new Promise((r) => requestAnimationFrame(r));

      content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelectorAll(".cell-editor").length !== 1) return "Enter did not open one editor";

      const input = document.querySelector(".cell-editor");
      input.value = "987";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      // Committing used to leave the Enter free to reach the grid, which read
      // it as "start editing" and reopened an editor over the cell.
      const open = document.querySelectorAll(".cell-editor").length;
      return open === 0 ? "" : open + " editor(s) still open after committing";
    `,
  },
  {
    name: "three fixes bring an offer, and Apply is one edit",
    script: `
      const content = document.querySelector("#content");
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const type = async (row, value) => {
        document.querySelectorAll("tbody tr")[row].children[5].click();
        await frame();
        content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await frame();
        const input = document.querySelector(".cell-editor");
        input.value = value;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await frame();
      };

      // Row 1 was fixed by the check before last. These are the second and third.
      await type(2, "1455");
      await type(4, "2038");

      const banner = document.querySelector("#banner");
      for (let i = 0; i < 150 && !(banner.textContent.includes("3,149 cells")); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      if (banner.hidden) return "no banner after three fixes";
      if (!banner.textContent.includes("remove commas · 3,149 cells")) {
        return "the banner says " + JSON.stringify(banner.textContent);
      }

      banner.querySelector("button.primary").click();
      let cell = "";
      let status = "";
      for (let i = 0; i < 150; i++) {
        await frame();
        cell = document.querySelectorAll("tbody tr")[5].children[5].textContent;
        status = document.querySelector("#status-file").textContent;
        if (cell === "1101" && status.includes("4 edits")) break;
      }
      if (cell !== "1101") return "row 6 still shows " + JSON.stringify(cell);
      if (!status.includes("4 edits")) return "status bar says: " + status;

      const badge = document.querySelectorAll("thead th .badge")[4].textContent;
      if (badge !== "num") return "the units badge says " + badge;
      return banner.hidden ? "" : "the banner stayed after Apply";
    `,
  },
  {
    name: "Ctrl+Z takes the apply back",
    script: `
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
      let cell = "";
      let status = "";
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        cell = document.querySelectorAll("tbody tr")[5].children[5].textContent;
        status = document.querySelector("#status-file").textContent;
        if (cell === "1,101" && status.includes("3 edits")) break;
      }
      if (cell !== "1,101") return "row 6 shows " + JSON.stringify(cell);
      return status.includes("3 edits") ? "" : "status bar says: " + status;
    `,
  },
  {
    name: "by default, typing over a cell replaces it and Esc throws the typing away",
    script: `
      const cell = () => document.querySelectorAll("tbody tr")[6].children[5].textContent;
      document.querySelectorAll("tbody tr")[6].children[5].click(); // units, row 7: 843
      await frame();

      await press("9");
      const input = document.querySelector(".cell-editor");
      if (input === null) return "typing did not open an editor";
      if (input.value !== "9") return "the editor holds " + JSON.stringify(input.value);
      if (text("#status-mode") !== "TRANSFORM") return "the mode is " + text("#status-mode");

      await press("Escape");
      if (document.querySelector(".cell-editor") !== null) return "Esc left the editor open";
      if (cell() !== "843") return "Esc kept the typing: the cell shows " + JSON.stringify(cell());
      return text("#status-file").includes("3 edits") ? "" : "status bar says: " + text("#status-file");
    `,
  },
  {
    name: "by default, Ctrl+R records again what Ctrl+Z took back",
    script: `
      const cell = () => document.querySelectorAll("tbody tr")[5].children[5].textContent;
      await press("r", { ctrlKey: true });
      if (!(await until(() => text("#status-file").includes("4 edits") && cell() === "1101"))) {
        return "after Ctrl+R row 6 shows " + JSON.stringify(cell()) + ", status bar: " + text("#status-file");
      }

      // Taken back again, so the checks after this one start where they expect.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
      return (await until(() => text("#status-file").includes("3 edits") && cell() === "1,101"))
        ? ""
        : "Ctrl+Z after Ctrl+R left row 6 showing " + JSON.stringify(cell());
    `,
  },
  {
    name: "Edit → Input → Vim-style reads keys the vim way, and is kept",
    send: ["menu:input", "vim-style"],
    script: `
      if (!(await until(() => localStorage.getItem("uno.input") === "vim-style"))) {
        return "the choice was not kept: " + JSON.stringify(localStorage.getItem("uno.input"));
      }
      const hint = document.querySelector(".seg")?.title ?? "";
      return hint.startsWith("i to transform") ? "" : "the mode switch says " + JSON.stringify(hint);
    `,
  },
  {
    name: "i in view switches to transform and opens nothing",
    script: `
      await press("Escape"); // Ctrl+Z left the file in transform
      if (text("#status-mode") !== "VIEW") return "Esc left the mode at " + text("#status-mode");

      document.querySelectorAll("tbody tr")[6].children[5].click(); // units, row 7: 843
      await frame();
      await press("i");
      if (text("#status-mode") !== "TRANSFORM") return "the mode is " + text("#status-mode");
      return document.querySelector(".cell-editor") === null ? "" : "i in view opened an editor";
    `,
  },
  {
    name: "a opens the editor with the caret after the value",
    script: `
      await press("a");
      const input = document.querySelector(".cell-editor");
      if (input === null) return "a did not open an editor";
      if (text("#status-mode") !== "INSERT") return "the mode is " + text("#status-mode");
      return input.value === "843" && input.selectionStart === input.value.length
        ? ""
        : "the editor holds " + JSON.stringify(input.value) + " with the caret at " + input.selectionStart;
    `,
  },
  {
    name: "Esc, then i in transform, opens the editor with the caret at the start",
    script: `
      await press("Escape");
      if (document.querySelector(".cell-editor") !== null) return "Esc left the editor open";
      if (text("#status-mode") !== "TRANSFORM") return "Esc left the mode at " + text("#status-mode");

      await press("i");
      const input = document.querySelector(".cell-editor");
      if (input === null) return "i in transform did not open an editor";
      return input.selectionStart === 0 ? "" : "the caret is at " + input.selectionStart;
    `,
  },
  {
    name: "Esc keeps what was typed, and leaves insert for transform",
    script: `
      document.querySelector(".cell-editor").value = "8430";
      await press("Escape");
      if (document.querySelector(".cell-editor") !== null) return "Esc left the editor open";
      if (text("#status-mode") !== "TRANSFORM") return "the mode is " + text("#status-mode");

      // 3 before, so the Esc that closed a's editor unchanged recorded nothing.
      if (!(await until(() => text("#status-file").includes("4 edits")))) {
        return "status bar says: " + text("#status-file");
      }
      const shown = document.querySelectorAll("tbody tr")[6].children[5].textContent;
      return shown === "8430" ? "" : "the cell shows " + JSON.stringify(shown);
    `,
  },
  {
    name: "Esc again switches to view, and keeps the log",
    script: `
      await press("Escape");
      if (text("#status-mode") !== "VIEW") return "the mode is " + text("#status-mode");
      if (!text("#status-file").includes("4 edits")) return "status bar says: " + text("#status-file");
      return document.querySelector(".tab .dirty") !== null ? "" : "the tab lost its dirty dot";
    `,
  },
  {
    name: "s in transform opens the editor empty",
    script: `
      await press("i");
      await press("s");
      const input = document.querySelector(".cell-editor");
      if (input === null) return "s did not open an editor";
      if (input.value !== "") return "the editor holds " + JSON.stringify(input.value);

      input.value = "843";
      await press("Escape");
      return (await until(() => text("#status-file").includes("5 edits")))
        ? ""
        : "status bar says: " + text("#status-file");
    `,
  },
  {
    name: "u takes the edit back and selects its cell",
    script: `
      await press("ArrowUp");
      await press("ArrowLeft");
      if (text("#status-cell") !== "channel · row 6") return "the selection is at " + text("#status-cell");

      await press("u");
      if (!(await until(() => text("#status-file").includes("4 edits")))) {
        return "status bar says: " + text("#status-file");
      }
      if (text("#status-cell") !== "units · row 7") return "the selection is at " + text("#status-cell");
      const cell = () => document.querySelectorAll("tbody tr")[6].children[5].textContent;
      return (await until(() => cell() === "8430")) ? "" : "the cell shows " + JSON.stringify(cell());
    `,
  },
  {
    name: "a count waits in the status bar, and 5j moves five rows",
    script: `
      await press("5");
      const waiting = text("#status-keys");
      if (waiting !== "5") return "the status bar shows " + JSON.stringify(waiting) + " waiting";
      await press("j");
      if (text("#status-keys") !== "") return "the count was still waiting after j";
      return text("#status-cell") === "units · row 12" ? "" : "the selection is at " + text("#status-cell");
    `,
  },
  {
    name: "Esc drops a pending count and stays in transform",
    script: `
      await press("4");
      await press("Escape");
      if (text("#status-keys") !== "") return "the count is still waiting";
      return text("#status-mode") === "TRANSFORM" ? "" : "the mode is " + text("#status-mode");
    `,
  },
  {
    name: "G, gg, $, 0, {n}G and w land where vim would",
    script: `
      const steps = [
        [["G"], "units · row 4812"],
        [["g", "g"], "units · row 1"],
        [["$"], "revenue · row 1"],
        [["0"], "date · row 1"],
        [["3", "0", "G"], "date · row 30"],
        [["w"], "region · row 30"],
        [["b", "b"], "revenue · row 29"],
      ];
      for (const [keys, want] of steps) {
        for (const key of keys) await press(key);
        const at = text("#status-cell");
        if (at !== want) return keys.join("") + " went to " + JSON.stringify(at) + ", not " + JSON.stringify(want);
      }
      return "";
    `,
  },
  {
    name: "zt, zb and zz scroll the row into place, and H, L and M find it there",
    script: `
      const row = () => Number(text("#status-cell").split("row ")[1].replace(/,/g, ""));
      // Sent without waiting a frame between keys. The grid lays out as each key
      // lands, and the recogniser's banner comes and goes as offers arrive: one
      // arriving between zb and L would move the rows under L.
      const grid = document.querySelector("#content");
      const key = (k) => grid.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

      // 30G left row 29 one above the bottom of the screen, far from its top.
      for (const [scroll, find] of [["t", "H"], ["b", "L"], ["z", "M"]]) {
        key("z");
        key(scroll);
        if (row() !== 29) return "z" + scroll + " moved the selection to row " + row();
        key(find);
        if (row() !== 29) return "z" + scroll + " then " + find + " went to row " + row();
      }

      key("H");
      const top = row();
      key("3");
      key("H");
      return row() === top + 2 ? "" : "3H went to row " + row() + " with row " + top + " on top";
    `,
  },
  {
    name: "a mark brings the selection back, and '' returns from the jump",
    script: `
      const at = () => text("#status-cell");
      await press("m");
      await press("a");
      const marked = at();

      await press("G");
      if (at() !== "revenue · row 4812") return "G went to " + at();
      await press("'");
      await press("a");
      if (at() !== marked) return "'a went to " + at() + ", not " + marked;
      await press("'");
      await press("'");
      if (at() !== "revenue · row 4812") return "'' went to " + at();
      await press("\`");
      await press("\`");
      if (at() !== marked) return "\`\` went to " + at() + ", not " + marked;

      await press("'");
      await press("q");
      const said = text("#status-msg");
      return said === "mark q is not set" ? "" : "an unset mark says " + JSON.stringify(said);
    `,
  },
  {
    name: "yy copies in view, and p puts it in a cell in transform",
    script: `
      const cell = (row) => document.querySelectorAll("tbody tr")[row].children[5].textContent;
      await press("Escape");
      if (text("#status-mode") !== "VIEW") return "Esc left the mode at " + text("#status-mode");
      for (const key of ["g", "g", "0", "4", "l"]) await press(key);
      if (text("#status-cell") !== "units · row 1") return "the selection is at " + text("#status-cell");
      await press("y");
      await press("y");
      await frame(); // the clipboard answers on its own time

      for (const key of ["3", "j", "p"]) await press(key);
      if (cell(3) !== "612") return "p in view changed the cell to " + JSON.stringify(cell(3));
      const said = text("#status-msg");
      if (!said.includes("i or Ctrl+E")) return "p in view says " + JSON.stringify(said);

      await press("i");
      await press("p");
      if (!(await until(() => text("#status-file").includes("5 edits")))) {
        return "status bar says: " + text("#status-file");
      }
      return cell(3) === "1204" ? "" : "row 4 shows " + JSON.stringify(cell(3));
    `,
  },
  {
    name: "x clears the cell, and a count before it is dropped",
    script: `
      const cell = (row) => document.querySelectorAll("tbody tr")[row].children[5].textContent;
      for (const key of ["j", "3", "x"]) await press(key);
      if (!(await until(() => text("#status-file").includes("6 edits")))) {
        return "status bar says: " + text("#status-file");
      }
      if (cell(4) !== "") return "row 5 shows " + JSON.stringify(cell(4));
      return cell(5) === "1,101" ? "" : "3x reached row 6, which shows " + JSON.stringify(cell(5));
    `,
  },
  {
    name: ". appends what a added, on the next cells down",
    script: `
      const region = (row) => document.querySelectorAll("tbody tr")[row].children[2].textContent;
      for (const key of ["g", "g", "0", "l", "a"]) await press(key);
      const input = document.querySelector(".cell-editor");
      if (input === null) return "a did not open an editor";
      input.value = "West-q3"; // typed after West, where a put the caret

      for (const key of ["Escape", "j", ".", "j", "."]) await press(key);
      if (!(await until(() => text("#status-file").includes("9 edits")))) {
        return "status bar says: " + text("#status-file");
      }
      const got = [0, 1, 2, 3].map(region);
      return JSON.stringify(got) === JSON.stringify(["West-q3", "East-q3", "North-q3", "South"])
        ? ""
        : "region reads " + JSON.stringify(got);
    `,
  },
  {
    name: "ga applies the banner's offer from another column, and says when there is none",
    script: `
      for (const key of ["Escape", "g", "a"]) await press(key);
      const said = text("#status-msg");
      if (!said.includes("i or Ctrl+E")) return "ga in view says " + JSON.stringify(said);

      // Back in transform, the recogniser asks again about the three fixes.
      await press("i");
      const banner = document.querySelector("#banner");
      if (!(await until(() => !banner.hidden && banner.textContent.includes("region") && banner.textContent.includes("4,809 cells")))) {
        return "the banner says " + JSON.stringify(banner.textContent);
      }

      for (const key of ["4", "l", "g", "a"]) await press(key); // from revenue
      const region = () => document.querySelectorAll("tbody tr")[3].children[2].textContent;
      if (!(await until(() => region() === "South-q3"))) return "row 4 reads " + JSON.stringify(region());
      if (!(await until(() => text("#status-file").includes("10 edits")))) {
        return "status bar says: " + text("#status-file");
      }
      // The three fixes the offer was learned from are left as they were typed.
      const fixed = [0, 1, 2].map((r) => document.querySelectorAll("tbody tr")[r].children[2].textContent);
      if (JSON.stringify(fixed) !== JSON.stringify(["West-q3", "East-q3", "North-q3"])) {
        return "after ga the fixed rows read " + JSON.stringify(fixed);
      }
      if (!banner.hidden) return "the banner stayed after ga";
      if (text("#status-cell") !== "revenue · row 3") return "ga moved the selection to " + text("#status-cell");

      await press("g");
      await press("a");
      const none = text("#status-msg");
      return none === "nothing to apply" ? "" : "ga with no banner says " + JSON.stringify(none);
    `,
  },
  {
    name: ": opens a command line that goes to a row, refuses what it does not know, and Esc closes",
    script: `
      const input = document.querySelector("#status-cmd");
      const run = async (typed) => {
        await press(":");
        input.value = typed;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await frame();
      };

      await press(":");
      if (input.hidden) return "the command line did not open";
      if (document.activeElement !== input) return "the command line did not take the keys";
      if (input.value !== ":") return "it opened holding " + JSON.stringify(input.value);
      if (document.querySelector("#status-file").getClientRects().length > 0) {
        return "the file's line still shows beside it";
      }
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await frame();
      if (!input.hidden) return "Esc left the command line open";
      if (text("#status-cell") !== "revenue · row 3") return "Esc moved the selection to " + text("#status-cell");

      await run(":120");
      if (!input.hidden) return "Enter left the command line open";
      if (text("#status-cell") !== "revenue · row 120") return ":120 went to " + text("#status-cell");
      await press("'");
      await press("'");
      if (text("#status-cell") !== "revenue · row 3") return "'' after :120 went to " + text("#status-cell");

      await run(":e");
      const refused = text("#status-msg");
      if (refused !== "unsaved edits · :w first, or :e! to drop them") {
        return ":e over unsaved edits says " + JSON.stringify(refused);
      }
      await run(":foo");
      const unknown = text("#status-msg");
      return unknown === "not a command: :foo" ? "" : ":foo says " + JSON.stringify(unknown);
    `,
  },
  {
    name: "]f and [f go to the cells in a column that do not parse",
    script: `
      const at = () => text("#status-cell");
      await press("h");
      if (at() !== "units · row 3") return "the selection is at " + at();

      // Row 5 is blank, which is no evidence either way; rows 6 and 8 keep their commas.
      for (const [key, want] of [["]", "units · row 6"], ["]", "units · row 8"], ["[", "units · row 6"]]) {
        await press(key);
        await press("f");
        if (!(await until(() => at() === want))) return key + "f went to " + at() + ", not " + want;
      }

      for (const key of ["g", "g", "[", "f"]) await press(key);
      const none = "nothing above row 1 in units fails to parse as a number";
      if (!(await until(() => text("#status-msg") === none))) {
        return "[f from row 1 says " + JSON.stringify(text("#status-msg"));
      }

      for (const key of ["0", "l", "]", "f"]) await press(key);
      const plain = text("#status-msg");
      return plain === "region is text · every value in it parses" ? "" : "]f on region says " + JSON.stringify(plain);
    `,
  },
  {
    name: "/ and ? search the column, and n and N search again",
    script: `
      const at = () => text("#status-cell");
      const input = document.querySelector("#status-cmd");
      if (at() !== "region · row 1") return "the selection is at " + at();

      const steps = [
        ["/North", "region · row 3"],
        ["n", "region · row 7"],
        ["N", "region · row 3"],
        ["?West", "region · row 1"],
      ];
      for (const [step, want] of steps) {
        await press(step[0]);
        if (step.length > 1) {
          if (input.hidden || input.value !== step[0]) return step[0] + " did not open the command line";
          input.value = step;
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          await frame();
        }
        if (!(await until(() => at() === want))) return step + " went to " + at() + ", not " + want;
      }

      // ?West searched up, so n does too, from the top.
      await press("n");
      const none = '"West" is not above row 1 in region';
      return (await until(() => text("#status-msg") === none))
        ? ""
        : "n from row 1 says " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    name: "Ctrl+r records again what u took back, once",
    script: `
      const region = () => document.querySelectorAll("tbody tr")[3].children[2].textContent;
      const edits = (n) => until(() => text("#status-file").includes(n + " edits"));

      await press("u"); // the apply ga recorded
      if (!(await edits(9))) return "status bar says: " + text("#status-file");
      if (!(await until(() => region() === "South"))) return "u left row 4 reading " + JSON.stringify(region());

      await press("r", { ctrlKey: true });
      if (!(await edits(10))) return "status bar says: " + text("#status-file");
      if (!(await until(() => region() === "South-q3"))) {
        return "Ctrl+r left row 4 reading " + JSON.stringify(region());
      }

      await press("r", { ctrlKey: true });
      const none = "there is nothing to redo";
      return (await until(() => text("#status-msg") === none))
        ? ""
        : "a second Ctrl+r says " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    // A check that fails here opens the file dialog instead, and the run times out.
    name: "Ctrl+O over unsaved edits says so, and opens nothing",
    send: ["menu:open"],
    script: `
      const warning = "unsaved edits · Ctrl+S first, or Ctrl+O again to drop them";
      if (!(await until(() => text("#status-msg") === warning))) {
        return "Ctrl+O over unsaved edits says " + JSON.stringify(text("#status-msg"));
      }
      // Moving says nothing, so the warning stays, and a second Ctrl+O would open.
      await press("j");
      if (text("#status-msg") !== warning) return "moving took the warning away";

      // Anything the status bar says next replaces the warning, and the next
      // Ctrl+O has to warn again.
      await press(":");
      const input = document.querySelector("#status-cmd");
      input.value = ":foo";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await frame();
      return text("#status-msg") === "not a command: :foo" ? "" : "the status bar says " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    name: "a Ctrl+O warning that was replaced is given again",
    send: ["menu:open"],
    script: `
      const warning = "unsaved edits · Ctrl+S first, or Ctrl+O again to drop them";
      return (await until(() => text("#status-msg") === warning))
        ? ""
        : "the second Ctrl+O says " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    name: "the empty state is out of the way once a file is open",
    script: `
      const empty = document.querySelector("#empty");
      const shown = empty.getClientRects().length > 0;
      return shown ? "the dropzone is still on screen behind the grid" : "";
    `,
  },
  {
    // Last, so a run leaves the strategy a person gets by default.
    name: "Edit → Input → Default reads keys the default way again, and is kept",
    send: ["menu:input", "default"],
    script: `
      if (!(await until(() => localStorage.getItem("uno.input") === "default"))) {
        return "the choice was not kept: " + JSON.stringify(localStorage.getItem("uno.input"));
      }
      // Esc on the grid is nobody's by default, so it no longer leaves transform.
      const mode = text("#status-mode");
      await press("Escape");
      return text("#status-mode") === mode ? "" : "Esc took the mode from " + mode + " to " + text("#status-mode");
    `,
  },
];

/**
 * What every check can call. A check's body runs in a block of its own, so one
 * that declares its own `frame` shadows this one rather than colliding with it.
 */
const PRELUDE = `
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const text = (selector) => document.querySelector(selector)?.textContent ?? "";
  // A key goes where a real one would: to the editor while it is open, to the
  // grid otherwise.
  const press = async (key, init = {}) => {
    const target = document.querySelector(".cell-editor") ?? document.querySelector("#content");
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    await frame();
  };
  const until = async (ok) => {
    for (let i = 0; i < 150 && !ok(); i++) await frame();
    return ok();
  };
`;

/**
 * run drives the window, reports to stdout, and quits with a status the shell
 * can read.
 *
 * The script for each check is evaluated in the renderer as an async function
 * body, so a check can wait a frame for the virtualiser to catch up -- which
 * several of them have to.
 */
export async function runSmoke(win: BrowserWindow, quit: (code: number) => void): Promise<void> {
  let failed = 0;

  // The window has loaded, but the fixture's first rows come from an engine a
  // moment later.
  await win.webContents.executeJavaScript(`
    (async () => {
      for (let i = 0; i < 120; i++) {
        if (document.querySelector("tbody tr:not(.pending)") !== null) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("no rows were ever drawn");
    })()
  `);

  // The input strategy outlives the window. A run stopped partway through the
  // vim-style checks would leave the next one reading keys the vim way, so every
  // run starts from the default.
  win.webContents.send("menu:input", "default");

  for (const check of CHECKS) {
    try {
      if (check.send !== undefined) win.webContents.send(...check.send);
      if (check.input !== undefined) {
        const { events } = check.input;
        const send = (): void => {
          for (const event of events) win.webContents.sendInputEvent(event);
        };
        if (check.input.through) through(win, send);
        else send();
      }
      const failure = (await win.webContents.executeJavaScript(
        `(async () => { ${PRELUDE} { ${check.script} } })()`,
      )) as string;

      if (failure === "") {
        console.log(`  ok   ${check.name}`);
      } else {
        console.error(`  FAIL ${check.name}: ${failure}`);
        failed++;
      }
    } catch (err) {
      console.error(`  FAIL ${check.name}: ${(err as Error).message}`);
      failed++;
    }
  }

  // A picture of the window, because a list of green ticks does not show
  // whether the thing is laid out like the design says.
  const shotDir = process.env["UNO_SMOKE"];
  if (shotDir !== undefined && shotDir !== "") {
    const image = await win.webContents.capturePage();
    const path = join(shotDir, "window.png");
    await writeFile(path, image.toPNG());
    console.log(`smoke: screenshot ${path}`);
  }

  if (failed === 0) console.log("smoke: all checks passed");
  else console.error(`smoke: ${failed} check(s) failed`);

  quit(failed === 0 ? 0 : 1);
}
