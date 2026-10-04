// Checks that a source in a bucket knows when it is out of date: a workspace
// whose export was rewritten since it was saved opens saying so, one rewritten
// while it is open is marked when the window gets the focus back, and Reload
// reads the newer one with the edits replayed over it.
//
// They run after meets.ts, with acme-exports/2025/ connected, so the saved
// workspace opens its object at once. smoke.js rewrites the object when a
// check asks it to.

import { join } from "node:path";

import { NEWER_AFTER_MS } from "../../renderer/timing.ts";
import type { Check } from "./check.ts";

/** The workspace sources.ts saved, with the object in it. */
const SAVED = join(process.env["UNO_SMOKE"] ?? "", "sales-q3.uno");

/**
 * How long to wait for a focus that finds the bucket as it was: the page's
 * own wait before asking, and as long again for the HEAD to come back.
 */
const ASKED_MS = NEWER_AFTER_MS * 2;

/** The object the saved workspace points at, by its key in the stand-in. */
const KEY = "2025/ads-q3.csv";

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
      const said = /^reloaded ads-q3.csv · a new version, the same size( · d+ edits? replayed)?$/;
      if (!(await arrives(() => said.test(text("#status-msg"))))) return "the status bar says " + JSON.stringify(text("#status-msg"));
      if (tab("ads-q3.csv").querySelector(".trouble") !== null) return "the tab still wears its mark";
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
