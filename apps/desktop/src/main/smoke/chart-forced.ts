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
