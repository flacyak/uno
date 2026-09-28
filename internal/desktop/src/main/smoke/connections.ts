// Checks that a saved connection reaches the panel without a restart: written
// into the folder by main, read again by the engine when the panel asks, and
// browsed from its line.
//
// They run after panel.ts, with the panel open over the stand-in bucket. The
// run has a --user-data-dir of its own, so the folder starts empty and what is
// saved here never reaches the connections of whoever is at the desktop.
// smoke.js reads the file back from outside the app afterwards.

import type { Check } from "./check.ts";
import { REMOTE } from "./sources.ts";

/** The connection saved, as the text of its .unof: the stand-in's bucket, from 2025/. */
export const CONNECTION = {
  format: 1,
  id: "acme-exports",
  name: "ACME exports",
  kind: "connection",
  provider: "s3",
  bucket: "acme-exports",
  prefix: "2025/",
  auth: { mode: "machine" },
};

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
`;

export const CONNECTIONS: Check[] = [
  {
    name: "the panel lists no connections before one is saved",
    script: `
      ${LINES}
      if (document.querySelector("#panel").hidden) return "the panel is closed";
      return note(CONNECTIONS) === "no connections yet"
        ? ""
        : "the connections section says " + JSON.stringify(named(CONNECTIONS).map((l) => l.name));
    `,
  },
  {
    name: "a connection saved through the bridge is listed without a restart",
    script: `
      ${REMOTE}
      ${LINES}
      await window.uno.saveConnection("acme-exports", ${JSON.stringify(JSON.stringify(CONNECTION, undefined, 2) + "\n")});
      // Asking for the panel again is what reads the folder again.
      await press("B", { ctrlKey: true, shiftKey: true });
      const listed = () => named(CONNECTIONS).map((l) => l.name + " · " + l.meta);
      return (await arrives(() => JSON.stringify(listed()) === '["ACME exports · s3"]'))
        ? ""
        : "the connections section lists " + JSON.stringify(listed()) + " · " + JSON.stringify(text("#status-msg"));
    `,
  },
  {
    name: "choosing the connection browses its bucket from its prefix",
    script: `
      ${REMOTE}
      ${LINES}
      named(CONNECTIONS)[0].el.click();
      // The re-point before this left the same folder listed, so the lines
      // alone would pass before anything was asked. The crumb is what says the
      // listing on screen came through the connection.
      const want = JSON.stringify(["ads-q3.csv", "ads-q4.csv", "sales-q3.csv"]);
      const got = () => JSON.stringify(named(BROWSER).map((l) => l.name));
      const crumb = () => lines().find((l) => l.section === BROWSER && l.cls.includes("head")).meta;
      return (await arrives(() => crumb() === "ACME exports" && got() === want))
        ? ""
        : "the browser lists " + got() + " under " + JSON.stringify(crumb()) + " · " + JSON.stringify(note(BROWSER));
    `,
  },
];
