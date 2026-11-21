/**
 * @fileoverview Checks of the catalogue's kinds under forced colours: each
 * kind's smoke workspace opened again as a high-contrast theme forces its
 * colours, every mark drawn in the text's colour, CanvasText, as bars and a
 * pie's slices are, and a shot of each.
 */

import type { Check } from "./check.ts";

/** A kind's smoke workspace, as smoke.js names it, its marks, and the property each wears its colour in. */
interface Forced {
  kind: string;
  workspace: string;
  marks: string;
  worn: "backgroundColor" | "fill" | "stroke";
}

/** The kinds whose marks draw in CanvasText. */
const KINDS: readonly Forced[] = [
  {
    kind: "histogram",
    workspace: "UNO_SMOKE_SPREAD",
    marks: ".chart-column",
    worn: "backgroundColor",
  },
  { kind: "box", workspace: "UNO_SMOKE_BOXED", marks: ".chart-box", worn: "backgroundColor" },
  { kind: "dots", workspace: "UNO_SMOKE_DOTTED", marks: ".chart-dot", worn: "backgroundColor" },
  {
    kind: "swarm",
    workspace: "UNO_SMOKE_SWARMED",
    marks: ".chart-swarm-dot",
    worn: "backgroundColor",
  },
  { kind: "slope", workspace: "UNO_SMOKE_SLOPED", marks: ".chart-slope-dot", worn: "fill" },
  {
    kind: "chord",
    workspace: "UNO_SMOKE_CHORDED",
    marks: ".chart-chord-arc:not(.hatched, .other)",
    worn: "fill",
  },
  {
    kind: "parallel",
    workspace: "UNO_SMOKE_PARALLELED",
    marks: ".chart-parallel-line",
    worn: "stroke",
  },
];

export const CHART_FORCED: Check[] = KINDS.map(({ kind, workspace, marks, worn }) => ({
  name: `a ${kind} chart's marks draw in CanvasText under forced colours`,
  send: ["menu:open-path", process.env[workspace] ?? ""],
  forced: true,
  shot: `forced-${kind}`,
  script: `
    const marks = () => [...document.querySelectorAll(${JSON.stringify(marks)})];
    if (!(await arrives(() => marks().length > 0))) return "no marks drew";
    const probe = document.createElement("div");
    probe.style.color = "CanvasText";
    document.body.append(probe);
    const text = getComputedStyle(probe).color;
    probe.remove();
    const off = marks().map((mark) => getComputedStyle(mark)[${JSON.stringify(worn)}]).filter((worn) => worn !== text);
    return off.length === 0 ? "" : off.length + " marks wear " + off[0] + " where CanvasText is " + text;
  `,
}));

/** The kinds whose cells wear the ramp's classes, which take an ordered hatch. */
const RAMPED = [
  { kind: "week", workspace: "UNO_SMOKE_WEEKLY", marks: ".chart-week-cell.chart-stepped" },
  { kind: "heat", workspace: "UNO_SMOKE_HEATED", marks: ".chart-heat-cell.chart-stepped" },
] as const;

export const CHART_FORCED_RAMP: Check[] = RAMPED.map(({ kind, workspace, marks }) => ({
  name: `a ${kind} chart's classes wear a hatch of CanvasText under forced colours, a different one per class`,
  send: ["menu:open-path", process.env[workspace] ?? ""],
  forced: true,
  shot: `forced-${kind}`,
  script: `
    const marks = () => [...document.querySelectorAll(${JSON.stringify(marks)})];
    if (!(await arrives(() => marks().length > 0))) return "no cells drew";
    const worn = marks().map((mark) => [mark.style.getPropertyValue("--step"), getComputedStyle(mark).backgroundImage]);
    const flat = worn.filter(([, image]) => !image.startsWith("repeating-linear-gradient"));
    if (flat.length > 0) return flat.length + " cells wear " + flat[0][1];
    const hatches = new Map(worn);
    return new Set(hatches.values()).size === hatches.size ? "" : "two classes wear one hatch";
  `,
}));

/**
 * A horizon's bands under forced colours: each band a hatch of its own, whose
 * pattern undoes its row's stretch, so the hatch's lines stand as far apart on
 * the screen in a wide row as in a narrow one.
 */
export const CHART_FORCED_HORIZON: Check = {
  name: "a horizon chart's bands wear a hatch of CanvasText under forced colours, at the same screen spacing in every row",
  send: ["menu:open-path", process.env["UNO_SMOKE_HORIZONS"] ?? ""],
  forced: true,
  shot: "forced-horizon",
  script: `
    const strips = () => [...document.querySelectorAll(".chart-horizon-bands")];
    if (!(await arrives(() => strips().length > 0 && strips().every((strip) => strip.querySelector("pattern[patternTransform]") !== null)))) {
      const fill = getComputedStyle(document.querySelector(".chart-horizon-band")).fill;
      return "the bands wear " + fill + " and no hatch fitted to their row";
    }
    for (const strip of strips()) {
      const { width, height } = strip.getBoundingClientRect();
      const across = strip.viewBox.baseVal.width;
      for (const band of strip.querySelectorAll(".chart-horizon-band")) {
        if (!getComputedStyle(band).fill.startsWith("url(")) return "a band wears " + getComputedStyle(band).fill;
      }
      for (const pattern of strip.querySelectorAll("pattern")) {
        const { a, b, c, d } = pattern.patternTransform.baseVal.consolidate().matrix;
        const [x, y] = [Math.hypot(a, c) * (width / across), Math.hypot(b, d) * height];
        if (Math.abs(x - 1) > 0.01 || Math.abs(y - 1) > 0.01) return "a hatch stretches " + x + " by " + y;
      }
    }
    return "";
  `,
};
