// Checks that the sources panel works in a window: the workspace's tabs listed
// in it, the stand-in bucket browsed, an object peeked at, two added, and one
// tab re-pointed at another object.
//
// They run after sources.ts, over the reopened workspace it leaves: the fixture
// and the bucket's ads-q3.csv. smoke.js puts ads-q4.csv and sales-q3.csv beside
// that object.

import type { Check } from "./check.ts";

/** What the panel's lines say, and a key pressed where the panel reads them. */
const LINES = `
  // The column's rows, each with the section it is under: the titles come
  // workspace, connections, browser, and a column this short is all on screen.
  const lines = () => {
    let at = -1;
    return [...document.querySelectorAll("#panel .panel-row")].map((r) => ({
      section: r.classList.contains("head") ? ++at : at,
      cls: r.className, name: r.children[0].textContent, meta: r.children[1].textContent,
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
];
