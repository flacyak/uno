// Package library parses and formats .unof files, one per formula or
// connection. It works on text alone.

import { rfc3339, runes } from "../go/index.ts";
import { CONNECTION_KIND } from "./connection.ts";
import { about, extraOf, readUnof, stamp, textOf, timeOf, writeExtra, wrongKind } from "./unof.ts";

// A connection is a .unof too. Re-exported so `@uno/grid/library` covers every
// kind of .unof.
export {
  CONNECTION_KIND,
  covering,
  covers,
  formatConnection,
  parseConnection,
  secretIn,
  stampConnection,
  validConnection,
} from "./connection.ts";
export type { Auth, AuthMode, Connection, ConnectionProvider } from "./connection.ts";

/**
 * FORMAT_VERSION is the highest layout this build reads, and the one it
 * writes.
 */
export const FORMAT_VERSION = 1;

/** The extension every .unof shares. */
export const EXT = ".unof";

/** Kind is which kind of formula a .unof holds. */
export type Kind = "column" | "notation";

/** Formula is one .unof, holding what the file holds. */
export interface Formula {
  format: number;
  id: string;
  name: string;
  /**
   * "column" binds arithmetic to a whole column: it reads other columns and
   * recalculates when they change. "notation" is markdown placed in one cell.
   */
  kind: Kind;
  /** Arithmetic for a column formula, markdown for a notation one. */
  expr: string;
  /**
   * The columns the expression reads, by name, resolved on apply. Absent for
   * a notation formula.
   */
  refs?: string[];
  created: Date | undefined;
  modified: Date | undefined;

  /** The keys beyond this build's own, carried through to the next save. */
  extra?: Map<string, unknown>;
}

/** The keys this build owns. Anything else in the file goes into `extra`. */
const KNOWN_KEYS = new Set(["format", "id", "name", "kind", "expr", "refs", "created", "modified"]);
const isKnown = (key: string): boolean => KNOWN_KEYS.has(key);

/**
 * MAX_ID_LEN leaves room under the 255-byte filename limit for the extension.
 */
const MAX_ID_LEN = 200;

/**
 * validID checks an id before it becomes a filename. It refuses an empty id,
 * one over MAX_ID_LEN bytes, one starting with a dot, one holding `/`, `\`
 * or `:`, and one holding a control character.
 */
export function validID(id: string, what = "formula"): void {
  if (id === "") throw new Error(`a ${what} with no id has no file to be saved in`);

  const bytes = new TextEncoder().encode(id).length;
  if (bytes > MAX_ID_LEN) {
    throw new Error(
      `${what} id ${JSON.stringify(id)} is ${bytes} bytes, longer than a filename may be`,
    );
  }
  // A leading dot covers "." and "..", hidden files, and the temp files of an
  // atomic write.
  if (id.startsWith(".")) {
    throw new Error(`${what} id ${JSON.stringify(id)} may not start with a dot`);
  }
  for (const r of runes(id)) {
    if (r === "/" || r === "\\" || r === ":") {
      throw new Error(`${what} id ${JSON.stringify(id)} may not name a path`);
    }
    const cp = r.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) {
      throw new Error(`${what} id ${JSON.stringify(id)} contains a control character`);
    }
  }
}

/** fileName is the only place an id becomes a path. It runs `validID` first. */
export function fileName(id: string, what = "formula"): string {
  validID(id, what);
  return id + EXT;
}

/**
 * parseFormula reads one .unof from its text. `name` is only used in error
 * messages.
 */
export function parseFormula(name: string, text: string): Formula {
  const { o, format } = readUnof(name, text);

  // A connection .unof in the formula folder is refused by name.
  const kind = o["kind"];
  if (kind !== "column" && kind !== "notation") {
    throw wrongKind(name, kind, "formula", {
      kinds: [CONNECTION_KIND],
      is: "a connection",
      dir: "connections/",
    });
  }

  const f: Formula = {
    format,
    id: textOf(o, "id"),
    name: textOf(o, "name"),
    kind,
    expr: textOf(o, "expr"),
    created: timeOf(o, "created"),
    modified: timeOf(o, "modified"),
  };

  const refs = o["refs"];
  if (Array.isArray(refs)) {
    const named = refs.filter((r): r is string => typeof r === "string");
    if (named.length > 0) f.refs = named;
  }
  const extra = extraOf(o, isKnown);
  if (extra !== undefined) f.extra = extra;

  // The id is checked on the way in as well as on the way out.
  about(name, () => validID(f.id));
  return f;
}

/**
 * formatFormula renders a .unof. It stamps the format and the times: modified
 * is now, and created is set only the first time. Returns the text and the
 * stamped formula.
 */
export function formatFormula(f: Formula): { text: string; stamped: Formula } {
  validID(f.id);
  const stamped = stamp(f);

  // Known fields in declared order, then the unrecognised ones.
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
  writeExtra(out, stamped.extra, isKnown);

  // The expression is written verbatim: a "<" stays a "<".
  return { text: JSON.stringify(out, undefined, 2) + "\n", stamped };
}
