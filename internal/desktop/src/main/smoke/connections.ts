// Checks that a bucket is connected from the panel in a window, after the
// folder the reopened workspace asked for in sources.ts: the form in the
// list's place, a test that fails saying why and keeping nothing, one that
// works finding the region nobody typed, and the whole bucket saved beside
// that folder as a second connection, listed and browsed without a restart.
//
// They run after panel.ts, with the panel open over the stand-in bucket. The
// run has a --user-data-dir and AWS files of its own (smoke.js), so the folder
// starts empty, the one profile on offer is `finance`, and nothing here reaches
// the connections or the profiles of whoever is at the desktop. smoke.js reads
// the saved file back from outside the app afterwards.

import type { Check } from "./check.ts";
import { REMOTE } from "./sources.ts";

const LINES = `
  const lines = () => {
    let at = -1;
    return [...document.querySelectorAll("#panel .panel-row")].map((r) => ({
      el: r, section: r.classList.contains("head") ? ++at : at,
      cls: r.className, name: r.children[0].textContent, meta: r.children[1].textContent,
    }));
  };
  const CONNECTIONS = 1, BROWSER = 2;
  const note = (section) => lines().find((l) => l.section === section && l.cls.includes("note"))?.name;
  const named = (section) => lines().filter((l) => l.section === section && !/\\b(head|note)\\b/.test(l.cls));
  const form = () => document.querySelector("#panel .panel-connect");
  const field = (name) => form().querySelector("input[name=" + name + "]");
  const result = () => form().querySelector(".result").textContent;
  const type = (name, value) => {
    field(name).value = value;
    field(name).dispatchEvent(new Event("input", { bubbles: true }));
  };
`;

export const CONNECTIONS: Check[] = [
  {
    name: "the panel lists the connection the workspace was given, and offers another",
    script: `
      ${LINES}
      await press("B", { ctrlKey: true, shiftKey: true });
      if (document.querySelector("#panel").hidden) return "the panel is closed";
      const got = named(CONNECTIONS).map((l) => l.name);
      return JSON.stringify(got) === '["acme-exports / 2025","+ Connect a bucket"]' ? "" : "the connections section lists " + JSON.stringify(got);
    `,
  },
  {
    name: "+ Connect a bucket opens the form in the list's place, with the run's one profile on offer",
    shot: "connect-open",
    script: `
      ${REMOTE}
      ${LINES}
      named(CONNECTIONS).find((l) => l.name === "+ Connect a bucket").el.click();
      if (!(await until(() => form() !== null && !form().hidden))) return "the form did not open";
      if (!document.querySelector("#panel .panel-list").hidden) return "the list is still showing under the form";
      const options = () => [...form().querySelectorAll("option")].map((o) => o.value);
      const want = '["machine","profile:finance","public"]';
      if (!(await arrives(() => JSON.stringify(options()) === want))) return "the profiles are " + JSON.stringify(options());
      return document.activeElement === field("bucket") ? "" : "the keys are in " + (document.activeElement?.tagName ?? "nothing");
    `,
  },
  {
    name: "a test that fails names the reason and saves nothing",
    shot: "connect-refused",
    script: `
      ${REMOTE}
      ${LINES}
      type("bucket", "acme-nowhere");
      form().requestSubmit();
      const want = "✗ s3://acme-nowhere: no such bucket";
      if (!(await arrives(() => result() === want))) return "the form says " + JSON.stringify(result());
      return form().hidden ? "the form closed over a failed test" : "";
    `,
  },
  {
    name: "a bucket is connected from the panel without typing its region",
    shot: "connect-tried",
    script: `
      ${REMOTE}
      ${LINES}
      // The whole bucket, beside the 2025/ folder the reopened workspace was
      // given: a second connection to one bucket keeps a file of its own.
      type("bucket", "acme-exports");
      type("prefix", "");
      const choose = form().querySelector("select");
      choose.value = "profile:finance";
      choose.dispatchEvent(new Event("change", { bubbles: true }));
      [...form().querySelectorAll("button")].find((b) => b.textContent === "Test").click();
      const want = "✓ listed the bucket · 1 folder, 0 files";
      if (!(await arrives(() => result() === want))) return "the form says " + JSON.stringify(result());
      const region = form().querySelector(".value").textContent;
      return /^[a-z0-9-]+ · detected$/.test(region) ? "" : "the region reads " + JSON.stringify(region);
    `,
  },
  {
    name: "the saved connection is listed without a restart, and browsed at once",
    shot: "connect-saved",
    script: `
      ${REMOTE}
      ${LINES}
      [...form().querySelectorAll("button")].find((b) => b.textContent === "Save connection").click();
      const listed = () => named(CONNECTIONS).map((l) => l.name + " · " + l.meta);
      const want = /^\\["acme-exports \\/ 2025 · s3 · [a-z0-9-]+","acme-exports · s3 · [a-z0-9-]+","\\+ Connect a bucket · "\\]$/;
      if (!(await arrives(() => want.test(JSON.stringify(listed()))))) {
        return "the connections section lists " + JSON.stringify(listed()) + " · " + JSON.stringify(text("#status-msg"));
      }
      if (!form().hidden) return "the form is still open";
      const files = JSON.stringify(["2025/"]);
      const got = () => JSON.stringify(named(BROWSER).map((l) => l.name));
      const crumb = () => lines().find((l) => l.section === BROWSER && l.cls.includes("head")).meta;
      return (await arrives(() => crumb() === "acme-exports" && got() === files))
        ? ""
        : "the browser lists " + got() + " under " + JSON.stringify(crumb()) + " · " + JSON.stringify(note(BROWSER));
    `,
  },
];
