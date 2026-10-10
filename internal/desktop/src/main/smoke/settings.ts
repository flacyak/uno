// Checks of the settings control: it opens upward from the bottom left on the
// run's connections and the four themes, each theme in each mode is what the
// page is drawn in, and a language chosen is the one the window is written
// in.
//
// They run with the run's own --user-data-dir, so the theme chosen here
// stays with the run.

import { THEMES } from "../../renderer/theme.ts";
import type { Check } from "./check.ts";
import { LOCALE } from "./fixture.ts";

const MENU = `
  const menu = () => document.querySelector(".settings");
  const gear = () => document.querySelector("#settings");
  // The body's computed background colour, and a hex in the same form.
  const rgb = (hex) => "rgb(" + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ") + ")";
  const painted = () => getComputedStyle(document.body).backgroundColor;
`;

/** One check per theme and mode: chosen from the menu, and drawn in. */
const WORN: Check[] = THEMES.flatMap((t) =>
  (["light", "dark"] as const).map((mode): Check => ({
    name: `${t.name} in ${mode} is what the page is drawn in`,
    shot: `settings-${t.id}-${mode}`,
    script: `
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
      const sources = '["acme-exports / 2025","acme-exports","+ Connect a bucket"]';
      if (!(await arrives(() => JSON.stringify(names(0)) === sources))) return "the sources are " + JSON.stringify(names(0));
      const themes = ${JSON.stringify(JSON.stringify(THEMES.map((t) => t.name)))};
      return JSON.stringify(names(1)) === themes ? "" : "the themes are " + JSON.stringify(names(1));
    `,
  },
  ...WORN,
  {
    // The run is pinned to English by the script that started it. Choosing a
    // language in settings overrides that.
    name: "Español is spoken the moment it is chosen: the window, the open menu and the status bar",
    shot: "settings-language-es",
    script: `
      ${MENU}
      if (menu().hidden) gear().click();
      menu().querySelector('[data-language="es"]').click();
      if (!(await until(() => document.documentElement.lang === "es"))) {
        return "the page says it is in " + document.documentElement.lang;
      }
      if (menu().hidden) return "choosing a language closed the menu";
      const said = {
        "the sidebar's head": [text(".sidebar-head"), "Espacios de trabajo"],
        "the menu's title": [menu().querySelector(".title").textContent, "Ajustes"],
        "the switch": [text('#mode-switch [data-mode="transform"]'), "Transformar"],
        "the control": [gear().getAttribute("aria-label"), "Ajustes"],
      };
      for (const [what, [is, want]] of Object.entries(said)) {
        if (is !== want) return what + " says " + JSON.stringify(is) + ", not " + JSON.stringify(want);
      }
      if (!/ filas · /.test(text("#status-file"))) return "the status bar says " + JSON.stringify(text("#status-file"));
      const chosen = menu().querySelector('[data-language="es"]').getAttribute("aria-checked");
      return chosen === "true" ? "" : "the menu does not mark Español as chosen";
    `,
  },
  {
    name: "System follows the run's language again, with everything still open",
    script: `
      ${MENU}
      menu().querySelector('[data-language="system"]').click();
      if (!(await until(() => document.documentElement.lang === ${JSON.stringify(LOCALE)}))) {
        return "the page says it is in " + document.documentElement.lang;
      }
      if (text(".sidebar-head") !== "Workspaces") return "the sidebar's head says " + JSON.stringify(text(".sidebar-head"));
      if (!/ rows · /.test(text("#status-file"))) return "the status bar says " + JSON.stringify(text("#status-file"));
      return menu().hidden ? "choosing a language closed the menu" : "";
    `,
  },
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
