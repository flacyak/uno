/**
 * @fileoverview Checks that a source in a bucket knows when it is out of date:
 * a workspace whose export was rewritten since it was saved opens saying so,
 * one rewritten while it is open is marked when the window gets the focus back,
 * Reload reads the newer one with the edits replayed over it, and so does r on
 * a chart over it at the end of the run, then saying when it checked.
 *
 * They run after meets.ts, with acme-exports/2025/ connected, so the saved
 * workspace opens its object at once. smoke.js rewrites the object when a
 * check asks it to.
 */

import { join } from "node:path";

import { NEWER_AFTER_MS } from "@renderer/timing";
import type { Check, Input } from "./check.ts";

/** The workspace sources.ts saved, with the object in it. */
const SAVED = join(process.env["UNO_SMOKE"] ?? "", "sales-q3.uno");

/**
 * How long to wait for a focus that finds the bucket as it was: the page's
 * own wait before asking, and as long again for the HEAD to come back.
 */
const ASKED_MS = NEWER_AFTER_MS * 2;

/** The object the saved workspace points at, by its key in the stand-in. */
const KEY = "2025/ads-q3.csv";

/** A person's press of r, which refreshes the chart that has the keys. */
const PRESS_R: readonly Input[] = [
  { type: "keyDown", keyCode: "r" },
  { type: "keyUp", keyCode: "r" },
];

const LINE = `
  const line = (name) => [...document.querySelectorAll("#panel .panel-row")].find((r) => r.children[0]?.textContent === name);
  const tab = (name) => [...document.querySelectorAll(".tab")].find((t) => t.textContent.startsWith(name));
`;

export const REFRESH: Check[] = [
  {
    name: "an export written over at the same size reopens marked changed",
    ask: `rewrite ${KEY}`,
    send: ["menu:open-path", SAVED],
    shot: "refresh-changed",
    script: `
      ${LINE}
      if (!(await arrives(() => tab("ads-q3.csv")?.querySelector(".trouble") != null))) {
        return "the tabs are " + JSON.stringify([...document.querySelectorAll(".tab")].map((t) => t.textContent));
      }
      const why = tab("ads-q3.csv").querySelector(".trouble").title;
      const want = "ads-q3.csv is not the version the workspace was saved against · it is the same size";
      if (!why.startsWith(want)) return "the mark says " + JSON.stringify(why);
      await openPanel();
      if (!(await arrives(() => line("ads-q3.csv")?.children[1]?.textContent === "changed"))) {
        return "the line says " + JSON.stringify(line("ads-q3.csv")?.textContent);
      }
      // The mark leaves the tab as it was: the rows are there, and the status
      // bar says why the tab is marked.
      tab("ads-q3.csv").click();
      if (!(await arrives(() => document.querySelector("thead th .colhead") !== null))) return "no rows came";
      const status = () => text("#status-file");
      return (await arrives(() => status().endsWith(" · " + want))) ? "" : "the status bar says " + JSON.stringify(status());
    `,
  },
  {
    // Getting the focus back is when the bucket is asked, one HEAD per
    // object, and the rewritten one is marked.
    name: "replacing the object in the stand-in shows the mark on the next focus",
    ask: `rewrite ${KEY}`,
    shot: "refresh-newer",
    script: `
      ${LINE}
      const words = () => line("ads-q3.csv")?.children[1]?.textContent;
      if (words() !== "changed") return "before the focus the line says " + JSON.stringify(words());
      window.dispatchEvent(new Event("focus"));
      if (!(await arrives(() => words() === "newer in bucket"))) return "after the focus the line says " + JSON.stringify(words());
      const want = "a newer version is in the bucket · Reload reads it";
      const mark = tab("ads-q3.csv").querySelector(".trouble");
      if (mark === null || !mark.title.startsWith(want)) return "the mark says " + JSON.stringify(mark?.title);
      if (!text("#status-file").endsWith(want)) return "the status bar says " + JSON.stringify(text("#status-file"));
      // The mark opens the panel with the selection on its line, where Reload
      // is.
      mark.click();
      return (await until(() => foot()[0] === "Reload")) ? "" : "its line offers " + JSON.stringify(foot());
    `,
  },
  {
    // Reload reads what the bucket holds now, says what it found, and the tab
    // shows the newest: the digit smoke.js changed twice.
    name: "Reload reads the newer version and says what changed",
    shot: "refresh-reloaded",
    script: `
      ${LINE}
      const reload = footButton("Reload");
      if (reload === undefined) return "no Reload on the line";
      reload.click();
      const said = /^reloaded ads-q3.csv · a new version, the same size( · \\d+ edits? replayed)?$/;
      if (!(await arrives(() => said.test(text("#status-msg"))))) return "the status bar says " + JSON.stringify(text("#status-msg"));
      if (tab("ads-q3.csv").querySelector(".trouble") !== null) return "the tab still wears its mark";
      // A reload of the tab's own object leaves the workspace clean, and the
      // next save records the new version.
      if (tab("ads-q3.csv").querySelector(".dirty") !== null) return "the tab has a dot";
      const first = () => document.querySelector("tbody tr:not(.pending) td:nth-child(2)")?.textContent;
      if (!(await arrives(() => first() === "A3000"))) return "the first cell reads " + JSON.stringify(first());
      // Another focus finds the object as just reloaded, so the line keeps
      // its size.
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, ${ASKED_MS}));
      const words = line("ads-q3.csv")?.children[1]?.textContent ?? "";
      return /KB$/.test(words) ? "" : "after another focus the line says " + JSON.stringify(words);
    `,
  },
];

/**
 * Checks that r on a chart reads the object's newer version. They run last,
 * since the first chart a run makes loads the chart layer, which the chart
 * checks find waiting unloaded. The chart checks leave their workspace
 * unsaved, so the first open of the saved one says so, and the second opens it.
 */
export const CHART_REFRESH: Check[] = [
  {
    name: "an open of the saved workspace over unsaved charts says so first",
    send: ["menu:open-path", SAVED],
    script: `
      const want = "unsaved edits · Ctrl+S first, or open it again to drop them";
      return (await until(() => text("#status-msg") === want)) ? "" : "the status bar says " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    name: "the second open shows the saved workspace, and a chart inserted over the object takes the keys",
    send: ["menu:open-path", SAVED],
    script: `
      ${LINE}
      if (!(await arrives(() => tab("ads-q3.csv") !== undefined))) {
        // Any message in between takes the warning down, and the open warns again.
        const tabs = [...document.querySelectorAll(".tab")].map((t) => t.textContent);
        return "no tab for the object · the status bar says " + JSON.stringify(text("#status-msg")) + " over the tabs " + JSON.stringify(tabs);
      }
      tab("ads-q3.csv").click();
      if (!(await arrives(() => document.querySelector("tbody tr:not(.pending)") !== null))) return "no rows came";
      const content = document.querySelector("#content");
      content.focus();
      content.dispatchEvent(new KeyboardEvent("keydown", { key: "G", ctrlKey: true, shiftKey: true, bubbles: true }));
      if (!(await arrives(() => document.querySelector(".chart-form") !== null))) return "no chart form opened";
      document.querySelector(".chart-form select").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const chart = () => document.querySelector(".chart");
      if (!(await arrives(() => / rows/.test(chart()?.querySelector(".chart-said")?.textContent ?? "")))) return "the chart never completed";
      return document.activeElement === chart() ? "" : "the keys are in " + document.activeElement?.className;
    `,
  },
  {
    // The digit smoke.js changed twice above changes a third time, read by r
    // alone, then the time of the check once it ends. The track under the head
    // while it reads is chart-refresh.test.ts's, which holds the read open: a
    // read here can end within one frame, before the track is painted. The
    // chart then goes, and the workspace is as it opened.
    name: "r on the chart reads the object's newer version, says when, and its removal leaves the workspace clean",
    ask: `rewrite ${KEY}`,
    input: { events: PRESS_R, through: true },
    script: `
      const said = /^reloaded ads-q3.csv · a new version, the same size( · \\d+ edits? replayed)?$/;
      if (!(await arrives(() => said.test(text("#status-msg"))))) return "the status bar says " + JSON.stringify(text("#status-msg"));
      const first = () => document.querySelector("tbody tr:not(.pending) td:nth-child(2)")?.textContent;
      if (!(await arrives(() => first() === "A4000"))) return "the first cell reads " + JSON.stringify(first());
      const checked = () => text(".chart .chart-checks");
      if (!(await arrives(() => /^checked \\d/.test(checked())))) return "the caption's right end says " + JSON.stringify(checked());
      const del = () => document.querySelector(".chart").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      // The first Delete arms the ×, and the second removes the chart.
      del();
      del();
      if (!(await until(() => text("#status-msg").startsWith("removed ")))) return "the status bar says " + JSON.stringify(text("#status-msg"));
      if (document.querySelector(".chart") !== null) return "the chart stayed";
      return (await until(() => document.querySelector(".ws.open .dirty") === null)) ? "" : "the workspace has a dot";
    `,
  },
];
