// Checks that the settings control works in a window: it opens upward from the
// bottom left on the run's connections and the four themes, and each theme in
// each mode is what the page is drawn in.
//
// They run last, over whatever the checks before them left open, with the
// run's own --user-data-dir, so the theme chosen here is never the one kept on
// the machine of whoever runs it.

import { THEMES } from "../../renderer/theme.ts";
import type { Check } from "./check.ts";
import { REMOTE } from "./sources.ts";

const MENU = `
  const menu = () => document.querySelector(".settings");
  const gear = () => document.querySelector("#settings");
  // What the page is painted in, as the browser computes it, against a hex.
  const rgb = (hex) => "rgb(" + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ") + ")";
  const painted = () => getComputedStyle(document.body).backgroundColor;
`;

/** One check per theme and mode: chosen from the menu, and drawn in. */
const WORN: Check[] = THEMES.flatMap((t) =>
  (["light", "dark"] as const).map((mode): Check => ({
    name: `${t.name} in ${mode} is what the page is drawn in`,
    shot: `settings-${t.id}-${mode}`,
    script: `
        ${REMOTE}
        ${MENU}
        if (menu().hidden) gear().click();
        menu().querySelector('[data-appearance="${mode}"]').click();
        menu().querySelector('[data-theme="${t.id}"]').click();
        const want = rgb(${JSON.stringify(t[mode].paper)});
        if (!(await until(() => painted() === want))) return "the page is " + painted() + ", not " + want;
        const chosen = menu().querySelector('[data-theme="${t.id}"]').getAttribute("aria-checked");
        return chosen === "true" ? "" : "the menu does not mark ${t.name} as chosen";
      `,
  })),
);

export const SETTINGS: Check[] = [
  {
    name: "the gear at the bottom left opens settings upward, on the run's connections and four themes",
    shot: "settings-open",
    script: `
      ${REMOTE}
      ${MENU}
      const g = gear().getBoundingClientRect();
      if (g.left > 40 || window.innerHeight - g.bottom > 40) return "the gear is at " + g.left + "," + g.top;
      gear().click();
      if (!(await until(() => !menu().hidden))) return "the menu did not open";
      const m = menu().getBoundingClientRect();
      const bar = document.querySelector(".win-status").getBoundingClientRect();
      if (m.bottom > bar.top) return "the menu reaches " + m.bottom + ", into the status bar at " + bar.top;
      if (Math.abs(m.left - g.left) > 1) return "the menu starts at " + m.left + ", the gear at " + g.left;
      const names = (s) => [...menu().querySelectorAll("section")[s].querySelectorAll(".item .name")].map((n) => n.textContent);
      const sources = '["acme-exports","acme-exports / 2025","+ Connect a bucket"]';
      if (!(await arrives(() => JSON.stringify(names(0)) === sources))) return "the sources are " + JSON.stringify(names(0));
      const themes = ${JSON.stringify(JSON.stringify(THEMES.map((t) => t.name)))};
      return JSON.stringify(names(1)) === themes ? "" : "the themes are " + JSON.stringify(names(1));
    `,
  },
  ...WORN,
  {
    name: "Esc closes settings and hands the keys back",
    script: `
      ${MENU}
      menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (!menu().hidden) return "the menu is still open";
      return document.activeElement === gear() ? "" : "the keys are in " + (document.activeElement?.id ?? "nothing");
    `,
  },
];
