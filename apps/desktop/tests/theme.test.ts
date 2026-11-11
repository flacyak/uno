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

/** The faintest a rule stands from the sunken band it borders in any theme
 * today, Sakura light's 1.10 to 1: a head's rule and a tucked head's top
 * border are drawn on it. */
const RULE_ON_SUNKEN = 1.1;

test.each(palettes)("%s, %s: its rules show on the sunken band", (_, _mode, p) => {
  expect(contrast(p.rule, p.sunken)).toBeGreaterThanOrEqual(RULE_ON_SUNKEN);
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

/** The validator's lightness band for chart colours, in OKLCH L, per mode. */
const BAND: Record<Mode, readonly [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] };

/** The validator's chroma floor, below which a hue reads as grey. */
const CHROMA_FLOOR = 0.1;

/** The validator's floor between neighbours, to full colour vision. */
const NORMAL_FLOOR = 15;

/** The validator's target between neighbours, to protanopia or deuteranopia. */
const BLIND_TARGET = 8;

/**
 * The least any two chart colours stand apart to full colour vision, so a
 * legend's keys find their slices. It borrows the validator's floor between
 * neighbours to a colour-blind eye, which it allows where labels tell them
 * apart too.
 */
const LEGEND_FLOOR = 6;

/** WCAG's bound for a mark on its ground: 3 to 1. */
const MARK = 3;

/**
 * The palettes whose grid is so light that the dark band holds some hues at
 * MARK only at its top and the chroma floor. Below MARK the validator asks for
 * labels on the marks or a table beside them.
 */
const RELIEVED = new Set(["Catppuccin Frappé dark"]);

/**
 * The least a relieved mark keeps on the grid, borrowed from the validator's
 * floor for the faintest step of a ramp.
 */
const FAINTEST = 2;

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

/**
 * Protanopia and deuteranopia at full severity, on linear light: the
 * validator's model of them (Machado, Oliveira and Fernandes, 2009).
 */
const BLINDNESSES: Record<string, Matrix> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function times(m: Matrix, v: readonly number[]): number[] {
  return m.map(([a, b, c]) => a * v[0]! + b * v[1]! + c * v[2]!);
}

/** A colour's OKLab lightness and two opponent axes, from its linear light. */
function oklab(rgb: readonly number[]): number[] {
  return times(LAB, times(CONES, rgb).map(Math.cbrt));
}

/** A colour in OKLab as an eye with a blindness sees it, kept to the screen's range. */
function seenBy(blindness: Matrix, hex: string): number[] {
  return oklab(times(blindness, linear(hex)).map((c) => Math.min(Math.max(c, 0), 1)));
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

test.each(palettes)("%s, %s: its chart colours are hues that show on the grid", (name, mode, p) => {
  const [low, high] = BAND[mode];
  const least = RELIEVED.has(`${name} ${mode}`) ? FAINTEST : MARK;
  for (const c of p.chart) {
    const [l, a, b] = oklab(linear(c));
    expect(l, `${c} lightness`).toBeGreaterThanOrEqual(low);
    expect(l, `${c} lightness`).toBeLessThanOrEqual(high);
    expect(Math.hypot(a!, b!), `${c} chroma`).toBeGreaterThanOrEqual(CHROMA_FLOOR);
    expect(contrast(c, p.surface), `${c} on the grid`).toBeGreaterThanOrEqual(least);
  }
});

// A bar wears the accent, a mark on the grid's ground, which a window wears,
// and on the page's.
test.each(palettes)("%s, %s: its accent shows as a mark on either ground", (_, _mode, p) => {
  expect(contrast(p.accent, p.surface), "on the grid").toBeGreaterThanOrEqual(MARK);
  expect(contrast(p.accent, p.paper), "on the page").toBeGreaterThanOrEqual(MARK);
});

test.each(palettes)("%s, %s: a pie's colours tell apart beside each other", (_, _mode, p) => {
  for (const [a, b] of besides(p)) {
    const where = `${a} by ${b}`;
    expect(apart(oklab(linear(a)), oklab(linear(b))), where).toBeGreaterThanOrEqual(NORMAL_FLOOR);
    for (const [name, blindness] of Object.entries(BLINDNESSES)) {
      const seen = apart(seenBy(blindness, a), seenBy(blindness, b));
      expect(seen, `${where} to ${name}`).toBeGreaterThanOrEqual(BLIND_TARGET);
    }
  }
});

test.each(palettes)("%s, %s: no two of its chart colours look alike", (_, _mode, p) => {
  for (const [i, a] of p.chart.entries()) {
    for (const b of p.chart.slice(i + 1)) {
      const seen = apart(oklab(linear(a)), oklab(linear(b)));
      expect(seen, `${a} by ${b}`).toBeGreaterThanOrEqual(LEGEND_FLOOR);
    }
  }
});
