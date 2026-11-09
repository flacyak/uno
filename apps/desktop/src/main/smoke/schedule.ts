/**
 * @fileoverview Checks that a chart's schedule reads its file again on time in
 * the real app: a workspace whose chart checks its file every minute opens,
 * its caption names the schedule and says when its first check was, smoke.js
 * adds a row, and the chart draws it once the minute is up, saying nothing and
 * leaving the workspace clean. A window of the least width keeps the plot's
 * count and the schedule whole, and one of the default width the line that
 * says edits hold the newer data back, in every language. They run last, as
 * they wait on the clock.
 */

import { m } from "@paraglide/messages";
import { DEFAULT_WIDTH, MIN_WIDTH } from "@renderer/chart/place";
import { offered } from "@renderer/language";
import { CHECK_TIMEOUT_MS, MINUTE_MS } from "@renderer/timing";
import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of one chart that checks its file every minute. */
const SCHEDULED = process.env["UNO_SMOKE_SCHEDULED"] ?? "";

/** How long the new row may take: the schedule's minute, and the check's own limit. */
const DUE_MS = MINUTE_MS + CHECK_TIMEOUT_MS;

/** The rows smoke.js writes in the scheduled file, before it adds one. */
const FILE_ROWS = 2;

/** The edits the amendment's held line counts. */
const HELD_EDITS = 12;

/** The held line, in each language a person can choose. */
const HELD = offered(false).map((locale) =>
  m.chart_held({ edits: m.edits_count({ count: HELD_EDITS }, { locale }) }, { locale }),
);

/** Helpers: the chart's caption. */
const SAID = `const said = () => text(".chart .chart-said");`;

export const CHART_SCHEDULE: Check[] = [
  {
    name: "a workspace whose chart checks its file every minute opens on the file's two rows, and says when it checked",
    send: ["menu:open-path", SCHEDULED],
    shot: "chart-schedule",
    script: `
      ${SAID}
      if (!(await arrives(() => said().startsWith("${FILE_ROWS} rows")))) return "the chart says " + JSON.stringify(said());
      // The check as the workspace opens says its time at the caption's right
      // end, between the words of the plot and the grip.
      const checks = () => text(".chart .chart-checks");
      if (!(await arrives(() => /^every 1 min · checked \\d/.test(checks())))) return "the caption's right end says " + JSON.stringify(checks());
      const [plot, end, grip] = [".chart-said", ".chart-checks", ".chart-grip"].map((s) => document.querySelector(".chart " + s).getBoundingClientRect());
      const between = end.left >= plot.right && end.right <= grip.left;
      return between ? "" : "the right end stands from " + end.left + " to " + end.right + ", the grip at " + grip.left;
    `,
  },
  {
    name: "a window of the least width keeps the plot's count and the schedule whole, and one of the default width the held line, in every language",
    script: `
      const box = document.querySelector(".chart");
      const at = (s) => box.querySelector(s);
      const cut = (part) => part.scrollWidth > part.clientWidth;
      const [width, words, said] = [box.style.width, at(".chart-checks-when"), at(".chart-checks-when").textContent];
      box.style.width = "${MIN_WIDTH}px";
      await frame();
      const count = cut(at(".chart-said-before"));
      const past = at(".chart-every").getBoundingClientRect().right > at(".chart-grip").getBoundingClientRect().left;
      // What the caption says while edits hold the newer data back, in place of the schedule.
      box.style.width = "${DEFAULT_WIDTH}px";
      at(".chart-every").hidden = true;
      at(".chart-checks").classList.add("chart-checks-trouble");
      const held = [];
      for (const text of ${JSON.stringify(HELD)}) {
        words.textContent = text;
        if (cut(words)) held.push(text);
      }
      at(".chart-every").hidden = false;
      at(".chart-checks").classList.remove("chart-checks-trouble");
      [box.style.width, words.textContent] = [width, said];
      if (count || past) return "at the least width the count is cut: " + count + ", the schedule runs past the grip: " + past;
      return held.length === 0 ? "" : "cut: " + held.join(" · ");
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
