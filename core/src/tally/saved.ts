/**
 * @fileoverview What a fold holds, as a save writes it and reads it back.
 */

/** isRecord says whether `v` is an object of named fields. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
