/**
 * @fileoverview Checks that uno runs once: a second uno started on a file while
 * this window is open hands the file over and exits, and the window opens it.
 *
 * The second uno is a real one, started by smoke.js on the same user data
 * folder when a check asks. Over unsaved edits the window says so first,
 * and the file named again opens.
 *
 * They run over the workspace sidebar.ts leaves open, and put an edit in
 * it first.
 */

import type { Check } from "./check.ts";
import { UNITS } from "./fixture.ts";

/** The second export, which the second uno is started on. */
const ADS = process.env["UNO_SMOKE_SOURCE"] ?? "";

/** The names in the sidebar's list of workspaces. */
const NAMES = `
  const names = (selector) => [...document.querySelectorAll(selector)].map((w) => w.querySelector(".name").textContent);
`;

export const AGAIN: Check[] = [
  {
    name: "an edit in the open workspace, for the second uno to run into",
    run: async (page) => {
      await page.clickCell(0, UNITS);
      await page.settle(1);
      await page.press("Enter");
      await page.setEditorValue("1203");
      await page.press("Enter");
      await page.until([{ selector: "#status-file", includes: "1 edit" }]);
      return (await page.count(".ws.open .dirty")) === 0 ? "the workspace has no dirty dot" : "";
    },
  },
  {
    name: "a second uno started on a file exits, and over unsaved edits this window says so",
    ask: `again ${ADS}`,
    script: `
      ${NAMES}
      const want = "unsaved edits · Ctrl+S first, or open it again to drop them";
      if (!(await until(() => text("#status-msg") === want))) return "the status bar says " + JSON.stringify(text("#status-msg"));
      return names(".ws.open")[0] === "sales-q3" ? "" : "the open workspace is " + JSON.stringify(names(".ws.open"));
    `,
  },
  {
    name: "the file named again opens in this window as a new workspace",
    ask: `again ${ADS}`,
    shot: "again-opened",
    script: `
      ${NAMES}
      if (!(await arrives(() => names(".ws.open")[0] === "google-ads-sales"))) {
        return "the open workspace is " + JSON.stringify(names(".ws.open")) + " · " + JSON.stringify(text("#status-msg"));
      }
      const meta = document.querySelector(".ws.open .meta").textContent;
      if (meta !== "not saved") return "the new workspace says " + JSON.stringify(meta);
      return document.querySelectorAll(".tab").length === 1 ? "" : "it has " + document.querySelectorAll(".tab").length + " sources";
    `,
  },
  {
    name: "a second uno started on no file exits, and leaves the window as it is",
    ask: "again",
    script: `
      ${NAMES}
      await frame();
      return names(".ws.open")[0] === "google-ads-sales" ? "" : "the open workspace is " + JSON.stringify(names(".ws.open"));
    `,
  },
];
