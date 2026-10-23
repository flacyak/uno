/**
 * @fileoverview Checks that the grid takes the columns a file shows as it is
 * indexed: a JSON Lines file whose late events hold a key the first ones
 * lack opens with the keys its first lines hold, and the late key arrives as
 * a column with its badge while the selection stays on its cell.
 *
 * The file is reached through the workspace smoke.js wrote, which says it
 * was read as JSON Lines. They run over the workspace again.ts leaves open,
 * which has nothing unsaved, so it gives way at once.
 */

import type { Check } from "./check.ts";
import { EVENT_KEYS, LATE_KEY } from "./events.ts";

/** The workspace over the events. smoke.js names it. */
const WORKSPACE = process.env["UNO_SMOKE_EVENTS"] ?? "";

/** The columns before the late key arrives, and after. */
const BEFORE = EVENT_KEYS;
const AFTER = [...EVENT_KEYS, LATE_KEY];

/** The cell the selection is left on before the key arrives: page, row 3. */
const PICKED_ROW = 2;
const PAGE = EVENT_KEYS.indexOf("page");
const PICKED = `page · row ${PICKED_ROW + 1}`;

/** Helpers over the header, beside the PRELUDE's. */
const HEADER = `
  const headers = () => [...document.querySelectorAll("thead th .colname")].map((n) => n.textContent);
  const badges = () => [...document.querySelectorAll("thead th .badge")].map((b) => b.textContent);
  const shown = (list) => JSON.stringify(list);
  const sel = () => document.querySelector("tbody td.sel");
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
];
