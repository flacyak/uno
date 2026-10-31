/**
 * @fileoverview A .uno of the sales export and a second one beside it, holding
 * charts, for the tests of a workspace's charts.
 */

import { basename } from "node:path";

import { newManifest, writeDocument } from "@document";
import type { CarriedChart, Chart } from "@document";
import { REGION, ROWS } from "@main/smoke/fixture";
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

/** Where a person left a window. */
export const MOVED = { x: 0.25, y: 0.5, width: 300, height: 200 };

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
