/**
 * @fileoverview The dataviz skill's palette validator, for the tests of the
 * themes' colours: WCAG contrast, OKLab distance, the eyes it simulates, and
 * the pairs of colours each chart draws side by side.
 */

import { PIE_SLICES_AT_MOST } from "@renderer/chart/pie";
import type { Palette } from "@renderer/theme";

/** A hex colour's red, green and blue, as linear light. */
export function linear(hex: string): number[] {
  return [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

export function luminance(hex: string): number {
  const [r, g, b] = linear(hex);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The validator measures OKLab distance times 100, the unit of its floors. */
const DELTA_E_PER_OKLAB = 100;

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
 * validator's model of them (Machado, Oliveira and Fernandes, 2009). Its
 * floors between neighbours hold for these two.
 */
export const BLINDNESSES: Record<string, Matrix> = {
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

/** Tritanopia at full severity, from the same model. The validator reports it and does not gate it. */
export const TRITANOPIA: Matrix = [
  [1.255528, -0.076749, -0.178779],
  [-0.078411, 0.930809, 0.147602],
  [0.004733, 0.691367, 0.3039],
];

function times(m: Matrix, v: readonly number[]): number[] {
  return m.map(([a, b, c]) => a * v[0]! + b * v[1]! + c * v[2]!);
}

/** A colour's OKLab lightness and two opponent axes, from its linear light. */
export function oklab(rgb: readonly number[]): number[] {
  return times(LAB, times(CONES, rgb).map(Math.cbrt));
}

/** A colour in OKLab as an eye with a blindness sees it, kept to the screen's range. */
export function seenBy(blindness: Matrix, hex: string): number[] {
  return oklab(times(blindness, linear(hex)).map((c) => Math.min(Math.max(c, 0), 1)));
}

/** How far apart two colours stand to full colour vision, in the validator's unit. */
export function apart(a: string, b: string): number {
  return distance(oklab(linear(a)), oklab(linear(b)));
}

/** How far apart two colours stand to an eye with a blindness. */
export function apartTo(blindness: Matrix, a: string, b: string): number {
  return distance(seenBy(blindness, a), seenBy(blindness, b));
}

function distance(a: readonly number[], b: readonly number[]): number {
  return DELTA_E_PER_OKLAB * Math.hypot(...a.map((x, i) => x - b[i]!));
}

/** Two colours a chart draws side by side. */
export type Pair = [string, string];

/** Each colour beside the next. */
function neighbours(ring: readonly string[]): Pair[] {
  return ring.slice(1).map((c, i): Pair => [ring[i]!, c]);
}

/**
 * A pie's pairs: each slice and the next, Other in --ink-3 after the last,
 * and the first slice beside whichever closes the pie.
 */
export function pieBesides(p: Palette): Pair[] {
  const ring = [...p.chart.slice(0, PIE_SLICES_AT_MOST), p.ink3];
  const closing = ring.slice(2).map((c): Pair => [ring[0]!, c]);
  return [...neighbours(ring), ...closing];
}

/**
 * The series a stack colours before Other, and a scatter by category, from
 * the owner's answers in the several series design. Each kind's drawing
 * takes its count over when it lands.
 */
export const STACK_SERIES_AT_MOST = 6;
export const SCATTER_SERIES_AT_MOST = 3;

/**
 * A stack's pairs: each series beside the next in slot order, and the last
 * beside Other in --ink-3. A stack always fills slots 1 to k, so no other
 * pair meets.
 */
export function stackBesides(p: Palette): Pair[] {
  return neighbours([...p.chart.slice(0, STACK_SERIES_AT_MOST), p.ink3]);
}

/**
 * A scatter's pairs when it colours by category: every two of its coloured
 * series, since points of any two can overlap. Other is a hollow ring, told
 * apart by its shape.
 */
export function scatterBesides(p: Palette): Pair[] {
  const slots = p.chart.slice(0, SCATTER_SERIES_AT_MOST);
  return slots.flatMap((a, i) => slots.slice(i + 1).map((b): Pair => [a, b]));
}
