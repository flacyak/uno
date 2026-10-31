/**
 * @fileoverview A chart of the sales export, for the tests of a workspace's
 * charts.
 */

import type { Chart } from "@document";
import { REGION } from "@main/smoke/fixture";

/** Rows per region of the sales export. */
export const BARS: Chart = {
  id: "c1",
  source: "sales-q3",
  plot: { t: "bars", by: { col: REGION, header: "region" } },
  title: "",
  place: { x: 1, y: 0, width: 420, height: 260 },
  refresh: 0,
};
