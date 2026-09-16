// What every .unof has around what it is.
//
// A formula and a connection are each one small JSON file: an object, with a
// format number, a kind, an id, a name, two times, and whatever a later build
// wrote that this one does not know. Reading that envelope and writing it back
// the same way is here once, so the two codecs are about what differs: a
// formula's expression, a connection's bucket and how it signs in.

import { compareStrings, nowTruncated, parseTime } from "../go/index.ts";
import { FORMAT_VERSION } from "./index.ts";

/** The object a .unof holds, and the format it says it was saved as. */
export interface Envelope {
  o: Record<string, unknown>;
  format: number;
}

/**
 * readUnof reads the text of a .unof as far as every kind shares: it has to be
 * an object, and one this build knows the layout of. A reader that guesses at
 * a layout it does not know will either misread it or, far worse, save what it
 * misread back over the file. `name` is only used to name the file in an error.
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
 * wrongKind is the refusal for a .unof of another kind than the one asked for.
 * Other things are .unof files too, and one that lands in the wrong folder is
 * refused by name rather than read as an empty one of the kind expected, the
 * rule `document` keeps for what it does not recognise. `other` is the kinds
 * the sibling folder holds, named with what it is and where it belongs.
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

/** textOf is a field read as text, or "" where it is not there or not text. */
export function textOf(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

/** timeOf is a field read as an RFC 3339 time, or nothing where it is not there or not text. */
export function timeOf(o: Record<string, unknown>, key: string): Date | undefined {
  const v = o[key];
  return parseTime(typeof v === "string" ? v : undefined);
}

/**
 * extraOf is what this build did not decode: the keys it does not know, kept
 * beside the ones it does so the next save carries them. Decoding into the
 * known fields cannot see what it did not decode, so they are picked out here.
 * Nothing where there are none, so a file without them stays without them.
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
 * writeExtra puts the unrecognised keys after the known ones, in name order
 * rather than in map order, so that a save which changed nothing produces the
 * same bytes as the one before it. A key this build owns is never written from
 * extra.
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
 * stamp sets the times a save records: modified is now, and created is filled
 * in the first time only, so a file cannot come to claim it was made after it
 * was last changed. The format is this build's.
 */
export function stamp<T extends { format: number; created?: Date; modified?: Date }>(
  x: T,
  now: Date = nowTruncated(),
): T {
  return { ...x, format: FORMAT_VERSION, modified: now, created: x.created ?? now };
}

/** about runs `check`, and what it refuses is refused again naming the file. */
export function about<T>(name: string, check: () => T): T {
  try {
    return check();
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}
