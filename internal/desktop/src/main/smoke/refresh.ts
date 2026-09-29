// Checks that a source in a bucket knows when it is out of date: a workspace
// whose export was written over since it was saved opens saying so, and one
// written over while it is open is marked when the window gets the focus back.
//
// They run after meets.ts, with acme-exports/2025/ connected, so the saved
// workspace opens its object at once. The object is written over by smoke.js,
// which holds the stand-in, when a check asks it to.

import { join } from "node:path";

import type { Check } from "./check.ts";
import { REMOTE } from "./sources.ts";

/** The workspace sources.ts saved, with the object in it. */
const SAVED = join(process.env["UNO_SMOKE"] ?? "", "sales-q3.uno");

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
      ${REMOTE}
      ${LINE}
      if (!(await arrives(() => tab("ads-q3.csv")?.querySelector(".trouble") != null))) {
        return "the tabs are " + JSON.stringify([...document.querySelectorAll(".tab")].map((t) => t.textContent));
      }
      const why = tab("ads-q3.csv").querySelector(".trouble").title;
      const want = "ads-q3.csv is not the version the workspace was saved against · it is the same size";
      if (!why.startsWith(want)) return "the mark says " + JSON.stringify(why);
      if (document.querySelector("#panel").hidden) await press("B", { ctrlKey: true, shiftKey: true });
      if (!(await arrives(() => line("ads-q3.csv")?.children[1]?.textContent === "changed"))) {
        return "the line says " + JSON.stringify(line("ads-q3.csv")?.textContent);
      }
      // Said and not acted on: the rows are there, and the status bar says why
      // the tab is marked.
      tab("ads-q3.csv").click();
      if (!(await arrives(() => document.querySelector("thead th .colhead") !== null))) return "no rows came";
      const status = () => text("#status-file");
      return (await arrives(() => status().endsWith(" · " + want))) ? "" : "the status bar says " + JSON.stringify(status());
    `,
  },
  {
    // The task's own sentence: coming back to the window is when the bucket
    // is asked, one HEAD per object, and the moved one wears the mark.
    name: "replacing the object in the stand-in shows the mark on the next focus",
    ask: `rewrite ${KEY}`,
    shot: "refresh-newer",
    script: `
      ${REMOTE}
      ${LINE}
      const words = () => line("ads-q3.csv")?.children[1]?.textContent;
      if (words() !== "changed") return "before the focus the line says " + JSON.stringify(words());
      window.dispatchEvent(new Event("focus"));
      if (!(await arrives(() => words() === "newer in bucket"))) return "after the focus the line says " + JSON.stringify(words());
      const want = "a newer version is in the bucket · Reload reads it";
      const mark = tab("ads-q3.csv").querySelector(".trouble");
      if (mark === null || !mark.title.startsWith(want)) return "the mark says " + JSON.stringify(mark?.title);
      if (!text("#status-file").endsWith(want)) return "the status bar says " + JSON.stringify(text("#status-file"));
      // The mark opens the panel with the keys on its line, where Reload is.
      mark.click();
      const foot = () => [...document.querySelectorAll("#panel .panel-foot button")].map((b) => b.textContent);
      return (await until(() => foot()[0] === "Reload")) ? "" : "its line offers " + JSON.stringify(foot());
    `,
  },
];
