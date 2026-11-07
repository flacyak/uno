/**
 * @fileoverview A .uno of the sales export and a second one beside it, holding
 * charts, for the tests of a workspace's charts.
 */

import { basename } from "node:path";

import { newManifest, writeDocument } from "@document";
import type { CarriedChart, Chart } from "@document";
import { REGION, REVENUE, ROWS, UNITS } from "@main/smoke/fixture";
import { BARS_INSET, BAR_GAP, BAR_THICK } from "@renderer/chart/bars";
import { FIXTURE, SECOND } from "./smoke/dom-harness.ts";

/** The sales export's source, and the second export's. */
export const SALES = "sales-q3";
export const ADS = "google-ads-sales";

/** The sales export's date, region, rep, channel, units and revenue. */
const COLS = 6;

/** Rows per region of the sales export. */
export const BARS: Chart = {
  id: "c1",
  source: SALES,
  plot: { t: "bars", by: { col: REGION, header: "region" } },
  title: "",
  place: { x: 1, y: 0, width: 420, height: 260 },
  refresh: 0,
};

/** Revenue against units of the sales export. */
export const SCATTER: Chart = {
  ...BARS,
  id: "c4",
  plot: {
    t: "scatter",
    x: { col: UNITS, header: "units" },
    y: { col: REVENUE, header: "revenue" },
  },
};

/** Each region's share of the sales export's rows. */
export const PIE: Chart = {
  ...BARS,
  id: "c5",
  plot: { t: "pie", by: { col: REGION, header: "region" } },
};

/** The second export's Device column, which writes nine values. */
const DEVICE = 11;

/** Each Device's share of the second export's rows: six slices and an Other. */
export const DEVICES: Chart = {
  ...PIE,
  id: "c6",
  source: ADS,
  plot: { t: "pie", by: { col: DEVICE, header: "Device" } },
};

/** Where a person left a window. */
export const MOVED = { x: 0.25, y: 0.5, width: 300, height: 200 };

/** A plot's height that holds `rows` rows of bars or words, and not one more. */
export const holding = (rows: number): number =>
  2 * BARS_INSET + rows * BAR_THICK + (rows - 1) * BAR_GAP;

/** A short plot's rows: a bar in each but the last, which holds the line of the rest. */
export const SHORT_ROWS = 3;

/** The bytes of a .uno of both exports, holding `charts` and carrying
 * `carried`, with the sales export at `sales`. */
export function unoOf(charts: Chart[], carried: CarriedChart[] = [], sales = FIXTURE): Uint8Array {
  const held = { rows: ROWS, cols: COLS, state: { active: { row: 0, col: 0 } } };
  return writeDocument({
    manifest: newManifest(),
    sources: [
      { ...held, id: SALES, name: basename(FIXTURE), path: sales },
      { ...held, id: ADS, name: basename(SECOND), path: SECOND },
    ],
    active: SALES,
    log: [],
    charts,
    carriedCharts: carried,
    extra: new Map(),
    at: "",
  });
}
