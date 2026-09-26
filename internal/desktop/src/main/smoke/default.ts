// Checks for the default input: transform, editing, the recogniser's offer, and
// undo and redo. They pick up where open.ts leaves the window.

import type { Check } from "./check.ts";
import { COMMAS_LEFT, UNITS } from "./fixture.ts";

export const DEFAULT_INPUT: Check[] = [
  {
    name: "Ctrl+E switches to transform",
    run: async (page) => {
      await page.press("e", { ctrlKey: true });
      await page.until([{ selector: "#status-mode", equals: "TRANSFORM" }]);
      await page.settle(1);

      const mode = await page.text("#status-mode");
      if (mode !== "TRANSFORM") return "the mode is still " + mode;
      const on = await page.text(".seg .on");
      return on === "Transform" ? "" : "the switch shows " + JSON.stringify(on);
    },
  },
  {
    name: "typing into a cell records an edit",
    run: async (page) => {
      await page.clickCell(0, UNITS);
      await page.settle(1);

      // Enter opens the editor over the selected cell, the way it does in the
      // Go build's grid.
      await page.press("Enter");

      const opened = await page.editorValue();
      if (opened === undefined) return "Enter did not open an editor";
      if (opened !== "1,204") return "the editor started at " + JSON.stringify(opened);

      await page.setEditorValue("1204");
      await page.press("Enter");

      // The value shows before the engine has recorded it.
      const shown = (await page.rows())[0]?.cells[UNITS] ?? "";
      if (shown !== "1204") return "the cell shows " + JSON.stringify(shown);

      await page.until([{ selector: "#status-file", includes: "1 edit" }]);
      const status = await page.text("#status-file");
      if (!status.includes("1 edit")) return "status bar says: " + status;
      return (await page.count(".tab .dirty")) === 0 ? "the tab is not marked dirty" : "";
    },
  },
  {
    name: "the editor closes when the edit is committed",
    run: async (page) => {
      await page.clickCell(1, UNITS);
      await page.settle(1);

      await page.press("Enter");
      if ((await page.count(".cell-editor")) !== 1) return "Enter did not open one editor";

      await page.setEditorValue("987");
      await page.press("Enter");

      // Committing used to leave the Enter free to reach the grid, which read
      // it as "start editing" and reopened an editor over the cell.
      const open = await page.count(".cell-editor");
      return open === 0 ? "" : open + " editor(s) still open after committing";
    },
  },
  {
    name: "three fixes bring an offer, and Apply is one edit",
    run: async (page) => {
      const type = async (row: number, value: string): Promise<void> => {
        await page.clickCell(row, UNITS);
        await page.settle(2);
        await page.press("Enter");
        await page.setEditorValue(value);
        await page.press("Enter");
      };

      // Row 1 was fixed by the check before last. These are the second and third.
      await type(2, "1455");
      await type(4, "2038");

      await page.until([
        { selector: "#banner", includes: COMMAS_LEFT.toLocaleString() + " cells" },
      ]);
      if (await page.hidden("#banner")) return "no banner after three fixes";
      const bannerText = await page.text("#banner");
      if (!bannerText.includes("remove commas · " + COMMAS_LEFT.toLocaleString() + " cells")) {
        return "the banner says " + JSON.stringify(bannerText);
      }

      await page.click("#banner button.primary");
      await page.until([
        { row: 5, col: UNITS, equals: "1101" },
        { selector: "#status-file", includes: "4 edits" },
      ]);
      const cell = (await page.rows())[5]?.cells[UNITS] ?? "";
      const status = await page.text("#status-file");
      if (cell !== "1101") return "row 6 still shows " + JSON.stringify(cell);
      if (!status.includes("4 edits")) return "status bar says: " + status;

      const badge = (await page.allText("thead th .badge"))[UNITS] ?? "";
      if (badge !== "num") return "the units badge says " + badge;
      return (await page.hidden("#banner")) ? "" : "the banner stayed after Apply";
    },
  },
  {
    name: "Ctrl+Z takes the apply back",
    run: async (page) => {
      await page.press("z", { ctrlKey: true });
      await page.until([
        { row: 5, col: UNITS, equals: "1,101" },
        { selector: "#status-file", includes: "3 edits" },
      ]);
      const cell = (await page.rows())[5]?.cells[UNITS] ?? "";
      const status = await page.text("#status-file");
      if (cell !== "1,101") return "row 6 shows " + JSON.stringify(cell);
      return status.includes("3 edits") ? "" : "status bar says: " + status;
    },
  },
  {
    name: "by default, typing over a cell replaces it and Esc throws the typing away",
    run: async (page) => {
      await page.clickCell(6, UNITS); // units, row 7: 843
      await page.settle(2);

      await page.press("9");
      const typed = await page.editorValue();
      if (typed === undefined) return "typing did not open an editor";
      if (typed !== "9") return "the editor holds " + JSON.stringify(typed);
      const mode = await page.text("#status-mode");
      if (mode !== "TRANSFORM") return "the mode is " + mode;

      await page.press("Escape");
      if ((await page.editorValue()) !== undefined) return "Esc left the editor open";
      const cell = (await page.rows())[6]?.cells[UNITS] ?? "";
      if (cell !== "843") return "Esc kept the typing: the cell shows " + JSON.stringify(cell);
      const status = await page.text("#status-file");
      return status.includes("3 edits") ? "" : "status bar says: " + status;
    },
  },
  {
    name: "by default, Ctrl+R records again what Ctrl+Z took back",
    run: async (page) => {
      await page.press("r", { ctrlKey: true });
      const redone = await page.until([
        { selector: "#status-file", includes: "4 edits" },
        { row: 5, col: UNITS, equals: "1101" },
      ]);
      if (!redone) {
        const cell = (await page.rows())[5]?.cells[UNITS] ?? "";
        const status = await page.text("#status-file");
        return "after Ctrl+R row 6 shows " + JSON.stringify(cell) + ", status bar: " + status;
      }

      // Taken back again, so the checks after this one start where they expect.
      await page.press("z", { ctrlKey: true });
      const undone = await page.until([
        { selector: "#status-file", includes: "3 edits" },
        { row: 5, col: UNITS, equals: "1,101" },
      ]);
      if (undone) return "";
      const cell = (await page.rows())[5]?.cells[UNITS] ?? "";
      return "Ctrl+Z after Ctrl+R left row 6 showing " + JSON.stringify(cell);
    },
  },
];
