/**
 * @fileoverview The themes, and which one the page wears.
 *
 * Checks the choice and what it puts on the page: kept between launches, an
 * unknown kept value read as the default, the system's mode followed while
 * the appearance is "system", and every palette readable.
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, expect, test } from "vite-plus/test";

import {
  APPEARANCE_KEY,
  DEFAULT_THEME,
  THEMES,
  THEME_KEY,
  Theming,
  tokensOf,
} from "@renderer/theme";
import type { Mode, Palette, Scheme } from "@renderer/theme";
import { Kept } from "./kept.ts";

/** A Scheme in whichever mode the test sets, which notifies listeners on change. */
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
  const chart = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"];
  expect(chart.map(token)).toEqual(THEMES[1].dark.chart);
  expect(kept.map.get(THEME_KEY)).toBe("tokyo-night");
  expect(kept.map.get(APPEARANCE_KEY)).toBe("dark");

  root().removeAttribute("style");
  const again = new Theming(kept, system, root());
  expect([again.theme.id, again.appearance]).toEqual(["tokyo-night", "dark"]);
  expect(token("--surface")).toBe("#1e202e");
});

// An unknown kept value reads as the default.
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
  expect(t["--ink-2"]).toBe("color-mix(in srgb, #c6d0f5 62%, #b5bfe2)");
  expect(t["--accent-b"]).toBe("color-mix(in srgb, #ca9ee6 22%, #414559)");
  // The flag colour is T3 Code's standard, the same under every theme.
  expect(t["--flag"]).toBe("#ffb900");
  expect(tokensOf(THEMES[3].light, "light")["--flag"]).toBe("#973e00");
});

// ------------------------------------------------------------ every palette

/** A hex colour's red, green and blue, as linear light. */
function linear(hex: string): number[] {
  return [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

function luminance(hex: string): number {
  const [r, g, b] = linear(hex);
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

// ----------------------------------------------------------------- contrast

/** WCAG's AA bound for body text: 4.5 to 1. */
const READABLE = 4.5;

// The muted ink writes the gutter, the sidebar's sizes and the status bar's
// separators, on every ground. The flag writes refusals. Each must read on
// each ground.
test("muted ink and the flag read on every ground of every theme", () => {
  for (const theme of THEMES) {
    for (const mode of ["light", "dark"] as const) {
      const p = theme[mode];
      const flag = tokensOf(p, mode)["--flag"]!;
      for (const ground of [p.sunken, p.paper, p.surface]) {
        const where = `${theme.id} ${mode} on ${ground}`;
        expect(contrast(p.ink3, ground), `ink3 ${where}`).toBeGreaterThanOrEqual(READABLE);
        expect(contrast(flag, ground), `flag ${where}`).toBeGreaterThanOrEqual(READABLE);
      }
    }
  }
});

// ------------------------------------------------------------ chart colours

// The checks follow the dataviz skill's palette validator, in OKLab, on every
// pair a pie draws side by side where it takes only neighbours.

/** The validator measures OKLab distance times 100, the unit of its floors. */
const DELTA_E_PER_OKLAB = 100;

/** The validator's floor between neighbours, to full colour vision. */
const NORMAL_FLOOR = 15;

type Matrix = ReadonlyArray<readonly [number, number, number]>;

/** Linear light to cone responses, and their cube roots to OKLab (Ottosson, 2020). */
const CONES: Matrix = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const LAB: Matrix = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];

function times(m: Matrix, v: readonly number[]): number[] {
  return m.map(([a, b, c]) => a * v[0]! + b * v[1]! + c * v[2]!);
}

/** A colour's OKLab lightness and two opponent axes, from its linear light. */
function oklab(rgb: readonly number[]): number[] {
  return times(LAB, times(CONES, rgb).map(Math.cbrt));
}

function apart(a: readonly number[], b: readonly number[]): number {
  return DELTA_E_PER_OKLAB * Math.hypot(...a.map((x, i) => x - b[i]!));
}

/**
 * The colours a pie can draw side by side: each slice and the next, Other in
 * --ink-3 after the sixth, and the first slice beside whichever closes the pie.
 */
function besides(p: Palette): Array<[string, string]> {
  const ring = [...p.chart, p.ink3];
  const next = ring.slice(1).map((c, i): [string, string] => [ring[i]!, c]);
  const closing = ring.slice(2).map((c): [string, string] => [ring[0]!, c]);
  return [...next, ...closing];
}

test.each(palettes)("%s, %s: a pie's colours tell apart beside each other", (_, _mode, p) => {
  for (const [a, b] of besides(p)) {
    const where = `${a} by ${b}`;
    expect(apart(oklab(linear(a)), oklab(linear(b))), where).toBeGreaterThanOrEqual(NORMAL_FLOOR);
  }
});
