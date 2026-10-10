// The envelope every .unof shares: a JSON object with a format number, a kind,
// an id, a name, two times, and any keys a later build wrote. Reading and
// writing it is here once, for the formula and connection codecs.

import { compareStrings, nowTruncated, parseTime } from "../go/index.ts";
import { FORMAT_VERSION } from "./index.ts";

/** The object a .unof holds, and the format it says it was saved as. */
export interface Envelope {
  o: Record<string, unknown>;
  format: number;
}

/**
 * readUnof parses the text as a JSON object and reads its format number. It
 * throws for unreadable JSON, an array, a scalar, and a format newer than
 * FORMAT_VERSION. `name` is only used in error messages.
 */
export function readUnof(name: string, text: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${name} is not a readable .unof file: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${name} is not a readable .unof file: not an object`);
  }
  const o = raw as Record<string, unknown>;
  const format = typeof o["format"] === "number" ? o["format"] : 0;
  if (format > FORMAT_VERSION) {
    throw new Error(
      `${name} was saved by a newer uno (format ${format}, this build reads ${FORMAT_VERSION}). Update uno to open it`,
    );
  }
  return { o, format };
}

/**
 * wrongKind builds the error for a .unof whose kind differs from `want`.
 * `other` names the kinds the sibling folder holds, what they are, and where
 * they belong.
 */
export function wrongKind(
  name: string,
  kind: unknown,
  want: string,
  other: { kinds: readonly string[]; is: string; dir: string },
): Error {
  if (typeof kind === "string" && other.kinds.includes(kind)) {
    return new Error(
      `${name} is ${other.is} ("kind": ${JSON.stringify(kind)}), not a ${want} · it belongs in ${other.dir}`,
    );
  }
  if (kind === undefined) return new Error(`${name} is not a ${want}: it has no kind`);
  return new Error(
    `${name} is not a ${want}: this build does not know kind ${JSON.stringify(kind)}`,
  );
}

/** textOf returns a field as text, or "" when absent. */
export function textOf(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

/**
 * timeOf returns a field as a Date, or undefined when absent.
 */
export function timeOf(o: Record<string, unknown>, key: string): Date | undefined {
  const v = o[key];
  return parseTime(typeof v === "string" ? v : undefined);
}

/**
 * extraOf collects the keys outside `known`. Returns undefined when every
 * key is known.
 */
export function extraOf(
  o: Record<string, unknown>,
  known: (key: string) => boolean,
): Map<string, unknown> | undefined {
  const extra = new Map<string, unknown>();
  for (const [key, value] of Object.entries(o)) {
    if (!known(key)) extra.set(key, value);
  }
  return extra.size > 0 ? extra : undefined;
}

/**
 * writeExtra copies the unrecognised keys into `out` in name order, after the
 * known ones. A known key in extra is skipped.
 */
export function writeExtra(
  out: Record<string, unknown>,
  extra: ReadonlyMap<string, unknown> | undefined,
  known: (key: string) => boolean,
): void {
  for (const key of [...(extra?.keys() ?? [])].sort(compareStrings)) {
    if (!known(key)) out[key] = extra!.get(key);
  }
}

/**
 * stamp sets format to FORMAT_VERSION, modified to `now`, and created to
 * `now` when it was unset.
 */
export function stamp<T extends { format: number; created?: Date; modified?: Date }>(
  x: T,
  now: Date = nowTruncated(),
): T {
  return { ...x, format: FORMAT_VERSION, modified: now, created: x.created ?? now };
}

/** about runs `check` and rethrows any error with `name` prefixed. */
export function about<T>(name: string, check: () => T): T {
  try {
    return check();
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}
