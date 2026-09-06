// Package ingest turns bytes into a Sheet. It is the only module that knows a
// file had a delimiter, an encoding or a header row, so adding a format later
// never reaches the grid.

import { Sheet } from "../sheet/index.ts";
import { readAll } from "./csv.ts";
import { sniffDelimiter } from "./sniff.ts";

export { readAll } from "./csv.ts";
export { sniffDelimiter } from "./sniff.ts";

/** The extension, lower-cased, including its dot. "" when there is none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (dot < 0 || dot < slash) return "";
  return name.slice(dot).toLowerCase();
}

/**
 * read picks a decoder from the extension, then from the bytes. It is the only
 * entry point, which keeps format knowledge inside this module.
 *
 * It takes the bytes rather than a path: a .uno carries its source embedded,
 * and the web build has no filesystem to read one from.
 */
export function read(name: string, bytes: Uint8Array | string): Sheet {
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8").decode(bytes);

  switch (extensionOf(name)) {
    case ".json":
      throw new Error(`${name}: JSON is not supported yet`);
    case ".tsv":
      return readSeparated(name, text, "\t");
    default:
      return readSeparated(name, text, sniffDelimiter(text));
  }
}

function readSeparated(name: string, text: string, comma: string): Sheet {
  // Ragged rows are the norm in real exports, so short rows are tolerated
  // rather than made a reason to reject the file.
  const rows = readAll(text, comma);
  if (rows.length === 0) throw new Error(`${name}: file is empty`);

  const s = new Sheet(name, rows[0]!, rows.slice(1));
  s.source = describe(comma);
  return s;
}

/**
 * describe is how the status bar says what was guessed, so a wrong guess is
 * visible rather than silent.
 *
 * The quoting is Go's `%q` on a rune, which is a single-quoted character
 * literal rather than a double-quoted string.
 */
function describe(comma: string): string {
  if (comma === "\t") return "UTF-8 · tab-separated";
  return `UTF-8 · delimiter '${comma}'`;
}
