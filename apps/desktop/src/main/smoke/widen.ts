/**
 * @fileoverview Checks that the grid takes the columns a file shows as it is
 * indexed: a JSON Lines file whose late events hold a key the first ones
 * lack opens with the keys its first lines hold, the late key arrives as a
 * column with its badge while the selection stays on its cell, the late
 * events show it, an edit in it lands, and the workspace saved and opened
 * again has the late key's column and the edit on its cell.
 *
 * The file is reached through the workspace smoke.js wrote, which says it
 * was read as JSON Lines. They run over the workspace again.ts leaves open,
 * which has nothing unsaved, so it gives way at once.
 */

import type { Check } from "./check.ts";
import { EVENTS, EVENT_KEYS, LATE_KEY, eventLine } from "./events.ts";

/** The workspace over the events. smoke.js names it. */
const WORKSPACE = process.env["UNO_SMOKE_EVENTS"] ?? "";

/** The columns before the late key arrives, and after. */
const BEFORE = EVENT_KEYS;
const AFTER = [...EVENT_KEYS, LATE_KEY];

/** The cell the selection is left on before the key arrives: page, row 3. */
const PICKED_ROW = 2;
const PAGE = EVENT_KEYS.indexOf("page");
const PICKED = `page · row ${PICKED_ROW + 1}`;

/** The last event's cells, as the grid shows them: each value as written. */
const LAST = Object.values(JSON.parse(eventLine(EVENTS - 1)) as Record<string, unknown>).map(
  String,
);

/** How far a drawn edge may sit from where it is meant to, in pixels. */
const PIXEL = 1;

/** What the edit in the late key's column writes. */
const EDITED = "spring-sale";

/** Helpers over the header, beside the PRELUDE's. */
const HEADER = `
  const headers = () => [...document.querySelectorAll("thead th .colname")].map((n) => n.textContent);
  const badges = () => [...document.querySelectorAll("thead th .badge")].map((b) => b.textContent);
  const shown = (list) => JSON.stringify(list);
  const sel = () => document.querySelector("tbody td.sel");
`;

/**
 * Helpers over the grid's foot, beside the PRELUDE's. The late rows are
 * wider than the grid, so a scrollbar along its foot arrives with them and
 * the end is that much further down: atEnd scrolls to it again and holds the
 * last row to the foot, so the picture shows it whole.
 */
const END = `
  const scroller = document.querySelector(".grid-scroll");
  const last = () => [...document.querySelectorAll("tbody tr:not(.pending)")].at(-1);
  const foot = () => scroller.getBoundingClientRect().top + scroller.clientHeight;
  const atEnd = async () => {
    scroller.scrollTop = scroller.scrollHeight;
    const ends = () => Math.abs(last().getBoundingClientRect().bottom - foot()) < ${PIXEL};
    return (await until(ends)) ? "" : "the last row ends at " + last().getBoundingClientRect().bottom + ", not at the grid's foot, " + foot();
  };
`;

export const WIDEN: Check[] = [
  {
    name: "a JSON Lines file a workspace says was read that way opens with the keys its first lines hold",
    send: ["menu:open-path", WORKSPACE],
    // Taken while the file is indexed, as a rule: the key arrives about two
    // seconds after it opens.
    shot: "widen-before",
    script: `
      ${HEADER}
      const opened = () => text("#status-file").includes("JSON Lines") && document.querySelector("tbody tr:not(.pending)") !== null;
      if (!(await arrives(opened))) {
        return "the status bar says " + JSON.stringify(text("#status-file")) + " · " + JSON.stringify(text("#status-msg"));
      }
      if (headers().includes(${JSON.stringify(LATE_KEY)})) {
        return "the late key was known before the first rows were drawn, so it never arrived as the file was indexed";
      }
      if (shown(headers()) !== ${JSON.stringify(JSON.stringify(BEFORE))}) return "the header is " + shown(headers());
      if (!text("#status-file").includes("${BEFORE.length} columns")) return "the status bar says " + JSON.stringify(text("#status-file"));

      document.querySelectorAll("tbody tr")[${PICKED_ROW}].children[GUTTER + ${PAGE}].click();
      await frame();
      return text("#status-cell") === ${JSON.stringify(PICKED)} ? "" : "the selection is at " + text("#status-cell");
    `,
  },
  {
    name: "the key first seen late arrives as a column with its badge, and the selection stays on its cell",
    shot: "widen-arrived",
    script: `
      ${HEADER}
      if (!(await arrives(() => headers().length > ${BEFORE.length}))) return "the header is still " + shown(headers());
      if (shown(headers()) !== ${JSON.stringify(JSON.stringify(AFTER))}) return "the header is " + shown(headers());
      if (badges().length !== ${AFTER.length}) return "the badges are " + shown(badges());
      if (badges().at(-1) !== "text") return "the new column's badge says " + JSON.stringify(badges().at(-1));
      if (!text("#status-file").includes("${AFTER.length} columns")) return "the status bar says " + JSON.stringify(text("#status-file"));
      if (text("#status-cell") !== ${JSON.stringify(PICKED)}) return "the selection moved to " + text("#status-cell");

      // Every drawn row has a cell under each header, the selected one is the
      // cell picked, and the new column is blank above the late events.
      const rows = [...document.querySelectorAll("tbody tr")];
      const short = rows.find((r) => r.children.length !== GUTTER + ${AFTER.length});
      if (short !== undefined) return "a row has " + short.children.length + " cells";
      if (sel() !== rows[${PICKED_ROW}].children[GUTTER + ${PAGE}]) return "the selected cell is another";
      if (rows[${PICKED_ROW}].children[GUTTER + ${BEFORE.length}].textContent !== "") return "the new column is filled above the late events";
      const heads = [...document.querySelectorAll("thead th")];
      const off = heads.findIndex((th, i) => th.getBoundingClientRect().left !== rows[0].children[i].getBoundingClientRect().left);
      return off === -1 ? "" : "header cell " + off + " is not over its column";
    `,
  },
  {
    name: "the late events show the key in its column once the file is indexed",
    shot: "widen-late",
    script: `
      ${END}
      const done = () => text("#status-file").startsWith(counted(${EVENTS}) + " rows");
      if (!(await arrives(done))) return "the status bar says " + JSON.stringify(text("#status-file"));
      scroller.scrollTop = scroller.scrollHeight;
      const cells = () => [...(last()?.children ?? [])].slice(GUTTER).map((c) => c.textContent);
      const want = ${JSON.stringify(JSON.stringify(LAST))};
      if (!(await arrives(() => JSON.stringify(cells()) === want))) {
        return "the last row drawn is " + JSON.stringify(last()?.children[0].textContent) + ": " + JSON.stringify(cells());
      }
      return atEnd();
    `,
  },
  {
    name: "an edit in the late key's column lands on its cell",
    shot: "widen-edited",
    script: `
      ${HEADER}
      await press("e", { ctrlKey: true });
      if (!(await until(() => text("#status-mode") === "TRANSFORM"))) return "the mode is " + text("#status-mode");
      const rows = [...document.querySelectorAll("tbody tr:not(.pending)")];
      const cell = rows.at(-1).children[GUTTER + ${BEFORE.length}];
      cell.click();
      await frame();
      if (sel() !== cell) return "the click selected another cell";
      await press("Enter");
      const editor = document.querySelector(".cell-editor");
      if (editor === null) return "Enter opened no editor";
      editor.value = ${JSON.stringify(EDITED)};
      await press("Enter");
      if (!(await until(() => text("#status-file").includes("1 edit")))) return "the status bar says " + JSON.stringify(text("#status-file"));
      return sel()?.textContent === ${JSON.stringify(EDITED)} ? "" : "the cell shows " + JSON.stringify(sel()?.textContent);
    `,
  },
  {
    name: "the workspace saves over the one it was opened from",
    send: ["menu:save"],
    script: `
      if (!(await arrives(() => text("#status-msg").startsWith("saved ")))) {
        return "saving says " + JSON.stringify(text("#status-msg"));
      }
      const path = text("#status-msg").slice("saved ".length);
      return path === ${JSON.stringify(WORKSPACE)} ? "" : "saved to " + JSON.stringify(path);
    `,
  },
  {
    name: "the saved workspace opens again as JSON Lines, with the late key's column and the edit on its cell",
    send: ["menu:open-path", WORKSPACE],
    shot: "widen-reopened",
    script: `
      ${HEADER}
      ${END}
      // A load that works clears the status line the save left.
      if (!(await arrives(() => text("#status-msg") === ""))) return "reopening says " + JSON.stringify(text("#status-msg"));
      const opened = () => text("#status-file").includes("JSON Lines") && text("#status-file").includes("1 edit");
      if (!(await arrives(opened))) return "the status bar says " + JSON.stringify(text("#status-file"));
      if (shown(headers()) !== ${JSON.stringify(JSON.stringify(AFTER))}) return "the header is " + shown(headers());

      // The edit is on the last event, in the late key's column.
      scroller.scrollTop = scroller.scrollHeight;
      const cell = () => last()?.children[GUTTER + ${BEFORE.length}]?.textContent;
      if (!(await arrives(() => cell() === ${JSON.stringify(EDITED)}))) {
        return "the last row drawn is " + JSON.stringify(last()?.children[0].textContent) + ", its " + ${JSON.stringify(LATE_KEY)} + " " + JSON.stringify(cell());
      }
      if (last().children[0].textContent !== counted(${EVENTS})) return "the last row drawn is " + last().children[0].textContent;
      return atEnd();
    `,
  },
];
