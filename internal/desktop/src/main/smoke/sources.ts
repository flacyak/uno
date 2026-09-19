// Checks that a workspace holds more than one source: a second export added
// beside the first, a tab for each, moving between them, and taking one out.
//
// They run last, over the fixture the checks before them left edited.

import type { Check } from "./check.ts";

/**
 * The second export: the Google Ads sample the CPA plan measures. smoke.js
 * names it, since only it knows where the fixtures are.
 */
const ADS = process.env["UNO_SMOKE_SOURCE"] ?? "";

export const SOURCES: Check[] = [
  {
    name: "one source has no × to remove it with",
    script: `
      window.smokeCell = text("#status-cell");
      const tabs = document.querySelectorAll(".tab");
      if (tabs.length !== 1) return tabs.length + " tabs before any source was added";
      return document.querySelector(".tab .close") === null ? "" : "the only source can be removed";
    `,
  },
  {
    name: "a second export is added as a source beside the first",
    send: ["menu:add-paths", [ADS]],
    script: `
      if (!(await until(() => document.querySelectorAll(".tab").length === 2))) {
        return "the strip has " + document.querySelectorAll(".tab").length + " tabs · " + text("#status-msg");
      }
      const active = document.querySelector(".tab.active").textContent;
      if (!active.startsWith("google-ads-sales.csv")) return "the tab showing is " + JSON.stringify(active);
      if (!(await until(() => text("#status-file").startsWith("2,600 rows")))) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      const first = document.querySelector("thead th .colhead").firstChild.textContent;
      return first === "Ad_ID" ? "" : "the first header is " + JSON.stringify(first);
    `,
  },
  {
    name: "the new source is unsaved, and the first keeps its own dot",
    script: `
      const dots = [...document.querySelectorAll(".tab")].map((t) => t.querySelector(".dirty") !== null);
      return JSON.stringify(dots) === "[true,true]" ? "" : "dirty dots are " + JSON.stringify(dots);
    `,
  },
  {
    name: "Ctrl+PageUp goes back to the first source, where it was left",
    script: `
      await press("PageUp", { ctrlKey: true });
      const active = document.querySelector(".tab.active").textContent;
      if (!active.startsWith("sales-q3.csv")) return "the tab showing is " + JSON.stringify(active);
      if (!text("#status-file").startsWith(ROWS.toLocaleString() + " rows")) {
        return "the status bar says " + JSON.stringify(text("#status-file"));
      }
      return text("#status-cell") === window.smokeCell
        ? ""
        : "the selection came back at " + text("#status-cell") + ", not " + window.smokeCell;
    `,
  },
  {
    name: "a click on a tab shows its source",
    script: `
      document.querySelector('.tab[data-source="google-ads-sales"]').click();
      await frame();
      const first = document.querySelector("thead th .colhead").firstChild.textContent;
      return first === "Ad_ID" ? "" : "the first header is " + JSON.stringify(first);
    `,
  },
  {
    name: "× takes out a source with no edits at once",
    script: `
      document.querySelector('.tab[data-source="google-ads-sales"] .close').click();
      if (!(await until(() => document.querySelectorAll(".tab").length === 1))) {
        return "the strip still has " + document.querySelectorAll(".tab").length + " tabs";
      }
      const active = document.querySelector(".tab.active").textContent;
      if (!active.startsWith("sales-q3.csv")) return "the tab showing is " + JSON.stringify(active);
      return text("#status-msg") === "removed google-ads-sales.csv"
        ? ""
        : "the status bar says " + JSON.stringify(text("#status-msg"));
    `,
  },
];
