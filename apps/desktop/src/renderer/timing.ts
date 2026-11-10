/**
 * @fileoverview Delays the page uses before acting on its own. Shared here so
 * tests can wait on the same numbers.
 */

/**
 * How long the window must hold focus before the sources' buckets are asked
 * for a newer version.
 */
export const NEWER_AFTER_MS = 400;

/** A minute, the unit a chart's refresh schedule is kept in. */
export const MINUTE_MS = 60_000;

/**
 * How long a scheduled check waits for its source before it counts as failed.
 * A bucket's answer has no time limit of its own.
 */
export const CHECK_TIMEOUT_MS = 30_000;

/**
 * An hour, the longest a source whose checks keep failing waits for its next,
 * unless its own interval is longer.
 */
export const BACKOFF_CAP_MS = 60 * MINUTE_MS;
