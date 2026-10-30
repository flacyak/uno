/**
 * @fileoverview Checks that a JSON Lines file added by path opens as JSON
 * Lines: the status bar names the format, and the grid shows a column for
 * each key the file holds, in the order it meets them, with the first event
 * laid out under them.
 *
 * It runs last, after the Parquet check, since it adds a tab.
 */

import { join } from "node:path";

import type { Check } from "./check.ts";
import { counted } from "./fixture.ts";

/** The core's test files. smoke.js names the folder. */
const TESTDATA = process.env["UNO_SMOKE_TESTDATA"] ?? "";

/** The core's JSON Lines fixture: eight page events, nested under user. */
const EVENTS = "events.jsonl";
const EVENT_ROWS = 8;

/** The keys the fixture holds, in the order its lines first hold them. */
const KEYS = [
  "id",
  "at",
  "user.id",
  "user.country",
  "event",
  "page",
  "ms",
  "target",
  "query",
  "plan",
  "seats",
];

/** The first event, under KEYS. The keys from target on arrive with later events. */
const FIRST = [
  "1",
  "2026-07-01T09:14:03Z",
  "u-1042",
  "PT",
  "view",
  "/pricing",
  "412",
  "",
  "",
  "",
  "",
];

export const LINES: Check[] = [
  {
    name: "a JSON Lines file added by path opens as JSON Lines, a column per key",
    send: ["menu:add-paths", [join(TESTDATA, EVENTS)]],
    shot: "jsonl-added",
    run: async (page) => {
      // The rows are drawn again once the pass has found every key, so the
      // first id is waited for beside the status.
      const want = [
        { selector: "#status-file", includes: "UTF-8 · JSON Lines" },
        { selector: "#status-file", includes: counted(EVENT_ROWS) + " rows" },
        { row: 0, col: 0, equals: FIRST[0]! },
      ];
      if (!(await page.until(want))) {
        return "the status bar says " + JSON.stringify(await page.text("#status-file"));
      }
      const heads = await page.ownText("thead th .colhead");
      if (JSON.stringify(heads) !== JSON.stringify(KEYS)) {
        return "the headers are " + JSON.stringify(heads);
      }
      const [row] = await page.rows();
      const cells = row?.cells ?? [];
      return JSON.stringify(cells) === JSON.stringify(FIRST)
        ? ""
        : "the first row is " + JSON.stringify(cells);
    },
  },
];
