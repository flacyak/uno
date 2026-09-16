// How long the page waits before doing something a person did not ask for,
// in one place so what drives the page can wait on the same number.

/**
 * How long the window keeps the focus before its sources' buckets are asked
 * whether they hold something newer: long enough that alt-tabbing through
 * uno on the way somewhere else asks nothing, short enough that a person
 * coming back sees the mark before they look for it.
 */
export const NEWER_AFTER_MS = 400;
