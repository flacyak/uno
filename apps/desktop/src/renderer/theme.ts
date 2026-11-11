/**
 * @fileoverview The colour themes and the one the page is using.
 *
 * Four themes, each with a light and a dark palette, from T3 Themes
 * (t3themes.com, github.com/SunkenInTime/t3-themes), credited to their
 * authors below. Each is stored already mapped onto uno's tokens:
 *
 * - The theme's three grounds are assigned to surface, paper and sunken by
 *   lightness, lightest to surface.
 * - text, textMuted, border and accent map to ink, ink-3, rule and accent.
 * - The remaining tokens are mixed from those in `tokensOf`. The warning
 *   amber is the same under every theme.
 *
 * Each palette adds six chart colours of uno's own: the accent's hue, then
 * five hues of the dataviz skill's reference palette. The first is stepped
 * from the accent and the rest from the reference until a pie's neighbours
 * pass the skill's palette validator on the theme's grid, which theme.test.ts
 * checks.
 *
 * The chosen theme and appearance are kept in local storage.
 */

/** Six colours a chart tells its values apart by, in the order it gives them. */
export type ChartColours = readonly [string, string, string, string, string, string];

/** The colours a palette defines. The other tokens are mixed from these. */
export interface Palette {
  /** Chrome background: sidebar, status bar, column headers. */
  sunken: string;
  /** Background of the panel and the empty window. */
  paper: string;
  /** Background of the grid, inputs and the active tab. */
  surface: string;
  ink: string;
  /** Muted text: notes, sizes, secondary labels. */
  ink3: string;
  rule: string;
  accent: string;
  /** Worn as --chart-1 to --chart-6. */
  chart: ChartColours;
}

export interface Theme {
  readonly id: string;
  readonly name: string;
  /** The author as credited on T3 Themes. */
  readonly author: string;
  readonly light: Palette;
  readonly dark: Palette;
}

export const THEMES = [
  {
    id: "paper-ember",
    name: "Paper Ember",
    author: "SunkenInTime",
    light: {
      sunken: "#f2ebdf",
      paper: "#faf6f0",
      surface: "#fdfaf5",
      ink: "#44403c",
      ink3: "#6e6661",
      rule: "#e7ddd0",
      accent: "#c2571f",
      chart: ["#e0723e", "#c8477e", "#2a78d6", "#12a572", "#6250d6", "#067605"],
    },
    dark: {
      sunken: "#1c1917",
      paper: "#211e1c",
      surface: "#2a2725",
      ink: "#e7e5e4",
      ink3: "#a8a29e",
      rule: "#33302c",
      accent: "#ea884b",
      chart: ["#b45607", "#d85383", "#3987e5", "#199e70", "#9085e9", "#3ea939"],
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    author: "pantharshit007",
    light: {
      sunken: "#d6d8df",
      paper: "#e6e7ed",
      surface: "#e6e7ed",
      ink: "#343b59",
      ink3: "#585a65",
      rule: "#c1c2c7",
      accent: "#2959aa",
      chart: ["#4172c6", "#dd5b25", "#0d9768", "#b37907", "#cc5f8a", "#008300"],
    },
    dark: {
      sunken: "#16161e",
      paper: "#1a1b26",
      surface: "#1e202e",
      ink: "#c0caf5",
      ink3: "#a5a8bb",
      rule: "#292e42",
      accent: "#7aa2f7",
      chart: ["#5d86de", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"],
    },
  },
  {
    id: "sakura",
    name: "Sakura",
    author: "SunkenInTime",
    light: {
      sunken: "#f4e2e8",
      paper: "#fbf3f5",
      surface: "#fdf7f9",
      ink: "#432b36",
      ink3: "#7d5c6a",
      rule: "#ecd7de",
      accent: "#b83d72",
      chart: ["#db5d90", "#0a9163", "#2a78d6", "#c28409", "#6250d6", "#008300"],
    },
    dark: {
      sunken: "#1f141c",
      paper: "#241820",
      surface: "#33232f",
      ink: "#eedbe4",
      ink3: "#b18ea0",
      rule: "#3c2a36",
      accent: "#e88fb4",
      chart: ["#bd447e", "#37a67a", "#3987e5", "#c98500", "#9085e9", "#0a8708"],
    },
  },
  {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappé",
    author: "jainvaibhav671",
    light: {
      sunken: "#ccd0da",
      paper: "#dce0e8",
      surface: "#eff1f5",
      ink: "#4c4f69",
      ink3: "#555869",
      rule: "#bcc0cc",
      accent: "#8839ef",
      chart: ["#8839ef", "#e4612c", "#0f9e6d", "#ba7e08", "#e05d93", "#008300"],
    },
    dark: {
      sunken: "#232634",
      paper: "#303446",
      surface: "#414559",
      ink: "#c6d0f5",
      ink3: "#b5bfe2",
      rule: "#51576d",
      accent: "#ca9ee6",
      chart: ["#bc61ee", "#e4612e", "#199e70", "#c98500", "#e25d8c", "#33a02e"],
    },
  },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof THEMES)[number]["id"];

/** The appearance a person chooses: a mode, or follow the system. */
export type Appearance = "system" | "light" | "dark";

/** The mode the page is in after resolving `system`. */
export type Mode = "light" | "dark";

export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];

/** The theme used when none is stored. */
export const DEFAULT_THEME: ThemeId = "paper-ember";

/** Storage keys for the theme and appearance choices. */
export const THEME_KEY = "uno.theme";
export const APPEARANCE_KEY = "uno.appearance";

/**
 * The warning colours used for the flag tokens: the fill, the readable
 * foreground per mode, and how much fill is mixed into the paper per mode.
 */
const WARNING = "#fe9a00";
const WARNING_INK: Record<Mode, string> = { light: "#973e00", dark: "#ffb900" };
const WARNING_WASH: Record<Mode, string> = { light: "8%", dark: "16%" };

/** How much accent is mixed into the surface for a selected line, per mode. */
const ACCENT_WASH: Record<Mode, string> = { light: "14%", dark: "22%" };

/** The overlay drawn over the workspace behind the sources panel, per mode. */
const SCRIM: Record<Mode, string> = { light: "rgb(0 0 0 / 30%)", dark: "rgb(0 0 0 / 50%)" };

/**
 * Returns the CSS custom properties for a palette: the colours it defines and
 * the ones mixed from them. The names match those declared in base.css, save
 * --chart-1 to --chart-6, which only a themed chart reads.
 */
export function tokensOf(p: Palette, mode: Mode): Record<string, string> {
  return {
    "--sunken": p.sunken,
    "--paper": p.paper,
    "--surface": p.surface,
    "--ink": p.ink,
    // Secondary text, between ink and ink3.
    "--ink-2": `color-mix(in srgb, ${p.ink} 62%, ${p.ink3})`,
    "--ink-3": p.ink3,
    "--rule": p.rule,
    // The lighter rule between rows.
    "--rule-2": `color-mix(in srgb, ${p.rule} 55%, ${p.paper})`,
    "--accent": p.accent,
    "--accent-b": `color-mix(in srgb, ${p.accent} ${ACCENT_WASH[mode]}, ${p.surface})`,
    "--flag": WARNING_INK[mode],
    "--flag-b": `color-mix(in srgb, ${WARNING} ${WARNING_WASH[mode]}, ${p.paper})`,
    "--scrim": SCRIM[mode],
    "--chart-1": p.chart[0],
    "--chart-2": p.chart[1],
    "--chart-3": p.chart[2],
    "--chart-4": p.chart[3],
    "--chart-5": p.chart[4],
    "--chart-6": p.chart[5],
  };
}

/** Key-value storage for choices: localStorage, or a map in tests. */
export interface Keeps {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The `(prefers-color-scheme: dark)` media query, with a change listener. */
export interface Scheme {
  readonly matches: boolean;
  addEventListener(type: "change", fn: () => void): void;
}

function isTheme(id: string | null): id is ThemeId {
  return THEMES.some((t) => t.id === id);
}

function isAppearance(a: string | null): a is Appearance {
  return APPEARANCES.includes(a as Appearance);
}

/**
 * Theming holds the stored theme and appearance choices and applies them to
 * the root element as CSS custom properties.
 *
 * An unknown stored value falls back to the default.
 */
export class Theming {
  private chosen: ThemeId;
  private appearing: Appearance;
  private readonly heard: Array<() => void> = [];

  constructor(
    private readonly keeps: Keeps,
    private readonly scheme: Scheme,
    private readonly root: HTMLElement,
  ) {
    const theme = keeps.getItem(THEME_KEY);
    const appearance = keeps.getItem(APPEARANCE_KEY);
    this.chosen = isTheme(theme) ? theme : DEFAULT_THEME;
    this.appearing = isAppearance(appearance) ? appearance : "system";
    // Reapply when the system scheme changes, while following the system.
    scheme.addEventListener("change", () => {
      if (this.appearing === "system") this.apply();
    });
    this.apply();
  }

  get theme(): Theme {
    return THEMES.find((t) => t.id === this.chosen)!;
  }

  get appearance(): Appearance {
    return this.appearing;
  }

  /** The mode the page is in now. */
  get mode(): Mode {
    if (this.appearing !== "system") return this.appearing;
    return this.scheme.matches ? "dark" : "light";
  }

  /** Stores and applies a theme. */
  choose(id: ThemeId): void {
    this.chosen = id;
    this.keeps.setItem(THEME_KEY, id);
    this.apply();
  }

  /** Stores and applies an appearance. */
  appear(a: Appearance): void {
    this.appearing = a;
    this.keeps.setItem(APPEARANCE_KEY, a);
    this.apply();
  }

  /** Registers a listener called after every apply. */
  onChange(fn: () => void): void {
    this.heard.push(fn);
  }

  private apply(): void {
    const mode = this.mode;
    for (const [name, value] of Object.entries(tokensOf(this.theme[mode], mode))) {
      this.root.style.setProperty(name, value);
    }
    // color-scheme styles scrollbars and form controls. data-theme is read
    // by the stylesheet's [data-theme] rules.
    this.root.style.colorScheme = mode;
    this.root.dataset["theme"] = mode;
    this.root.dataset["palette"] = this.chosen;
    for (const fn of this.heard) fn();
  }
}
