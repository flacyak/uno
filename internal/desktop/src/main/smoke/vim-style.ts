// Checks for vim-style input, then the checks that close the run. They pick up
// where default.ts leaves the window, and the last one hands it back to default.

import type { Check } from "./check.ts";

export const VIM_STYLE: Check[] = [
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

      document.querySelectorAll("tbody tr")[6].children[GUTTER + UNITS].click(); // units, row 7: 843
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
      const shown = document.querySelectorAll("tbody tr")[6].children[GUTTER + UNITS].textContent;
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
      const cell = () => document.querySelectorAll("tbody tr")[6].children[GUTTER + UNITS].textContent;
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
        [["G"], "units · row " + ROWS],
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
      if (at() !== "revenue · row " + ROWS) return "G went to " + at();
      await press("'");
      await press("a");
      if (at() !== marked) return "'a went to " + at() + ", not " + marked;
      await press("'");
      await press("'");
      if (at() !== "revenue · row " + ROWS) return "'' went to " + at();
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
      const cell = (row) => document.querySelectorAll("tbody tr")[row].children[GUTTER + UNITS].textContent;
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
      const cell = (row) => document.querySelectorAll("tbody tr")[row].children[GUTTER + UNITS].textContent;
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
      const region = (row) => document.querySelectorAll("tbody tr")[row].children[GUTTER + REGION].textContent;
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
      if (!(await until(() => !banner.hidden && banner.textContent.includes("region") && banner.textContent.includes((ROWS - 3).toLocaleString() + " cells")))) {
        return "the banner says " + JSON.stringify(banner.textContent);
      }

      for (const key of ["4", "l", "g", "a"]) await press(key); // from revenue
      const region = () => document.querySelectorAll("tbody tr")[3].children[GUTTER + REGION].textContent;
      if (!(await until(() => region() === "South-q3"))) return "row 4 reads " + JSON.stringify(region());
      if (!(await until(() => text("#status-file").includes("10 edits")))) {
        return "status bar says: " + text("#status-file");
      }
      // The three fixes the offer was learned from are left as they were typed.
      const fixed = [0, 1, 2].map((r) => document.querySelectorAll("tbody tr")[r].children[GUTTER + REGION].textContent);
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
      const region = () => document.querySelectorAll("tbody tr")[3].children[GUTTER + REGION].textContent;
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
