// Checks that the sources panel works in a window: the workspace's tabs listed
// in it, the stand-in bucket browsed, an object peeked at, two added, and one
// tab re-pointed at another object.
//
// They run after sources.ts, over the reopened workspace it leaves: the fixture
// and the bucket's ads-q3.csv. smoke.js puts ads-q4.csv and sales-q3.csv beside
// that object.

import type { Check } from "./check.ts";
import { REMOTE } from "./sources.ts";

/** What the panel's lines say, and a key pressed where the panel reads them. */
const LINES = `
  // The column's rows, each with the section it is under: the titles come
  // workspace, connections, browser, and a column this short is all on screen.
  const lines = () => {
    let at = -1;
    return [...document.querySelectorAll("#panel .panel-row")].map((r) => ({
      section: r.classList.contains("head") ? ++at : at,
      cls: r.className, name: r.children[0].textContent, meta: r.children[1].textContent, title: r.title,
    }));
  };
  const WORKSPACE = 0, BROWSER = 2;
  const head = (section) => lines().find((l) => l.section === section && l.cls.includes("head"));
  // The names on a section's lines, not its title or note.
  const names = (section) => lines()
    .filter((l) => l.section === section && !/\\b(head|note)\\b/.test(l.cls))
    .map((l) => l.name);
  const key = async (k) => {
    document.querySelector("#panel .panel-list")
      .dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    await frame();
  };
`;

export const PANEL: Check[] = [
  {
    name: "Ctrl+Shift+B opens the panel on the workspace's two tabs",
    script: `
      ${LINES}
      await press("B", { ctrlKey: true, shiftKey: true });
      if (document.querySelector("#panel").hidden) return "the panel is still closed";
      const want = ["sales-q3.csv", "ads-q3.csv"];
      if (!(await until(() => want.every((n) => names(WORKSPACE).includes(n))))) {
        return "the panel lists " + JSON.stringify(names(WORKSPACE));
      }
      return document.activeElement === document.querySelector("#panel .panel-list")
        ? ""
        : "the keys are in " + (document.activeElement?.className ?? "nothing");
    `,
  },
  {
    name: "p on the object's tab lists the folder in the bucket it came from",
    script: `
      ${LINES}
      for (let i = 0; i < 5 && !document.querySelector("#panel .sel")?.textContent.startsWith("ads-q3.csv"); i++) {
        await key("ArrowDown");
      }
      await key("p");
      const want = ["ads-q3.csv", "ads-q4.csv", "sales-q3.csv"];
      if (!(await until(() => JSON.stringify(names(BROWSER)) === JSON.stringify(want)))) {
        return "the browser lists " + JSON.stringify(names(BROWSER)) + " · " + JSON.stringify(head(BROWSER));
      }
      const { name, meta } = head(BROWSER);
      if (name !== "Point ads-q3.csv at…") return "the browser's title is " + JSON.stringify(name);
      return meta === "acme-exports / 2025" ? "" : "the crumb is " + JSON.stringify(meta);
    `,
  },
  {
    name: "Esc gives up the re-point and leaves the folder listed",
    script: `
      ${LINES}
      await key("Escape");
      if (document.querySelector("#panel").hidden) return "Esc closed the panel";
      if (head(BROWSER).name !== "Browser") return "the browser's title is " + JSON.stringify(head(BROWSER).name);
      return names(BROWSER).length === 3 ? "" : "the browser lists " + JSON.stringify(names(BROWSER));
    `,
  },
  {
    name: "Space on an object in the bucket peeks at its front",
    script: `
      ${LINES}
      await key("ArrowDown");
      await key("ArrowDown");
      await key(" ");
      const peek = document.querySelector("#panel .panel-peek");
      const heads = () => [...peek.querySelectorAll("th")].map((th) => th.textContent);
      // The fixture's header, which is only in sales-q3.csv: the other two
      // objects are the ads export.
      const want = ["date", "region", "rep", "channel", "units", "revenue"];
      if (!(await until(() => JSON.stringify(heads()) === JSON.stringify(want)))) {
        return "the peek shows " + JSON.stringify(peek.textContent.slice(0, 200));
      }
      const rows = peek.querySelectorAll("tbody tr").length;
      if (rows !== 20) return "the peek has " + rows + " rows";
      const foot = [...document.querySelectorAll("#panel .panel-foot button")].map((b) => b.textContent);
      return JSON.stringify(foot) === '["Add 1"]' ? "" : "the buttons are " + JSON.stringify(foot);
    `,
  },
  {
    name: "two objects picked are added as a tab each, out of the bucket",
    script: `
      ${REMOTE}
      ${LINES}
      await key("ArrowUp");
      await key(" ");
      const buttons = () => [...document.querySelectorAll("#panel .panel-foot button")];
      const labels = buttons().map((b) => b.textContent);
      if (JSON.stringify(labels) !== '["Add 2","Add as one"]') return "the buttons are " + JSON.stringify(labels);
      if (!document.querySelector("#panel .panel-peek").hidden) return "two picks still show a peek";

      buttons()[0].click();
      if (!(await arrives(() => document.querySelectorAll(".tab").length === 4))) {
        return "the strip has " + document.querySelectorAll(".tab").length + " tabs · " + JSON.stringify(text("#status-msg"));
      }
      // A tab's line says where it reads from to whoever hovers.
      const want = ["s3://acme-exports/2025/ads-q4.csv", "s3://acme-exports/2025/sales-q3.csv"];
      if (!(await until(() => want.every((p) => lines().some((l) => l.title.startsWith(p)))))) {
        return "the tabs read from " + JSON.stringify(lines().map((l) => l.title).filter((t) => t !== ""));
      }
      return (await arrives(() => text("#status-file").startsWith(ROWS.toLocaleString() + " rows")))
        ? ""
        : "the status bar says " + JSON.stringify(text("#status-file"));
    `,
  },
  {
    name: "Re-point on a tab's line points it at another object in the bucket",
    script: `
      ${REMOTE}
      ${LINES}
      const q3 = "s3://acme-exports/2025/ads-q3.csv", q4 = "s3://acme-exports/2025/ads-q4.csv";
      const row = (path) => [...document.querySelectorAll("#panel .panel-row")].find((r) => r.title.startsWith(path));
      const button = (label) => [...document.querySelectorAll("#panel .panel-foot button")].find((b) => b.textContent === label);
      row(q4).click();
      await frame();
      if (button("Re-point") === undefined) return "the ads-q4.csv line offers no Re-point";
      button("Re-point").click();
      // The folder is on screen from the adding before, so what is waited for
      // is the listing drawn under the re-point's title. A pick made in the
      // old one is dropped when the new one lands.
      if (!(await arrives(() => head(BROWSER).name === "Point ads-q4.csv at…" && names(BROWSER).includes("ads-q3.csv")))) {
        return "the browser lists " + JSON.stringify(names(BROWSER)) + " · " + JSON.stringify(head(BROWSER));
      }
      // The keys are on the folder's first line, which is ads-q3.csv.
      await key(" ");
      if (!(await until(() => button("Point ads-q4.csv here") !== undefined))) {
        return "the buttons are " + JSON.stringify([...document.querySelectorAll("#panel .panel-foot button")].map((b) => b.textContent));
      }
      button("Point ads-q4.csv here").click();

      if (!(await arrives(() => text("#status-msg").endsWith("reads from " + q3)))) {
        return "the status bar says " + JSON.stringify(text("#status-msg"));
      }
      const from = () => lines().map((l) => l.title).filter((t) => t !== "");
      const moved = () => from().filter((t) => t.startsWith(q3)).length === 2 && !from().some((t) => t.startsWith(q4));
      return (await until(moved)) ? "" : "the tabs read from " + JSON.stringify(from());
    `,
  },
];
