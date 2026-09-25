// @vitest-environment happy-dom
//
// The themes, and which one the page wears.
//
// What is under test is the choice and what it puts on the page: kept between
// launches, a value this build does not know worn as the default, the system's
// mode followed while the page follows it, and every palette one a person can
// read.

import { beforeEach, expect, test } from "vite-plus/test";

import {
  APPEARANCE_KEY,
  DEFAULT_THEME,
  THEMES,
  THEME_KEY,
  Theming,
  tokensOf,
} from "../src/renderer/theme.ts";
import type { Keeps, Mode, Palette, Scheme } from "../src/renderer/theme.ts";

class Kept implements Keeps {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** A system that is in whichever mode a test says, and says when it changes. */
class System implements Scheme {
  matches = false;
  private readonly heard: Array<() => void> = [];
  addEventListener(_type: "change", fn: () => void): void {
    this.heard.push(fn);
  }
  turn(dark: boolean): void {
    this.matches = dark;
    for (const fn of this.heard) fn();
  }
}

let kept: Kept;
let system: System;
const root = (): HTMLElement => document.documentElement;
const token = (name: string): string => root().style.getPropertyValue(name);

beforeEach(() => {
  kept = new Kept();
  system = new System();
  root().removeAttribute("style");
});

test("the four themes, in the order they are offered", () => {
  expect(THEMES.map((t) => t.name)).toEqual([
    "Paper Ember",
    "Tokyo Night",
    "Sakura",
    "Catppuccin Frappé",
  ]);
});

test("before anything is chosen the page wears the default, following the system", () => {
  const theming = new Theming(kept, system, root());
  expect(theming.theme.id).toBe(DEFAULT_THEME);
  expect(theming.appearance).toBe("system");
  expect(token("--paper")).toBe(THEMES[0].light.paper);
  expect(root().dataset["theme"]).toBe("light");
  expect(root().style.colorScheme).toBe("light");
});

test("a choice is worn at once, and kept for the next launch", () => {
  const theming = new Theming(kept, system, root());
  theming.choose("tokyo-night");
  theming.appear("dark");
  expect(token("--surface")).toBe("#1e202e");
  expect(token("--accent")).toBe("#7aa2f7");
  expect(kept.map.get(THEME_KEY)).toBe("tokyo-night");
  expect(kept.map.get(APPEARANCE_KEY)).toBe("dark");

  root().removeAttribute("style");
  const again = new Theming(kept, system, root());
  expect([again.theme.id, again.appearance]).toEqual(["tokyo-night", "dark"]);
  expect(token("--surface")).toBe("#1e202e");
});

// A value some other build kept is not an error: the default is worn, and the
// next choice writes over it.
test("a kept value this build does not know is worn as the default", () => {
  kept.setItem(THEME_KEY, "solarized");
  kept.setItem(APPEARANCE_KEY, "sepia");
  const theming = new Theming(kept, system, root());
  expect([theming.theme.id, theming.appearance]).toEqual([DEFAULT_THEME, "system"]);
});

test("the system's mode is followed while the page follows it, and not after", () => {
  const theming = new Theming(kept, system, root());
  theming.choose("sakura");
  system.turn(true);
  expect(theming.mode).toBe("dark");
  expect(token("--paper")).toBe(THEMES[2].dark.paper);

  theming.appear("light");
  system.turn(false);
  system.turn(true);
  expect(theming.mode).toBe("light");
  expect(token("--paper")).toBe(THEMES[2].light.paper);
});

test("the tokens a palette does not give are mixed from the ones it does", () => {
  const t = tokensOf(THEMES[3].dark, "dark");
  expect(t["--ink-2"]).toBe("color-mix(in srgb, #c6d0f5 62%, #a5adce)");
  expect(t["--accent-b"]).toBe("color-mix(in srgb, #ca9ee6 22%, #414559)");
  // The warning is T3 Code's standard one under every theme.
  expect(t["--flag"]).toBe("#ffb900");
  expect(tokensOf(THEMES[3].light, "light")["--flag"]).toBe("#bb4d00");
});

// ------------------------------------------------------------ every palette

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const palettes: Array<[string, Mode, Palette]> = THEMES.flatMap((t) => [
  [t.name, "light", t.light] as [string, Mode, Palette],
  [t.name, "dark", t.dark] as [string, Mode, Palette],
]);

test.each(palettes)("%s, %s: its grounds climb from the chrome to the grid", (_, _mode, p) => {
  expect(luminance(p.sunken)).toBeLessThanOrEqual(luminance(p.paper));
  expect(luminance(p.paper)).toBeLessThanOrEqual(luminance(p.surface));
});

// WCAG AA for body text, on the ground most of the text is on.
test.each(palettes)("%s, %s: its ink reads on the grid", (_, _mode, p) => {
  expect(contrast(p.ink, p.surface)).toBeGreaterThanOrEqual(4.5);
});
