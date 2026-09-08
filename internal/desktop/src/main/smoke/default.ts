// Checks for the default input: transform, editing, the recogniser's offer, and
// undo and redo. They pick up where open.ts leaves the window.

import type { Check } from "./check.ts";

export const DEFAULT_INPUT: Check[] = [
  {
    name: "Ctrl+E switches to transform",
    script: `
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true }));
      const mode = document.querySelector("#status-mode");
      for (let i = 0; i < TRIES && mode.textContent !== "TRANSFORM"; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
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
      const cell = document.querySelectorAll("tbody tr")[0].children[GUTTER + UNITS];
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
      const shown = document.querySelectorAll("tbody tr")[0].children[GUTTER + UNITS].textContent;
      if (shown !== "1204") return "the cell shows " + JSON.stringify(shown);

      let status = "";
      for (let i = 0; i < TRIES; i++) {
        status = document.querySelector("#status-file").textContent;
        if (status.includes("1 edit")) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
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
      const cell = document.querySelectorAll("tbody tr")[1].children[GUTTER + UNITS];
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
        document.querySelectorAll("tbody tr")[row].children[GUTTER + UNITS].click();
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
      for (let i = 0; i < TRIES && !(banner.textContent.includes(COMMAS_LEFT.toLocaleString() + " cells")); i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (banner.hidden) return "no banner after three fixes";
      if (!banner.textContent.includes("remove commas · " + COMMAS_LEFT.toLocaleString() + " cells")) {
        return "the banner says " + JSON.stringify(banner.textContent);
      }

      banner.querySelector("button.primary").click();
      let cell = "";
      let status = "";
      for (let i = 0; i < TRIES; i++) {
        await frame();
        cell = document.querySelectorAll("tbody tr")[5].children[GUTTER + UNITS].textContent;
        status = document.querySelector("#status-file").textContent;
        if (cell === "1101" && status.includes("4 edits")) break;
      }
      if (cell !== "1101") return "row 6 still shows " + JSON.stringify(cell);
      if (!status.includes("4 edits")) return "status bar says: " + status;

      const badge = document.querySelectorAll("thead th .badge")[UNITS].textContent;
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
      for (let i = 0; i < TRIES; i++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        cell = document.querySelectorAll("tbody tr")[5].children[GUTTER + UNITS].textContent;
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
      const cell = () => document.querySelectorAll("tbody tr")[6].children[GUTTER + UNITS].textContent;
      document.querySelectorAll("tbody tr")[6].children[GUTTER + UNITS].click(); // units, row 7: 843
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
      const cell = () => document.querySelectorAll("tbody tr")[5].children[GUTTER + UNITS].textContent;
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
];
