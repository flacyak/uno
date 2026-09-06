import { unzipSync, zipSync } from "fflate";

import { compareStrings, nowTruncated, parseTime, rfc3339, sha256Hex } from "../go/index.ts";
import { read as ingestRead } from "../ingest/index.ts";
import type { Edit, Op } from "../sheet/index.ts";
import type { Document, Manifest, State } from "./document.ts";
import {
  BASE_VERSION,
  FORMAT_VERSION,
  GENERATOR,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  RULE_VERSION,
  STATE_ENTRY,
  sourceEntry,
} from "./document.ts";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/**
 * readDocument restores a document from the bytes of a .uno.
 *
 * Nothing outside the container is consulted: no original file, no stored path,
 * no network. That is what lets the file open on a machine that has never seen
 * the CSV it was made from.
 *
 * `name` is only ever used to name the file in an error. An error dialog that
 * does not say which of twelve dropped files failed is useless.
 */
export function readDocument(name: string, bytes: Uint8Array): Document {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new Error(`${name} is not a readable .uno file: ${(err as Error).message}`);
  }

  const m = parseManifest(name, readJSON(name, entries, MANIFEST_ENTRY));

  // A reader that guesses at a layout it does not know will either crash or,
  // far worse, silently drop the entries it did not recognise and then save
  // that loss back over the original.
  if (m.format > FORMAT_VERSION) {
    throw new Error(
      `${name} was saved by a newer uno (format ${m.format}, this build reads ${FORMAT_VERSION}). Update uno to open it`,
    );
  }

  const raw = readEntry(name, entries, m.source.entry);

  // The same call a plain CSV takes. One way to build a sheet is the only
  // reason a restored workspace is guaranteed to match the one that was saved.
  let sheet;
  try {
    sheet = ingestRead(m.source.name, raw);
  } catch (err) {
    throw new Error(`${name}: embedded ${m.source.name}: ${(err as Error).message}`);
  }

  const edits = readLog(name, entries, m.edits.entry);
  try {
    sheet.replay(edits);
  } catch (err) {
    throw new Error(`${name}: replaying edits: ${(err as Error).message}`);
  }

  const state = parseState(readJSON(name, entries, m.sheet.entry));

  return { manifest: m, raw, state, edits, extra: readExtra(entries, m), sheet };
}

/**
 * writeDocument lays out the container.
 *
 * The source goes in byte for byte: uno has no opinion about your file's line
 * endings or quoting and must not acquire one by round-tripping it.
 *
 * The measured manifest is written back onto the document, so the next save
 * preserves the time of the first one and the status bar can report what was
 * written.
 */
export function writeDocument(d: Document): Uint8Array {
  const m = manifestFor(d);

  // fflate takes the modification time per entry, so `unzip -l` on a workspace
  // lists the save time rather than the 1980-00-00 a zero timestamp renders as.
  const mtime = m.modified ?? new Date();
  const entry = (bytes: Uint8Array): [Uint8Array, { mtime: Date }] => [bytes, { mtime }];

  const files: Record<string, [Uint8Array, { mtime: Date }]> = {
    [MANIFEST_ENTRY]: entry(encoder.encode(formatJSON(manifestJSON(m)))),
    [m.source.entry]: entry(d.raw),
    [STATE_ENTRY]: entry(encoder.encode(formatJSON(stateJSON(d.state)))),
    [LOG_ENTRY]: entry(encoder.encode(formatLog(d.edits))),
  };

  // The entries this build did not understand go back in, in name order rather
  // than in whatever order they were read, so the layout of a saved file does
  // not shuffle between saves that changed nothing.
  for (const key of [...d.extra.keys()].sort(compareStrings)) {
    if (key in files) continue;
    files[key] = entry(d.extra.get(key)!);
  }

  const out = zipSync(files, { level: 6 });
  d.manifest = m;
  return out;
}

/**
 * manifestFor measures the container from the container.
 *
 * Everything the file says about itself -- the sizes, the hash, the counts, the
 * entry names, the version -- is taken from what is actually being written, so
 * no code path can produce a manifest describing a different file. What the
 * caller supplies is what the writer cannot see: where the bytes came from,
 * when the document was first saved, and the shape of the sheet the log builds.
 */
function manifestFor(d: Document): Manifest {
  const modified = nowTruncated();
  const m: Manifest = {
    ...d.manifest,
    format: versionFor(d.edits),
    generator: GENERATOR,
    modified,
    created: d.manifest.created ?? modified,
    source: {
      ...d.manifest.source,
      bytes: d.raw.length,
      sha256: sha256Hex(d.raw),
      entry: sourceEntry(d.manifest.source.name),
    },
    sheet: { ...d.manifest.sheet, entry: STATE_ENTRY },
    edits: { count: d.edits.length, entry: LOG_ENTRY },
  };
  return m;
}

/**
 * versionFor is the oldest build that could replay this log.
 *
 * An operation an older uno does not know is not a thing to fail on halfway
 * through a replay, so a file carrying one says so in the manifest and the
 * reader refuses it by name before a single entry is decoded.
 */
export function versionFor(edits: Edit[]): number {
  let v = BASE_VERSION;
  for (const e of edits) {
    if ((e.op as Op) === "set") continue;
    if ((e.op as Op) === "apply") {
      if (v < RULE_VERSION) v = RULE_VERSION;
      continue;
    }
    // Anything newer than a rule, which today means a binding. A build that
    // does not know the operation cannot replay the log, and a column it
    // silently skipped would open as an empty one.
    return FORMAT_VERSION;
  }
  return v;
}

// -------------------------------------------------------------- reading

function readEntry(name: string, entries: Record<string, Uint8Array>, entry: string): Uint8Array {
  if (entry === "") {
    throw new Error(`${name}: the manifest names no entry for this part of the file`);
  }
  const b = entries[entry];
  if (b === undefined) throw new Error(`${name}: ${entry}: no such entry in this file`);
  return b;
}

function readJSON(name: string, entries: Record<string, Uint8Array>, entry: string): unknown {
  const b = readEntry(name, entries, entry);
  try {
    return JSON.parse(decoder.decode(b));
  } catch (err) {
    throw new Error(`${name}: ${entry}: ${(err as Error).message}`);
  }
}

/**
 * readLog reads the operations in order and tolerates exactly one thing: a
 * final line cut in half.
 *
 * Anything unparseable earlier in the file is a log that has been damaged in
 * the middle, where stopping would silently discard the operations after it, so
 * that is an error.
 */
function readLog(name: string, entries: Record<string, Uint8Array>, entry: string): Edit[] {
  const lines = decoder.decode(readEntry(name, entries, entry)).split("\n");

  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      if (i === lines.length - 1) break; // a truncated tail costs the last operation, at worst
      throw new Error(`${name}: ${entry} line ${i + 1}: ${(err as Error).message}`);
    }
    edits.push(parseEdit(raw));
  }
  return edits;
}

/**
 * readExtra keeps whatever this build did not recognise, so it survives to the
 * next save. Version skew is only survivable if an older uno hands back the
 * entries it could not read.
 */
function readExtra(entries: Record<string, Uint8Array>, m: Manifest): Map<string, Uint8Array> {
  const known = new Set([MANIFEST_ENTRY, m.source.entry, m.sheet.entry, m.edits.entry]);

  const extra = new Map<string, Uint8Array>();
  for (const [key, bytes] of Object.entries(entries)) {
    if (known.has(key) || key.endsWith("/")) continue;
    extra.set(key, bytes);
  }
  return extra;
}

// ------------------------------------------------------------- shaping

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function asNumber(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseManifest(name: string, v: unknown): Manifest {
  const o = asRecord(v);
  const source = asRecord(o["source"]);
  const sheet = asRecord(o["sheet"]);
  const edits = asRecord(o["edits"]);

  const m: Manifest = {
    format: asNumber(o["format"]),
    generator: asString(o["generator"]),
    created: parseTime(asString(o["created"])),
    modified: parseTime(asString(o["modified"])),
    source: {
      name: asString(source["name"]),
      bytes: asNumber(source["bytes"]),
      sha256: asString(source["sha256"]),
      entry: asString(source["entry"]),
    },
    sheet: {
      rows: asNumber(sheet["rows"]),
      cols: asNumber(sheet["cols"]),
      entry: asString(sheet["entry"]),
    },
    edits: { count: asNumber(edits["count"]), entry: asString(edits["entry"]) },
  };
  if (m.source.name === "") throw new Error(`${name}: the manifest names no source file`);
  return m;
}

function parseState(v: unknown): State {
  const o = asRecord(v);
  const active = asRecord(o["active"]);
  const state: State = { active: { row: asNumber(active["row"]), col: asNumber(active["col"]) } };

  const refs = o["columnFormulas"];
  if (Array.isArray(refs)) {
    const out = refs.map((r) => {
      const e = asRecord(r);
      return { col: asNumber(e["col"]), ref: asString(e["ref"]) };
    });
    if (out.length > 0) state.columnFormulas = out;
  }
  return state;
}

function parseEdit(v: unknown): Edit {
  const o = asRecord(v);
  const e: Edit = {
    seq: asNumber(o["seq"]),
    op: asString(o["op"]) as Op,
    row: asNumber(o["row"]),
    col: asNumber(o["col"]),
    now: asString(o["now"]),
  };
  const was = o["was"];
  if (typeof was === "string" && was !== "") e.was = was;
  return e;
}

// ------------------------------------------------------------- writing

// The key order below is the field order of the Go structs, because a person is
// expected to open this file and read it. JSON.stringify follows insertion
// order, so building the object in that order is the whole of what it takes.
//
// The one difference from Go's encoder is that it escapes `<`, `>` and `&` and
// this does not. The bytes differ; the value any reader parses out does not.

function manifestJSON(m: Manifest): unknown {
  return {
    format: m.format,
    generator: m.generator,
    created: m.created === undefined ? undefined : rfc3339(m.created),
    modified: m.modified === undefined ? undefined : rfc3339(m.modified),
    source: m.source,
    sheet: m.sheet,
    edits: m.edits,
  };
}

function stateJSON(s: State): unknown {
  return {
    active: s.active,
    // omitempty: a workspace with no bound columns writes no key at all.
    columnFormulas:
      s.columnFormulas !== undefined && s.columnFormulas.length > 0 ? s.columnFormulas : undefined,
  };
}

function editJSON(e: Edit): unknown {
  return {
    seq: e.seq,
    op: e.op,
    row: e.row,
    col: e.col,
    was: e.was !== undefined && e.was !== "" ? e.was : undefined,
    now: e.now,
  };
}

/** Indented, and newline-terminated the way Go's Encoder leaves it: someone
 * will open the zip and read this. */
function formatJSON(v: unknown): string {
  return JSON.stringify(v, undefined, 2) + "\n";
}

/**
 * formatLog writes one operation per line.
 *
 * JSONL and not JSON because a line appends without rewriting what came before,
 * stays readable in a diff, and survives a truncated tail: a log cut short
 * still replays up to its last complete line.
 */
function formatLog(edits: Edit[]): string {
  return edits.map((e) => JSON.stringify(editJSON(e)) + "\n").join("");
}
