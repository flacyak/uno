// The colour themes and the one the page is using.
//
// Four themes, each with a light and a dark palette, from T3 Themes
// (t3themes.com, github.com/SunkenInTime/t3-themes), credited to their
// authors below. Each is stored already mapped onto uno's tokens:
//
// - The theme's three grounds are assigned to surface, paper and sunken by
//   lightness, lightest to surface.
// - text, textMuted, border and accent map to ink, ink-3, rule and accent.
// - The remaining tokens are mixed from those in `tokensOf`. The warning
//   amber is the same under every theme.
//
// The chosen theme and appearance are kept in local storage.

/** The seven colours a palette defines. The other tokens are mixed from these. */
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
    },
    dark: {
      sunken: "#1c1917",
      paper: "#211e1c",
      surface: "#2a2725",
      ink: "#e7e5e4",
      ink3: "#a8a29e",
      rule: "#33302c",
      accent: "#ea884b",
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
    },
    dark: {
      sunken: "#16161e",
      paper: "#1a1b26",
      surface: "#1e202e",
      ink: "#c0caf5",
      ink3: "#a5a8bb",
      rule: "#292e42",
      accent: "#7aa2f7",
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
    },
    dark: {
      sunken: "#1f141c",
      paper: "#241820",
      surface: "#33232f",
      ink: "#eedbe4",
      ink3: "#b18ea0",
      rule: "#3c2a36",
      accent: "#e88fb4",
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
      rule: "#ccd0da",
      accent: "#8839ef",
    },
    dark: {
      sunken: "#232634",
      paper: "#303446",
      surface: "#414559",
      ink: "#c6d0f5",
      ink3: "#b5bfe2",
      rule: "#51576d",
      accent: "#ca9ee6",
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
 * Returns the CSS custom properties for a palette: the seven it defines and
 * the ones mixed from them. The names match those declared in base.css.
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
