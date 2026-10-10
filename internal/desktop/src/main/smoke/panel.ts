// Checks of the sources panel: the workspace's tabs listed in it, the stand-in
// bucket browsed, an object peeked at, two added, and one tab re-pointed at
// another object.
//
// They run after sources.ts, over the reopened workspace it leaves: the fixture
// and the bucket's ads-q3.csv. smoke.js puts ads-q4.csv and sales-q3.csv beside
// that object.

import type { Check } from "./check.ts";

/** The names on a section's lines, beside the PRELUDE's helpers. */
const LINES = `
  const names = (section) => named(section).map((l) => l.name);
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
    // Measures layout, which only a real window has.
    name: "the grid gives the panel its width rather than sitting under it",
    script: `
      const grid = document.querySelector(".grid-scroll").getBoundingClientRect();
      const panel = document.querySelector("#panel").getBoundingClientRect();
      if (panel.width < 100) return "the panel is " + panel.width + "px wide";
      return grid.right <= panel.left + 1
        ? ""
        : "the grid ends at " + grid.right + "px, past the panel's " + panel.left + "px";
    `,
  },
  {
    // The × at the top right closes the window, so it sits on the top line,
    // above the panel.
    name: "the panel begins under the window's top line, and the × is on the line and not the panel",
    script: `
      // The panel slides in, and is measured once its animation ends.
      await Promise.all(document.querySelector("#panel").getAnimations().map((a) => a.finished));
      const panel = document.querySelector("#panel").getBoundingClientRect();
      const line = document.querySelector(".win-top").getBoundingClientRect();
      const close = document.querySelector(".win-close").getBoundingClientRect();
      if (line.top !== 0 || line.height < close.height) return "the top line is " + line.height + "px tall at " + line.top + "px";
      if (panel.top !== line.bottom) return "the panel starts at " + panel.top + "px, and the top line ends at " + line.bottom + "px";
      if (line.left !== panel.left || line.right !== panel.right) return "the top line runs from " + line.left + " to " + line.right + ", and the panel from " + panel.left + " to " + panel.right;
      return close.bottom <= panel.top ? "" : "the × reaches " + close.bottom + "px, into the panel at " + panel.top + "px";
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
      // The fixture's header, which only sales-q3.csv has. The other two
      // objects are the ads export.
      const want = ["date", "region", "rep", "channel", "units", "revenue"];
      if (!(await until(() => JSON.stringify(heads()) === JSON.stringify(want)))) {
        return "the peek shows " + JSON.stringify(peek.textContent.slice(0, 200));
      }
      const rows = peek.querySelectorAll("tbody tr").length;
      if (rows !== 20) return "the peek has " + rows + " rows";
      return JSON.stringify(foot()) === '["Add 1"]' ? "" : "the buttons are " + JSON.stringify(foot());
    `,
  },
  {
    name: "two objects picked are added as a tab each, out of the bucket",
    script: `
      ${LINES}
      await key("ArrowUp");
      await key(" ");
      if (JSON.stringify(foot()) !== '["Add 2","Add as one"]') return "the buttons are " + JSON.stringify(foot());
      if (!document.querySelector("#panel .panel-peek").hidden) return "two picks still show a peek";

      footButtons()[0].click();
      if (!(await arrives(() => document.querySelectorAll(".tab").length === 4))) {
        return "the sidebar has " + document.querySelectorAll(".tab").length + " tabs · " + JSON.stringify(text("#status-msg"));
      }
      // A tab's line has the path it reads from as its title.
      const want = ["s3://acme-exports/2025/ads-q4.csv", "s3://acme-exports/2025/sales-q3.csv"];
      if (!(await until(() => want.every((p) => lines().some((l) => l.title.startsWith(p)))))) {
        return "the tabs read from " + JSON.stringify(lines().map((l) => l.title).filter((t) => t !== ""));
      }
      return (await arrives(() => text("#status-file").startsWith(counted(ROWS) + " rows")))
        ? ""
        : "the status bar says " + JSON.stringify(text("#status-file"));
    `,
  },
  {
    name: "Re-point on a tab's line points it at another object in the bucket",
    script: `
      ${LINES}
      const q3 = "s3://acme-exports/2025/ads-q3.csv", q4 = "s3://acme-exports/2025/ads-q4.csv";
      const row = (path) => [...document.querySelectorAll("#panel .panel-row")].find((r) => r.title.startsWith(path));
      row(q4).click();
      await frame();
      if (footButton("Re-point") === undefined) return "the ads-q4.csv line offers no Re-point";
      footButton("Re-point").click();
      // The folder is already listed from the adding before, so the wait is
      // for the listing under the re-point's title. A pick made in the old
      // listing is dropped when the new one lands.
      if (!(await arrives(() => head(BROWSER).name === "Point ads-q4.csv at…" && names(BROWSER).includes("ads-q3.csv")))) {
        return "the browser lists " + JSON.stringify(names(BROWSER)) + " · " + JSON.stringify(head(BROWSER));
      }
      // The selection is on the folder's first line, which is ads-q3.csv.
      await key(" ");
      if (!(await until(() => footButton("Point ads-q4.csv here") !== undefined))) {
        return "the buttons are " + JSON.stringify(foot());
      }
      footButton("Point ads-q4.csv here").click();

      if (!(await arrives(() => text("#status-msg").endsWith("reads from " + q3)))) {
        return "the status bar says " + JSON.stringify(text("#status-msg"));
      }
      const from = () => lines().map((l) => l.title).filter((t) => t !== "");
      const moved = () => from().filter((t) => t.startsWith(q3)).length === 2 && !from().some((t) => t.startsWith(q4));
      return (await until(moved)) ? "" : "the tabs read from " + JSON.stringify(from());
    `,
  },
];
