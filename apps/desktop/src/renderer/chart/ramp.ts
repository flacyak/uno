/**
 * @fileoverview The classes a heatmap wears an amount in: as many equal
 * steps from zero up as the ramp has, in the accent's arm, and as many down,
 * in the pole's, all of one round width, so their breaks read as round
 * numbers (2026-11-17, answers 6 and 7).
 */

import { num } from "@renderer/locale";
import { el } from "@renderer/shell/util";
import { RAMP_SHARES } from "@renderer/theme";
import { decimal } from "./axes.ts";

/** The classes either side of zero, one per step of the ramp. */
export const CLASSES = RAMP_SHARES.length;

/** How far past a break a value may read and still class under it, as 0.1 + 0.2 does 0.3. */
const ON_BREAK = 1e-9;

/**
 * A class's width, in tenths of a power of ten: each at most a third wider
 * than the one before, so the value furthest from zero always lands in the
 * last class, and each round enough that its breaks read well.
 */
const WIDTH_TENTHS = [10, 12, 15, 20, 25, 30, 40, 50, 60, 80] as const;

/** A width: its tenths, and the power of ten they count in. */
interface Width {
  readonly tenths: number;
  readonly exponent: number;
}

/** The width of a scale with nothing either side of zero. */
const ONE: Width = { tenths: WIDTH_TENTHS[0], exponent: -1 };

/** widthOver gives the least width at or above `least`, a whole one where `whole`. */
function widthOver(least: number, whole: boolean): Width {
  const power = Math.floor(Math.log10(least));
  for (const exponent of [power - 1, power]) {
    const tenths = WIDTH_TENTHS.find((t) => {
      const width = decimal(t, exponent);
      return width >= least && (!whole || Number.isInteger(width));
    });
    if (tenths !== undefined) return { tenths, exponent };
  }
  // Ten tenths of the next power of ten is past `least`, and whole.
  return { tenths: WIDTH_TENTHS[0], exponent: power };
}

/** A scale's classes either side of zero. */
export interface Classes {
  /** How wide each class is. */
  readonly width: number;
  /** Each class's top, from zero out, CLASSES of them, each written exactly. */
  readonly breaks: readonly number[];
}

/**
 * classesOver gives the classes of `values`: the least round width whose
 * `count` steps, CLASSES or fewer, reach the value furthest from zero, either
 * side, a whole one of at least 1 for `whole` values, as counts are.
 */
export function classesOver(
  values: readonly number[],
  whole: boolean,
  count: number = CLASSES,
): Classes {
  const most = values.reduce((far, v) => Math.max(far, Math.abs(v)), 0);
  const least = whole ? Math.max(most / count, 1) : most / count;
  const { tenths, exponent } = most === 0 ? ONE : widthOver(least, whole);
  const breaks = Array.from({ length: count }, (_, i) => decimal((i + 1) * tenths, exponent));
  return { width: breaks[0]!, breaks };
}

/**
 * classOf gives the class `value` falls in: 1 to CLASSES above zero, each up
 * to and with its break, -1 to -CLASSES below it, and 0 at zero.
 */
export function classOf(value: number, classes: Classes): number {
  if (value === 0) return 0;
  const reached = Math.ceil(Math.abs(value) / classes.width - ON_BREAK);
  return Math.sign(value) * Math.min(Math.max(reached, 1), CLASSES);
}

/** The ramp a class wears either side of zero: the accent's above, the pole's below. */
const ARMS = { up: "seq", down: "div" } as const;

/** fillOf gives the colour a mark of class `step` wears, none at zero, which wears the rule. */
export function fillOf(step: number): string | undefined {
  if (step === 0) return undefined;
  return `var(--${step > 0 ? ARMS.up : ARMS.down}-${Math.abs(step)})`;
}

/** How wide a swatch of a scale's legend stands at most, in px. */
export const SWATCH_WIDE = 24;

/** The strides a legend writes its breaks at, finest first, before the ends and zero: each, every other. */
const STRIDES = [1, 2] as const;

/** The least room between two breaks' labels, in a tick's characters. */
const BREAKS_APART = 1;

/**
 * scaleOf gives the legend of `classes` in `wide` px: a swatch per class from
 * the furthest below zero where `signed` to the furthest above, in its `fill`,
 * SWATCH_WIDE or fewer px each, and the breaks between them written under
 * them, at the finest stride whose labels stand apart in characters `ch` px
 * wide and that writes zero.
 */
export function scaleOf(
  classes: Classes,
  signed: boolean,
  wide: number,
  ch: number,
  fill: (step: number) => string | undefined = fillOf,
): HTMLElement {
  const count = classes.breaks.length;
  const steps = Array.from({ length: count }, (_, i) => i + 1);
  const shown = signed ? [...steps.map((k) => -k).reverse(), ...steps] : steps;
  const up = [0, ...classes.breaks];
  const values = signed ? [...classes.breaks.map((b) => -b).reverse(), ...up] : up;
  const labels = values.map((v) => num(v));
  const swatch = Math.min(SWATCH_WIDE, Math.floor(wide / shown.length));
  const last = labels.length - 1;
  // The first break stands from its edge on, the last up to its edge, the rest centred on theirs,
  // so a stride fits when an end's label and half the next fit between their edges.
  const toward = (i: number): number => (i === 0 ? 0 : i === last ? 1 : 1 / 2);
  const widest = Math.max(...labels.map((label) => label.length));
  const needs = (widest * (1 + 1 / 2) + BREAKS_APART) * ch;
  const strides = [...STRIDES.filter((s) => count % s === 0), count];
  const stride = strides.find((s) => s * swatch >= needs) ?? count;
  const box = el("div", "chart-scale");
  box.style.setProperty("--swatch", `${swatch}px`);
  for (const k of shown) {
    const key = el("span", "chart-swatch");
    key.style.setProperty("--fill", fill(k)!);
    box.append(key);
  }
  for (const [i, label] of labels.entries()) {
    if (i % stride !== 0) continue;
    const tick = el("span", "chart-tick", label);
    tick.style.setProperty("--at", `${i}`);
    tick.style.setProperty("--toward", `${toward(i)}`);
    box.append(tick);
  }
  return box;
}
