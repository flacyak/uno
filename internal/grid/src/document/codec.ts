import { unzipSync, zipSync } from "fflate";

import { compareStrings, nowTruncated, parseTime, rfc3339, sha256Hex } from "../go/index.ts";
import { read as ingestRead } from "../ingest/index.ts";
import type { Edit, Op, Sheet } from "../sheet/index.ts";
import type { Document, Embedded, Logged, Manifest, Source, State } from "./document.ts";
import {
  BASE_VERSION,
  FORMAT_VERSION,
  FORMULA_VERSION,
  GENERATOR,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  RULE_VERSION,
  SOURCES_VERSION,
  STATE_ENTRY,
  logOf,
  sourceEntry,
  sourceId,
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
  const doc = readContainer(name, bytes);

  // The same call a plain CSV takes. One way to build a sheet is the only
  // reason a restored workspace is guaranteed to match the one that was saved.
  const sheets = new Map<string, Sheet>();
  for (const src of doc.sources) {
    let sheet;
    try {
      sheet = ingestRead(src.name, src.raw);
    } catch (err) {
      throw new Error(`${name}: embedded ${src.name}: ${(err as Error).message}`);
    }
    try {
      sheet.replay(logOf(doc.log, src.id));
    } catch (err) {
      throw new Error(`${name}: replaying edits to ${src.name}: ${(err as Error).message}`);
    }
    sheets.set(src.id, sheet);
  }
  return { ...doc, sheets };
}

/**
 * readContainer reads a .uno without building a sheet from it: the manifest,
 * each source's bytes, the state, the log and whatever this build did not
 * recognise. It is what the engine opens a workspace with, since the engine
 * reads each source through an index and replays the log over pages instead.
 */
export function readContainer(name: string, bytes: Uint8Array): Document {
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

  const log = readLog(name, entries, m);
  const { active, states } = parseState(readJSON(name, entries, m.sheet.entry), m);
  const sources: Embedded[] = m.sources.map((src) => ({
    id: src.id,
    name: src.name,
    raw: readEntry(name, entries, src.entry),
    rows: src.rows,
    cols: src.cols,
    state: states.get(src.id) ?? { active: { row: 0, col: 0 } },
  }));

  return { manifest: m, sources, active, log, extra: readExtra(entries, m) };
}

/**
 * writeDocument lays out the container.
 *
 * Each source goes in byte for byte: uno has no opinion about your file's line
 * endings or quoting and must not acquire one by round-tripping it.
 *
 * A workspace of one source is written the way every build before format 4
 * wrote one, so it still opens in them. Only a second source changes the
 * layout.
 *
 * The measured manifest is written back onto the document, so the next save
 * preserves the time of the first one and the status bar can report what was
 * written.
 */
export function writeDocument(d: Document): Uint8Array {
  if (d.sources.length === 0) throw new Error("a workspace with no sources has nothing to save");
  checkLog(d);
  const m = manifestFor(d);
  const single = m.format < SOURCES_VERSION;

  // fflate takes the modification time per entry, so `unzip -l` on a workspace
  // lists the save time rather than the 1980-00-00 a zero timestamp renders as.
  const mtime = m.modified ?? new Date();
  const entry = (bytes: Uint8Array): [Uint8Array, { mtime: Date }] => [bytes, { mtime }];

  const files: Record<string, [Uint8Array, { mtime: Date }]> = {
    [MANIFEST_ENTRY]: entry(encoder.encode(formatJSON(manifestJSON(m)))),
  };
  d.sources.forEach((src, i) => {
    files[m.sources[i]!.entry] = entry(src.raw);
  });
  files[STATE_ENTRY] = entry(encoder.encode(formatJSON(stateJSON(d, single))));
  files[LOG_ENTRY] = entry(encoder.encode(formatLog(d.log, single)));

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
 * checkLog refuses a document whose log names a source it does not hold, or
 * whose sources share an id. Either would write a file that replays edits
 * into the wrong grid, or into none.
 */
function checkLog(d: Document): void {
  const ids = new Set<string>();
  for (const src of d.sources) {
    if (src.id === "") throw new Error(`${src.name} has no id to log its edits under`);
    if (ids.has(src.id)) throw new Error(`two sources are both called ${src.id}`);
    ids.add(src.id);
  }
  for (const l of d.log) {
    if (!ids.has(l.source))
      throw new Error(`edit ${l.edit.seq} names ${l.source}, which is not a source here`);
  }
  if (!ids.has(d.active)) throw new Error(`the active source ${d.active} is not a source here`);
}

/**
 * manifestFor measures the container from the container.
 *
 * Everything the file says about itself -- the sizes, the hashes, the counts,
 * the entry names, the version -- is taken from what is actually being
 * written, so no code path can produce a manifest describing a different file.
 * What the caller supplies is what the writer cannot see: where the bytes came
 * from, when the document was first saved, and the shape of the grid each log
 * builds.
 */
function manifestFor(d: Document): Manifest {
  const modified = nowTruncated();
  const format = formatFor(d.sources.length, d.log);
  const single = format < SOURCES_VERSION;
  return {
    ...d.manifest,
    format,
    generator: GENERATOR,
    modified,
    created: d.manifest.created ?? modified,
    sources: d.sources.map((src): Source => ({
      id: src.id,
      name: src.name,
      bytes: src.raw.length,
      sha256: sha256Hex(src.raw),
      entry: single ? sourceEntry(src.name) : sourceEntry(src.name, src.id),
      rows: src.rows,
      cols: src.cols,
    })),
    sheet: { entry: STATE_ENTRY },
    edits: { count: d.log.length, entry: LOG_ENTRY },
  };
}

/**
 * formatFor is the oldest build that could open a workspace of `sources`
 * sources with this log: a second source needs the layout that lists them,
 * and one needs whatever its log does.
 */
export function formatFor(sources: number, log: readonly Logged[]): number {
  if (sources > 1) return SOURCES_VERSION;
  return versionFor(log.map((l) => l.edit));
}

/**
 * versionFor is the oldest build that could replay this log.
 *
 * An operation an older uno does not know is not a thing to fail on halfway
 * through a replay, so a file carrying one says so in the manifest and the
 * reader refuses it by name before a single entry is decoded.
 */
export function versionFor(edits: readonly Edit[]): number {
  let v = BASE_VERSION;
  for (const e of edits) {
    if ((e.op as Op) === "set") continue;
    if ((e.op as Op) === "apply") {
      if (v < RULE_VERSION) v = RULE_VERSION;
      continue;
    }
    // Anything newer than a rule, which today means a note or a binding. A
    // build that does not know the operation cannot replay the log, and a
    // column it silently skipped would open as an empty one.
    return FORMULA_VERSION;
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
 * that is an error. So is a line naming a source the manifest does not list,
 * since there is no grid to replay it into.
 */
function readLog(name: string, entries: Record<string, Uint8Array>, m: Manifest): Logged[] {
  const entry = m.edits.entry;
  const lines = decoder.decode(readEntry(name, entries, entry)).split("\n");
  const ids = new Set(m.sources.map((s) => s.id));
  // A log written before format 4 names no source, because it had only one.
  const only = m.sources.length === 1 ? m.sources[0]!.id : undefined;

  const log: Logged[] = [];
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

    const named = asString(asRecord(raw)["source"]);
    const source = named === "" ? only : named;
    if (source === undefined || !ids.has(source)) {
      throw new Error(
        named === ""
          ? `${name}: ${entry} line ${i + 1} does not say which source it changed`
          : `${name}: ${entry} line ${i + 1} changes ${named}, which is not a source in this file`,
      );
    }
    log.push({ source, edit: parseEdit(raw) });
  }
  return log;
}

/**
 * readExtra keeps whatever this build did not recognise, so it survives to the
 * next save. Version skew is only survivable if an older uno hands back the
 * entries it could not read.
 */
function readExtra(entries: Record<string, Uint8Array>, m: Manifest): Map<string, Uint8Array> {
  const known = new Set([MANIFEST_ENTRY, m.sheet.entry, m.edits.entry]);
  for (const s of m.sources) known.add(s.entry);

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

/**
 * parseManifest reads either layout into the one shape: a list of sources.
 *
 * Before format 4 a manifest held one `source`, and the grid's shape sat under
 * `sheet`. That source is given the id a new workspace would give it, so
 * adding a second one later leaves the first called what it was always going
 * to be called.
 */
function parseManifest(name: string, v: unknown): Manifest {
  const o = asRecord(v);
  const sheet = asRecord(o["sheet"]);
  const edits = asRecord(o["edits"]);

  const listed = o["sources"];
  let sources: Source[];
  if (Array.isArray(listed)) {
    sources = listed.map((raw) => {
      const s = asRecord(raw);
      return {
        id: asString(s["id"]),
        name: asString(s["name"]),
        bytes: asNumber(s["bytes"]),
        sha256: asString(s["sha256"]),
        entry: asString(s["entry"]),
        rows: asNumber(s["rows"]),
        cols: asNumber(s["cols"]),
      };
    });
  } else {
    const s = asRecord(o["source"]);
    const sourceName = asString(s["name"]);
    sources = [
      {
        id: sourceId(sourceName, []),
        name: sourceName,
        bytes: asNumber(s["bytes"]),
        sha256: asString(s["sha256"]),
        entry: asString(s["entry"]),
        rows: asNumber(sheet["rows"]),
        cols: asNumber(sheet["cols"]),
      },
    ];
  }

  if (sources.length === 0) throw new Error(`${name}: the manifest names no source file`);
  const ids = new Set<string>();
  for (const s of sources) {
    if (s.name === "") throw new Error(`${name}: the manifest names no source file`);
    if (s.id === "") throw new Error(`${name}: ${s.name} has no id in the manifest`);
    if (ids.has(s.id)) throw new Error(`${name}: two sources are both called ${s.id}`);
    ids.add(s.id);
  }

  return {
    format: asNumber(o["format"]),
    generator: asString(o["generator"]),
    created: parseTime(asString(o["created"])),
    modified: parseTime(asString(o["modified"])),
    sources,
    sheet: { entry: asString(sheet["entry"]) },
    edits: { count: asNumber(edits["count"]), entry: asString(edits["entry"]) },
  };
}

/**
 * parseState reads either layout: before format 4 the entry was one grid's
 * state, and from it on the entry names the source that was showing and
 * holds one state per source.
 */
function parseState(v: unknown, m: Manifest): { active: string; states: Map<string, State> } {
  const o = asRecord(v);
  const first = m.sources[0]!.id;
  const states = new Map<string, State>();

  const sheets = o["sheets"];
  if (!Array.isArray(sheets)) {
    states.set(first, parseSheetState(o));
    return { active: first, states };
  }

  for (const raw of sheets) {
    const s = asRecord(raw);
    states.set(asString(s["source"]), parseSheetState(s));
  }
  const named = asString(o["source"]);
  return { active: m.sources.some((s) => s.id === named) ? named : first, states };
}

function parseSheetState(o: Record<string, unknown>): State {
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
//
// `single` is the layout every build before format 4 reads: one source, and a
// log that does not say which.

function manifestJSON(m: Manifest): unknown {
  const head = {
    format: m.format,
    generator: m.generator,
    created: m.created === undefined ? undefined : rfc3339(m.created),
    modified: m.modified === undefined ? undefined : rfc3339(m.modified),
  };
  const edits = m.edits;

  if (m.format < SOURCES_VERSION) {
    const s = m.sources[0]!;
    return {
      ...head,
      source: { name: s.name, bytes: s.bytes, sha256: s.sha256, entry: s.entry },
      sheet: { rows: s.rows, cols: s.cols, entry: m.sheet.entry },
      edits,
    };
  }
  return { ...head, sources: m.sources, sheet: m.sheet, edits };
}

function stateJSON(d: Document, single: boolean): unknown {
  if (single) return sheetStateJSON(d.sources[0]!.state);
  return {
    source: d.active,
    sheets: d.sources.map((s) => ({ source: s.id, ...sheetStateJSON(s.state) })),
  };
}

function sheetStateJSON(s: State): { active: State["active"]; columnFormulas?: unknown } {
  return {
    active: s.active,
    // omitempty: a workspace with no bound columns writes no key at all.
    columnFormulas:
      s.columnFormulas !== undefined && s.columnFormulas.length > 0 ? s.columnFormulas : undefined,
  };
}

function editJSON(l: Logged, single: boolean): unknown {
  const e = l.edit;
  return {
    seq: e.seq,
    source: single ? undefined : l.source,
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
function formatLog(log: readonly Logged[], single: boolean): string {
  return log.map((l) => JSON.stringify(editJSON(l, single)) + "\n").join("");
}
