/**
 * @fileoverview What a chart's caption says of how much of its source it has
 * read, from the coverage its latest tally carries: the share read while the
 * tally is partial, and the rows once it is complete.
 */

import type { Coverage, Tally } from "@engine";
import { m } from "@paraglide/messages";
import { percent } from "@renderer/locale";

/**
 * share gives how much of its source a tally has read, from 0 to 1. The total
 * is an estimate until the index completes, so the rows read can run past it,
 * and a source of no rows has none to read.
 */
function share({ rows, total }: Coverage): number {
  return total > 0 ? Math.min(rows / total, 1) : 0;
}

/**
 * coverage gives what the caption says of how much of its source a chart has
 * read: nothing before a tally, or of one that could not be read; the share
 * read while the tally is partial; and the rows once it is complete.
 */
export function coverage(latest: Tally | undefined): string {
  if (latest === undefined || latest.t === "unread") return "";
  const { rows, complete } = latest.coverage;
  if (complete) return m.rows_count({ count: rows });
  return m.chart_partial({ read: percent(share(latest.coverage)) });
}
