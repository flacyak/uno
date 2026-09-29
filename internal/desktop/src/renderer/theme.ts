// The themes, and the one the page wears.
//
// Four, each a light and a dark palette, taken as they are from T3 Themes
// (t3themes.com, github.com/SunkenInTime/t3-themes), the community gallery for
// T3 Code, and credited to their authors below. A theme there is written in T3
// Code's tokens; uno has fewer, so each is kept here already mapped onto uno's:
//
// - uno has three grounds, ordered by lightness in both modes -- the grid is
//   the most raised, the chrome around it the least -- so the theme's canvas,
//   surfaceRaised and sidebar are assigned to surface, paper and sunken by how
//   light they are, lightest to surface. A theme does not keep one order
//   between the three, and the grid on its border colour is what the order
//   would otherwise have given Catppuccin's light variant.
// - text, textMuted, border and accent are ink, ink-3, rule and accent.
// - What uno needs besides is mixed from those in CSS (`derived`), and the
//   warning amber is T3 Code's own standard pair, which it shows under every
//   theme so a warning never takes on a brand tint.
//
// Which theme, and whether it is light or dark or follows the system, is this
// machine's choice, kept the way the input strategy is.

/** The seven colours a palette gives; the rest of uno's tokens are mixed from them. */
export interface Palette {
  /** The chrome: the tab strip, the status bar, a column's header. */
  sunken: string;
  /** The ground the panel and the empty window sit on. */
  paper: string;
  /** The grid, and anything raised off the paper: inputs, the tab showing. */
  surface: string;
  ink: string;
  /** Muted ink: notes, sizes, what is beside a line. */
  ink3: string;
  rule: string;
  accent: string;
}

export interface Theme {
  readonly id: string;
  readonly name: string;
  /** Who made it, as T3 Themes credits them. */
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
      ink3: "#8a817a",
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
      ink3: "#707280",
      rule: "#c1c2c7",
      accent: "#2959aa",
    },
    dark: {
      sunken: "#16161e",
      paper: "#1a1b26",
      surface: "#1e202e",
      ink: "#c0caf5",
      ink3: "#787c99",
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
      ink3: "#8a6675",
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
      ink3: "#6c6f85",
      rule: "#ccd0da",
      accent: "#8839ef",
    },
    dark: {
      sunken: "#232634",
      paper: "#303446",
      surface: "#414559",
      ink: "#c6d0f5",
      ink3: "#a5adce",
      rule: "#51576d",
      accent: "#ca9ee6",
    },
  },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof THEMES)[number]["id"];

/** What a person chooses: a mode, or whatever the system is in. */
export type Appearance = "system" | "light" | "dark";

/** What the page is actually in, once `system` is asked. */
export type Mode = "light" | "dark";

export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];

/** The theme before anybody has chosen one: the first of the four. */
export const DEFAULT_THEME: ThemeId = "paper-ember";

/** Where the choices are kept. They are this machine's, not a workspace's. */
export const THEME_KEY = "uno.theme";
export const APPEARANCE_KEY = "uno.appearance";

/**
 * T3 Code's standard warning, which uno's flag is: the fill, the readable
 * foreground on each mode's surface, and how much of the fill is laid over the
 * paper for a flagged surface -- 8% in light and 16% in dark, as T3 Code does.
 */
const WARNING = "#fe9a00";
const WARNING_INK: Record<Mode, string> = { light: "#bb4d00", dark: "#ffb900" };
const WARNING_WASH: Record<Mode, string> = { light: "8%", dark: "16%" };

/** How much accent washes a selected line: more in dark, where the surface swallows it. */
const ACCENT_WASH: Record<Mode, string> = { light: "14%", dark: "22%" };

/**
 * tokensOf is a palette as the CSS custom properties base.css declares, the
 * ones it gives and the ones mixed from them.
 */
export function tokensOf(p: Palette, mode: Mode): Record<string, string> {
  return {
    "--sunken": p.sunken,
    "--paper": p.paper,
    "--surface": p.surface,
    "--ink": p.ink,
    // Secondary ink, between the two a palette gives.
    "--ink-2": `color-mix(in srgb, ${p.ink} 62%, ${p.ink3})`,
    "--ink-3": p.ink3,
    "--rule": p.rule,
    // The quieter rule, between rows.
    "--rule-2": `color-mix(in srgb, ${p.rule} 55%, ${p.paper})`,
    "--accent": p.accent,
    "--accent-b": `color-mix(in srgb, ${p.accent} ${ACCENT_WASH[mode]}, ${p.surface})`,
    "--flag": WARNING_INK[mode],
    "--flag-b": `color-mix(in srgb, ${WARNING} ${WARNING_WASH[mode]}, ${p.paper})`,
  };
}

/** The storage the choices are kept in: the page's localStorage, or a map in a test. */
export interface Keeps {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What `system` is asked: `(prefers-color-scheme: dark)`, and when it changes. */
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
 * Theming is the theme and the appearance the page wears, kept between
 * launches and put on the root element as its tokens.
 *
 * A value kept by some other build that this one does not know is not an
 * error: the page wears the default, and the next choice writes over it.
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
    // The system turning dark at sunset is followed while the page follows it.
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

  /** choose wears another theme, in the same appearance, and keeps it. */
  choose(id: ThemeId): void {
    this.chosen = id;
    this.keeps.setItem(THEME_KEY, id);
    this.apply();
  }

  /** appear puts the page in a mode, or back to following the system, and keeps it. */
  appear(a: Appearance): void {
    this.appearing = a;
    this.keeps.setItem(APPEARANCE_KEY, a);
    this.apply();
  }

  /** onChange is told whenever what the page wears changes. */
  onChange(fn: () => void): void {
    this.heard.push(fn);
  }

  private apply(): void {
    const mode = this.mode;
    for (const [name, value] of Object.entries(tokensOf(this.theme[mode], mode))) {
      this.root.style.setProperty(name, value);
    }
    // For the scrollbars, the form controls and the stylesheet's own
    // [data-theme] rules, which read the mode rather than the colours.
    this.root.style.colorScheme = mode;
    this.root.dataset["theme"] = mode;
    this.root.dataset["palette"] = this.chosen;
    for (const fn of this.heard) fn();
  }
}
