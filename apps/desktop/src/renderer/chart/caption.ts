/**
 * @fileoverview What a chart's caption says of how much of its source it has
 * read, from the coverage its latest tally carries: the share read while the
 * tally is partial, and the rows once it is complete. The track under the head
 * shows the same share while the chart reads.
 */

import type { Coverage, Tally } from "@engine";
import { m } from "@paraglide/messages";
import type { Heard } from "@renderer/charts";
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

/**
 * reading gives how far a chart has read its source, from 0 to 1, while it
 * reads: nothing of it before the first tally, and then the latest tally's
 * share until one completes. It is undefined where nothing is read: the tally
 * is complete, the chart cannot read its column, its source is missing or
 * waits on its bucket, or the chart has gone.
 */
export function reading(heard: Heard | undefined): number | undefined {
  if (heard === undefined || heard.state === "missing" || heard.state === "unconnected") {
    return undefined;
  }
  const { latest } = heard;
  if (latest === undefined) return 0;
  if (latest.t === "unread" || latest.coverage.complete) return undefined;
  return share(latest.coverage);
}
