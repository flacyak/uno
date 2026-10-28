/**
 * @fileoverview Checks that a workspace saying its source was read as Parquet
 * opens it as Parquet: the status bar counts every row at once and names the
 * file's codecs and row groups, and the grid shows the rows its CSV twin
 * does.
 *
 * They run last, over the fresh workspace again.ts leaves open.
 */

import type { Check } from "./check.ts";
import { COLS, ROWS, counted } from "./fixture.ts";

/** The workspace smoke.js wrote over the Parquet fixture, sales-q3.snappy.parquet. */
const HELD = process.env["UNO_SMOKE_PARQUET"] ?? "";

/** The rows in each row group of the fixture, as core/scripts/fixtures.ts writes it. */
const GROUP_ROWS = 1000;

/** How many row groups the fixture's rows make. */
const GROUPS = Math.ceil(ROWS / GROUP_ROWS);

/** What the status bar says of the fixture read as Parquet. */
const STATUS = `${counted(ROWS)} rows · ${COLS} columns · Parquet · snappy · ${GROUPS} row groups`;

/** The fixture's first row as sales-q3.csv reads it. */
const FIRST = ["2026-07-01", "West", "Ada Okafor", "direct", "1,204", "48160.00"];

export const PARQUET: Check[] = [
  {
    name: "a workspace that says its source was read as Parquet opens it so, every row counted",
    send: ["menu:open-path", HELD],
    shot: "parquet-held",
    run: async (page) => {
      if (!(await page.until([{ selector: "#status-file", includes: STATUS }]))) {
        return "the status bar says " + JSON.stringify(await page.text("#status-file"));
      }
      const [row] = await page.rows();
      const cells = row?.cells ?? [];
      return JSON.stringify(cells) === JSON.stringify(FIRST)
        ? ""
        : "the first row is " + JSON.stringify(cells);
    },
  },
];
