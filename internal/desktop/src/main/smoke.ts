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

interface Check {
  name: string;
  /** Runs in the renderer. Returns a message on failure, or "" when it passes. */
  script: string;
}

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
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const rows = [...document.querySelectorAll("tbody tr")];
      const last = rows[rows.length - 1];
      const gutter = last.children[0].textContent;
      const inDom = rows.length;

      return gutter === "4812" && inDom < 120
        ? ""
        : "last gutter is " + gutter + " with " + inDom + " rows in the DOM";
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

      const shown = document.querySelectorAll("tbody tr")[0].children[5].textContent;
      const dirty = document.querySelector(".tab .dirty") !== null;
      const status = document.querySelector("#status-file").textContent;

      if (shown !== "1204") return "the cell shows " + JSON.stringify(shown);
      if (!dirty) return "the tab is not marked dirty";
      if (!status.includes("1 edit")) return "status bar says: " + status;
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
    name: "the empty state is out of the way once a file is open",
    script: `
      const empty = document.querySelector("#empty");
      const shown = empty.getClientRects().length > 0;
      return shown ? "the dropzone is still on screen behind the grid" : "";
    `,
  },
];

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

  // The window has loaded, but the fixture arrives over IPC a moment later.
  await win.webContents.executeJavaScript(`
    (async () => {
      for (let i = 0; i < 120; i++) {
        if (document.querySelector("tbody tr") !== null) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("no rows were ever drawn");
    })()
  `);

  for (const check of CHECKS) {
    try {
      const failure = (await win.webContents.executeJavaScript(
        `(async () => { ${check.script} })()`,
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
