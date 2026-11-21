/** @fileoverview A lat/lon map's kind, whose window says it is not drawn yet. */

import type { MapPlot } from "@document";
import { joined } from "@renderer/locale";
import type { ChartKind } from "../kind.ts";
import { named } from "./bars.ts";
import { undrawn } from "./undrawn.ts";

/** map is what a window does with a lat/lon map's plot, titled by its coordinates until it draws. */
export const map: ChartKind<MapPlot> = (plot) => ({
  title: () => joined([named(plot.lat), named(plot.lon)]),
  numbered: plot.sum === undefined ? [plot.lat, plot.lon] : [plot.lat, plot.lon, plot.sum],
  valued: [plot.lat, plot.lon],
  drawing: () => undrawn,
});
