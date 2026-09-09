// Package library reads and writes the .unof files a person's formulas live in,
// one file per formula.
//
// A library could as easily be a single file holding all of them, and should
// not be. One file per formula makes the shareable unit the same as the
// editable unit: sending someone a formula is sending a file, "edit" beside a
// name opens that file, and an autosave on every keystroke rewrites 400 bytes
// rather than the whole library, so a bad write costs one formula instead of
// forty.
//
// Nothing here touches a filesystem. Parsing and formatting are the whole of
// it; where the files live is `store`'s business, and debouncing the autosave
// belongs to whatever owns the editor.

import { compareStrings, nowTruncated, parseTime, rfc3339, runes } from "../go/index.ts";

/**
 * FORMAT_VERSION is the highest layout this build reads, and the one it writes.
 * A .unof is meant to travel -- it is the whole reason a formula is a file -- so
 * the number is part of the promise made to whoever receives one.
 */
export const FORMAT_VERSION = 1;

/** The extension both kinds of formula share. They have almost nothing else in
 * common, but they open from the same drawer, so they save the same way. */
export const EXT = ".unof";

/** Which of the two things wearing the word "formula" this is. */
export type Kind = "column" | "notation";

/**
 * Formula is one .unof.
 *
 * What is absent is as decided as what is here. There is no usage history:
 * "recently used" is an ordering that belongs to this person on this machine,
 * and shipping it inside the formula would mean sending your habits along with
 * your arithmetic every time you shared one. There are no paths either, for the
 * reason a .uno has none: a file that only works where it was written is not
 * reusable anywhere.
 */
export interface Formula {
  format: number;
  id: string;
  name: string;
  /**
   * "column" binds arithmetic to a whole column: it reads other columns,
   * recalculates when they change, and can take part in a cycle. "notation" is
   * markdown placed in one cell: it reads nothing, depends on nothing, and
   * never changes again until a person edits it.
   */
  kind: Kind;
  /**
   * Arithmetic for a column formula and markdown for a notation one.
   *
   * Markdown, because a .unof is meant to be shared and markdown stays legible
   * to someone reading the file without uno: in a diff, in a chat window, in a
   * text editor.
   */
  expr: string;
  /**
   * The columns the expression reads, by name and resolved on apply, because a
   * column's position is a fact about one sheet rather than about the formula.
   *
   * A notation formula reads nothing, so it carries no refs key at all rather
   * than an empty list that would imply it could.
   */
  refs?: string[];
  created: Date | undefined;
  modified: Date | undefined;

  /**
   * The keys this build did not recognise, carried through to the next save.
   *
   * An older uno opening a file written by a newer one must not quietly drop
   * what it could not read and then write that loss back over the file -- the
   * same rule `document` keeps for entries it does not know.
   */
  extra?: Map<string, unknown>;
}

/** The keys this build owns. Anything else in the file goes into `extra`. */
const KNOWN_KEYS = new Set(["format", "id", "name", "kind", "expr", "refs", "created", "modified"]);

/**
 * maxIDLen is short of the 255 bytes filesystems stop at, leaving room for the
 * extension. The limit is here so the refusal names the id rather than arriving
 * from the kernel as ENAMETOOLONG halfway through an autosave.
 */
const MAX_ID_LEN = 200;

/**
 * validID checks the one value in a .unof that can reach outside the directory
 * it was read from.
 *
 * Formulas arrive from other people -- that is the point of making each one a
 * file -- so the id is checked before it is joined to a path, never after, and
 * both separators are refused on every platform because a file written on
 * Windows is expected to open here.
 */
export function validID(id: string): void {
  if (id === "") throw new Error("a formula with no id has no file to be saved in");

  const bytes = new TextEncoder().encode(id).length;
  if (bytes > MAX_ID_LEN) {
    throw new Error(
      `formula id ${JSON.stringify(id)} is ${bytes} bytes, longer than a filename may be`,
    );
  }
  // A leading dot covers "." and ".." without naming them, hides the file from
  // the person who owns it, and keeps an id away from the temp files an atomic
  // write is in the middle of renaming.
  if (id.startsWith(".")) {
    throw new Error(`formula id ${JSON.stringify(id)} may not start with a dot`);
  }
  for (const r of runes(id)) {
    if (r === "/" || r === "\\" || r === ":") {
      throw new Error(`formula id ${JSON.stringify(id)} may not name a path`);
    }
    const cp = r.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) {
      throw new Error(`formula id ${JSON.stringify(id)} contains a control character`);
    }
  }
}

/** fileName is the only place an id becomes a path, and `validID` is the only
 * thing standing between the two. */
export function fileName(id: string): string {
  validID(id);
  return id + EXT;
}

/**
 * parseFormula reads one .unof.
 *
 * Nothing outside the text is consulted, which is what lets a formula somebody
 * sent you open on a machine that has never had a library at all. `name` is
 * only used to name the file in an error.
 */
export function parseFormula(name: string, text: string): Formula {
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
  // A reader that guesses at a layout it does not know will either misread it
  // or, far worse, save what it misread back over the file.
  if (format > FORMAT_VERSION) {
    throw new Error(
      `${name} was saved by a newer uno (format ${format}, this build reads ${FORMAT_VERSION}). Update uno to open it`,
    );
  }

  const f: Formula = {
    format,
    id: typeof o["id"] === "string" ? o["id"] : "",
    name: typeof o["name"] === "string" ? o["name"] : "",
    kind: o["kind"] === "notation" ? "notation" : "column",
    expr: typeof o["expr"] === "string" ? o["expr"] : "",
    created: parseTime(typeof o["created"] === "string" ? o["created"] : undefined),
    modified: parseTime(typeof o["modified"] === "string" ? o["modified"] : undefined),
  };

  const refs = o["refs"];
  if (Array.isArray(refs)) {
    const named = refs.filter((r): r is string => typeof r === "string");
    if (named.length > 0) f.refs = named;
  }

  // Decoding into the known fields cannot see what it did not decode, so the
  // unrecognised keys are picked out here and kept beside them.
  const extra = new Map<string, unknown>();
  for (const [key, value] of Object.entries(o)) {
    if (!KNOWN_KEYS.has(key)) extra.set(key, value);
  }
  if (extra.size > 0) f.extra = extra;

  // The id is checked on the way in as well as on the way out, so no id that
  // could name a path is ever handed to a caller in the first place.
  try {
    validID(f.id);
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
  return f;
}

/**
 * formatFormula renders a .unof, stamping the version and the times.
 *
 * The timestamps are set here rather than taken from the caller: modified is
 * what this save is, and created is filled in only the first time, so a formula
 * cannot come to claim it was written after it was last edited. The stamped
 * formula is returned alongside the text so the caller can keep it.
 */
export function formatFormula(f: Formula): { text: string; stamped: Formula } {
  validID(f.id);

  const modified = nowTruncated();
  const stamped: Formula = {
    ...f,
    format: FORMAT_VERSION,
    modified,
    created: f.created ?? modified,
  };

  // The known fields in the order they are declared, then the unrecognised ones
  // in name order rather than in map order, so that a save which changed
  // nothing produces the same bytes as the one before it.
  const out: Record<string, unknown> = {
    format: stamped.format,
    id: stamped.id,
    name: stamped.name,
    kind: stamped.kind,
    expr: stamped.expr,
  };
  if (stamped.refs !== undefined && stamped.refs.length > 0) out["refs"] = stamped.refs;
  out["created"] = stamped.created === undefined ? undefined : rfc3339(stamped.created);
  out["modified"] = stamped.modified === undefined ? undefined : rfc3339(stamped.modified);

  for (const key of [...(stamped.extra?.keys() ?? [])].sort(compareStrings)) {
    if (KNOWN_KEYS.has(key)) continue; // a key this build owns is never written from extra
    out[key] = stamped.extra!.get(key);
  }

  // A comparison in an expression stays a "<" rather than becoming a "<".
  // Escaping it would cost exactly the legibility that made markdown the right
  // thing to store, and someone will read this file in a diff.
  return { text: JSON.stringify(out, undefined, 2) + "\n", stamped };
}
