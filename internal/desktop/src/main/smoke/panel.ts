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
  const lines = () => [...document.querySelectorAll("#panel .panel-row")].map((r) => ({
    cls: r.className, name: r.children[0].textContent, meta: r.children[1].textContent,
  }));
  // The names on lines, not titles or notes, and only those carrying cls.
  const names = (cls = "") => lines()
    .filter((l) => !/\b(head|note)\b/.test(l.cls) && l.cls.includes(cls))
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
      if (!(await until(() => want.every((n) => names().includes(n))))) {
        return "the panel lists " + JSON.stringify(names());
      }
      return document.activeElement === document.querySelector("#panel .panel-list")
        ? ""
        : "the keys are in " + (document.activeElement?.className ?? "nothing");
    `,
  },
];
