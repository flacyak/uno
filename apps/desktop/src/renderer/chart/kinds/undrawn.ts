/**
 * @fileoverview What a window draws of a kind whose record this build reads
 * and whose drawing it has not yet, so each such kind's build stands alone.
 */

import { m } from "@paraglide/messages";
import { el } from "@renderer/shell/util";
import type { Drawing } from "../kind.ts";
import { NONE } from "../tooltip.ts";

/** said gives the line the plot, and its table, say in place of a drawing. */
function said(): HTMLElement {
  const box = el("div", "chart-state");
  box.append(el("bdi", "", m.chart_not_drawn()));
  return box;
}

/** undrawn is the drawing of any tally of such a kind: a line that says so. */
export const undrawn: Drawing = {
  empty: false,
  draw: said,
  fit: () => undefined,
  targets: () => NONE,
  table: said,
  told: () => ({ span: "", each: [], more: 0 }),
  notes: () => [],
};
