/**
 * @fileoverview Checks that a chart's schedule reads its file again on time in
 * the real app: a workspace whose chart checks its file every minute opens,
 * smoke.js adds a row, and the chart draws it once the minute is up, saying
 * nothing and leaving the workspace clean. They run last, as they wait on the clock.
 */

import { CHECK_TIMEOUT_MS, MINUTE_MS } from "@renderer/timing";
import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of one chart that checks its file every minute. */
const SCHEDULED = process.env["UNO_SMOKE_SCHEDULED"] ?? "";

/** How long the new row may take: the schedule's minute, and the check's own limit. */
const DUE_MS = MINUTE_MS + CHECK_TIMEOUT_MS;

/** The rows smoke.js writes in the scheduled file, before it adds one. */
const FILE_ROWS = 2;

/** Helpers: the chart's caption. */
const SAID = `const said = () => text(".chart .chart-said");`;

export const CHART_SCHEDULE: Check[] = [
  {
    name: "a workspace whose chart checks its file every minute opens on the file's two rows",
    send: ["menu:open-path", SCHEDULED],
    script: `
      ${SAID}
      return (await arrives(() => said().startsWith("${FILE_ROWS} rows"))) ? "" : "the chart says " + JSON.stringify(said());
    `,
  },
  {
    name: "the row smoke.js adds is drawn once the minute is up, with nothing said and the workspace clean",
    ask: "grow",
    script: `
      ${SAID}
      const before = text("#status-msg");
      // The first check found the file as it was read, and nothing reads it
      // again before the minute is up.
      if (await until(() => said().startsWith("${FILE_ROWS + 1} rows"))) return "the row came before the minute was up";
      const start = performance.now();
      while (!said().startsWith("${FILE_ROWS + 1} rows")) {
        if (performance.now() - start > ${DUE_MS}) return "after the minute the chart says " + JSON.stringify(said());
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (text("#status-msg") !== before) return "the status bar says " + JSON.stringify(text("#status-msg"));
      return document.querySelector(".ws.open .dirty") === null ? "" : "the workspace has a dot";
    `,
  },
];
