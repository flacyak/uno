import { Zip, deflateSync, unzipSync } from "fflate";
import type { ZipInputFile } from "fflate";

import {
  compareStrings,
  concat,
  nowTruncated,
  parseTime,
  rfc3339,
  sha256Hex,
} from "../go/index.ts";
import { read as ingestRead } from "../ingest/index.ts";
import type { Edit, Op, Sheet } from "../sheet/index.ts";
import type {
  Document,
  FileSource,
  Held,
  HeldFile,
  HeldPart,
  HeldParts,
  Logged,
  Manifest,
  PartsSource,
  Source,
  SourcePart,
  State,
} from "./document.ts";
import {
  BASE_VERSION,
  FORMAT_VERSION,
  FORMULA_VERSION,
  GENERATOR,
  KNOWN_HEADER_MODES,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  PARTS_VERSION,
  POINTED_VERSION,
  RULE_VERSION,
  SOURCES_VERSION,
  STATE_ENTRY,
  isHeaderMode,
  logOf,
  resolvedPath,
  sourceEntry,
  sourceId,
  storedPath,
} from "./document.ts";
import { baseOf } from "./path.ts";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/**
 * readDocument reads a .uno from its bytes and builds a sheet for every
 * source whose bytes the file carries. The engine opens each pointed-at
 * source. `name` is used only in error messages.
 */
export function readDocument(name: string, bytes: Uint8Array, at = ""): Document {
  const doc = readContainer(name, bytes, at);

  // Each carried source is read the way a dropped file is, then its log is
  // replayed over it.
  const sheets = new Map<string, Sheet>();
  for (const src of doc.sources) {
    const raw = src.raw;
    if (raw === undefined) continue;
    const sheet = blamed(`${name}: embedded ${src.name}`, () => ingestRead(src.name, raw));
    blamed(`${name}: replaying edits to ${src.name}`, () => sheet.replay(logOf(doc.log, src.id)));
    sheets.set(src.id, sheet);
  }
  return { ...doc, sheets };
}

/**
 * readContainer reads a .uno as stored: the manifest, the bytes of each
 * carried source, the resolved path of each pointed-at source, the state,
 * the log and any entries beyond what this build knows.
 *
 * `at` is where the .uno is. Relative pointers are resolved from it. With
 * `at` empty, a relative pointer is returned as written.
 */
export function readContainer(name: string, bytes: Uint8Array, at = ""): Document {
  const entries = blamed(`${name} is not a readable .uno file`, () => unzipSync(bytes));

  const manifest = readJSON(name, entries, MANIFEST_ENTRY);

  // The format is checked before anything else is parsed, so a newer file is
  // refused as a newer file.
  const format = asNumber(asRecord(manifest)["format"]);
  if (format > FORMAT_VERSION) {
    throw new Error(
      `${name} was saved by a newer uno (format ${format}, this build reads ${FORMAT_VERSION}). Update uno to open it`,
    );
  }
  const m = parseManifest(name, manifest);

  const log = readLog(name, entries, m);
  const { active, states } = parseState(readJSON(name, entries, m.sheet.entry), m);
  const sources: Held[] = m.sources.map((src) => {
    const state = states.get(src.id) ?? { active: { row: 0, col: 0 } };
    return src.parts === undefined
      ? heldFile(name, entries, src, state, at)
      : heldParts(src, state, at);
  });

  return { manifest: m, sources, active, log, extra: readExtra(entries, m), at };
}

/** heldFile builds the in-memory form of one file source: its carried bytes,
 * or its path resolved from `at`. */
function heldFile(
  name: string,
  entries: Record<string, Uint8Array>,
  src: FileSource,
  state: State,
  at: string,
): HeldFile {
  return {
    id: src.id,
    name: src.name,
    raw: src.entry === "" ? undefined : carriedBytes(name, entries, src),
    path: src.path === "" ? undefined : resolvedPath(src.path, at),
    bytes: src.bytes,
    version: src.version === "" ? undefined : src.version,
    connection: src.connection === "" ? undefined : src.connection,
    rows: src.rows,
    cols: src.cols,
    state,
  };
}

/**
 * carriedBytes reads a carried source's entry and checks it against the
 * sha256 the manifest recorded. A mismatch is refused. A source whose hash
 * is "" is returned as is.
 */
function carriedBytes(
  name: string,
  entries: Record<string, Uint8Array>,
  src: FileSource,
): Uint8Array {
  const raw = readEntry(name, entries, src.entry);
  if (src.sha256 !== "" && sha256Hex(raw) !== src.sha256) {
    throw new Error(
      `${name}: ${src.entry} is not the ${src.name} the manifest describes: its sha256 does not match, so the file is damaged`,
    );
  }
  return raw;
}

/** heldParts builds the in-memory form of a parts source, with each part's
 * path resolved from `at`. */
function heldParts(src: PartsSource, state: State, at: string): HeldParts {
  return {
    id: src.id,
    name: src.name,
    connection: src.connection === "" ? undefined : src.connection,
    parts: src.parts.map((part): HeldPart => {
      const path = resolvedPath(part.path, at);
      return {
        name: part.name === "" ? baseOf(path) : part.name,
        path,
        bytes: part.bytes,
        version: part.version === "" ? undefined : part.version,
        skip: part.skip,
        unterminated: part.unterminated,
      };
    }),
    header: src.header,
    fileColumn: src.fileColumn ? true : undefined,
    rows: src.rows,
    cols: src.cols,
    state,
  };
}

/**
 * writeDocument lays out the container and returns its bytes.
 *
 * A carried source goes in byte for byte. A pointed-at source goes in as a
 * path. A workspace of one carried source uses the layout from before
 * format 4. A workspace of file sources only is written as format 5 wrote it.
 *
 * The measured manifest is written back onto `d.manifest`, so the next save
 * keeps the first save's `created` and callers can report what was written.
 */
export function writeDocument(d: Document): Uint8Array {
  if (d.sources.length === 0) throw new Error("a workspace with no sources has nothing to save");
  checkLog(d);
  const m = manifestFor(d);
  const single = m.format < SOURCES_VERSION;

  // Each entry carries the save time as its modification time.
  const mtime = m.modified ?? new Date();

  const entries: Entry[] = [
    { name: MANIFEST_ENTRY, bytes: encoder.encode(formatJSON(manifestJSON(m))) },
  ];
  d.sources.forEach((src, i) => {
    const { entry: named, sha256 } = m.sources[i]!;
    if (src.raw !== undefined && named !== undefined) {
      entries.push({ name: named, bytes: src.raw, key: sha256 });
    }
  });
  entries.push(
    { name: STATE_ENTRY, bytes: encoder.encode(formatJSON(stateJSON(d, single))) },
    { name: LOG_ENTRY, bytes: encoder.encode(formatLog(d.log, single)) },
  );

  // Extra entries go back in, in name order, so a saved file keeps the same
  // layout between saves.
  const named = new Set(entries.map((e) => e.name));
  for (const key of [...d.extra.keys()].sort(compareStrings)) {
    if (named.has(key)) continue;
    entries.push({ name: key, bytes: d.extra.get(key)! });
  }

  const out = pack(entries, mtime);
  d.manifest = m;
  return out;
}

// ------------------------------------------------------------- packing

/** One entry of the container. `key` is the hash a carried source's deflated
 * bytes are cached under between saves. */
interface Entry {
  name: string;
  bytes: Uint8Array;
  key?: string;
}

/** An entry's deflated bytes, with the size and CRC of the bytes before
 * deflation. */
interface Deflated {
  bytes: Uint8Array<ArrayBuffer>;
  size: number;
  crc: number;
}

/** The deflate level, on fflate's scale of 0 to 9. */
const DEFLATE_LEVEL = 6;

/** The zip compression method number for DEFLATE (APPNOTE.txt 4.4.5). */
const DEFLATE_METHOD = 8;

/**
 * The deflated bytes of the carried sources from the last save, keyed by
 * their sha256. A carried source's bytes stay the same between saves, so the
 * next save reuses the deflated form. Only the last save's entries are kept.
 */
let deflated = new Map<string, Deflated>();

/** squeeze deflates one entry's bytes and measures its size and CRC. */
function squeeze(bytes: Uint8Array): Deflated {
  return {
    bytes: deflateSync(bytes, { level: DEFLATE_LEVEL }),
    size: bytes.length,
    crc: crc32(bytes),
  };
}

/**
 * pack writes the entries as one zip, in the order given. Every entry goes
 * in already deflated, through fflate's streaming writer, so a deflate
 * cached from an earlier save is reused.
 */
function pack(entries: readonly Entry[], mtime: Date): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failed: Error | undefined;
  const zip = new Zip((err, chunk) => {
    if (err !== null) {
      failed ??= err;
      return;
    }
    chunks.push(chunk);
    total += chunk.length;
  });

  const kept = new Map<string, Deflated>();
  for (const { name, bytes, key } of entries) {
    const entry = (key === undefined ? undefined : deflated.get(key)) ?? squeeze(bytes);
    if (key !== undefined) kept.set(key, entry);
    const file: ZipInputFile = {
      filename: name,
      size: entry.size,
      crc: entry.crc,
      compression: DEFLATE_METHOD,
      mtime,
    };
    zip.add(file);
    if (failed !== undefined) break;
    // zip.add sets file.ondata. The deflated bytes go in through it in one
    // piece.
    file.ondata!(null, entry.bytes, true);
  }
  zip.end();
  if (failed !== undefined) throw failed;
  deflated = kept;

  return concat(chunks);
}

/** The reflected CRC-32 polynomial zip uses. */
const CRC32_POLYNOMIAL = 0xedb88320;
const BITS_PER_BYTE = 8;
const BYTE_VALUES = 1 << BITS_PER_BYTE;
const BYTE_MASK = BYTE_VALUES - 1;

/** The CRC-32 of each one-byte message. */
const CRC32_TABLE = ((): Int32Array => {
  const table = new Int32Array(BYTE_VALUES);
  for (let byte = 0; byte < BYTE_VALUES; byte++) {
    let c = byte;
    for (let bit = 0; bit < BITS_PER_BYTE; bit++) {
      c = (c & 1) === 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    table[byte] = c;
  }
  return table;
})();

/** crc32 computes the checksum a zip entry stores for its uncompressed bytes. */
function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & BYTE_MASK]! ^ (c >>> BITS_PER_BYTE);
  }
  return ~c >>> 0;
}

/**
 * checkLog refuses a document with a source whose id is "" or shared, a log
 * line naming a source outside it, or an active source outside it.
 */
function checkLog(d: Document): void {
  const ids = new Set<string>();
  for (const src of d.sources) {
    if (src.id === "") throw new Error(`${src.name} has no id to log its edits under`);
    if (ids.has(src.id)) throw new Error(`two sources are both called ${src.id}`);
    if (src.parts !== undefined) {
      checkParts(src);
    } else if ((src.raw === undefined) === (src.path === undefined)) {
      // A file source is carried or pointed at: exactly one of the two.
      throw new Error(
        src.raw === undefined
          ? `${src.name} has neither bytes to carry nor a path to point at`
          : `${src.name} is both carried and pointed at`,
      );
    }
    ids.add(src.id);
  }
  for (const l of d.log) {
    if (!ids.has(l.source))
      throw new Error(`edit ${l.edit.seq} names ${l.source}, which is not a source here`);
  }
  if (!ids.has(d.active)) throw new Error(`the active source ${d.active} is not a source here`);
}

/**
 * checkParts refuses an empty parts source, or one with a part whose path
 * is "".
 */
function checkParts(src: HeldParts): void {
  if (src.parts.length === 0) throw new Error(`${src.name} has no parts to point at`);
  src.parts.forEach((part, i) => {
    if (part.path === "") {
      throw new Error(
        `${src.name}: ${part.name} (part ${i + 1} of ${src.parts.length}) has no path to point at`,
      );
    }
  });
}

/**
 * manifestFor builds the manifest from what is being written: the format,
 * the generator, the timestamps, each source's entry and hash, and the edit
 * count. `created` is kept from the previous manifest when it has one.
 *
 * A pointed-at source's size is what the workspace holds, and its hash is
 * "".
 */
function manifestFor(d: Document): Manifest {
  const modified = nowTruncated();
  const format = formatFor(d.sources, d.log);
  const single = format < SOURCES_VERSION;
  return {
    ...d.manifest,
    format,
    generator: GENERATOR,
    modified,
    created: d.manifest.created ?? modified,
    sources: d.sources.map((src) =>
      src.parts === undefined ? fileSource(src, single, d.at) : partsSource(src, d.at),
    ),
    sheet: { entry: STATE_ENTRY },
    edits: { count: d.log.length, entry: LOG_ENTRY },
  };
}

/**
 * fileSource is what the manifest records of one file source, for a .uno
 * saved to `at`. The keys are in the order uno.json is written in.
 */
function fileSource(src: HeldFile, single: boolean, at: string): FileSource {
  return {
    id: src.id,
    name: src.name,
    // Connection and version apply to a pointed-at file only.
    connection: src.path === undefined ? "" : (src.connection ?? ""),
    bytes: src.raw?.length ?? src.bytes ?? 0,
    sha256: src.raw === undefined ? "" : sha256Hex(src.raw),
    entry:
      src.raw === undefined ? "" : single ? sourceEntry(src.name) : sourceEntry(src.name, src.id),
    path: src.path === undefined ? "" : storedPath(src.path, at),
    version: src.path === undefined ? "" : (src.version ?? ""),
    rows: src.rows,
    cols: src.cols,
  };
}

/**
 * partsSource is what the manifest records of a parts source, for a .uno
 * saved to `at`. Each part's path is stored the way a file source's path is.
 */
function partsSource(src: HeldParts, at: string): PartsSource {
  return {
    id: src.id,
    name: src.name,
    connection: src.connection ?? "",
    parts: src.parts.map((part): SourcePart => ({
      // The name is written only when the path's last piece differs from it.
      name: part.name === baseOf(part.path) ? "" : part.name,
      path: storedPath(part.path, at),
      bytes: part.bytes,
      version: part.version ?? "",
      skip: part.skip,
      unterminated: part.unterminated,
    })),
    header: src.header,
    fileColumn: src.fileColumn === true,
    rows: src.rows,
    cols: src.cols,
  };
}

/**
 * formatFor returns the lowest format version that can open this workspace:
 * PARTS_VERSION with a parts source, POINTED_VERSION with a pointed-at
 * source, SOURCES_VERSION with more than one source, and otherwise whatever
 * the log needs.
 */
export function formatFor(sources: readonly Held[], log: readonly Logged[]): number {
  if (sources.some((s) => s.parts !== undefined)) return PARTS_VERSION;
  if (sources.some((s) => s.path !== undefined)) return POINTED_VERSION;
  if (sources.length > 1) return SOURCES_VERSION;
  return versionFor(log.map((l) => l.edit));
}

/**
 * versionFor returns the lowest format version that can replay this log.
 */
export function versionFor(edits: readonly Edit[]): number {
  let v = BASE_VERSION;
  for (const e of edits) {
    if ((e.op as Op) === "set") continue;
    if ((e.op as Op) === "apply") {
      if (v < RULE_VERSION) v = RULE_VERSION;
      continue;
    }
    // Any operation newer than apply: a note, a bind or an unbind.
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
  return blamed(`${name}: ${entry}`, (): unknown => JSON.parse(decoder.decode(b)));
}

/**
 * blamed runs `read` and rethrows any error with `about` prefixed to its
 * message.
 */
function blamed<T>(about: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw new Error(`${about}: ${(err as Error).message}`);
  }
}

/**
 * readLog reads the log lines in order. A broken final line is dropped as a
 * truncated tail. Any earlier broken line is an error. So is a line naming
 * a source outside the manifest, or an edit numbered out of turn: each
 * source's edits must be numbered 1, 2, 3 in order.
 */
function readLog(name: string, entries: Record<string, Uint8Array>, m: Manifest): Logged[] {
  const entry = m.edits.entry;
  const lines = decoder.decode(readEntry(name, entries, entry)).split("\n");
  const ids = new Set(m.sources.map((s) => s.id));
  // A log written before format 4 had only one source, so its lines omit it.
  const only = m.sources.length === 1 ? m.sources[0]!.id : undefined;

  const log: Logged[] = [];
  const counted = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const where = `${name}: ${entry} line ${i + 1}`;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      if (i === lines.length - 1) break; // a truncated final line is dropped
      throw new Error(`${where}: ${(err as Error).message}`);
    }

    const named = asString(asRecord(raw)["source"]);
    const source = named === "" ? only : named;
    if (source === undefined || !ids.has(source)) {
      throw new Error(
        named === ""
          ? `${where} does not say which source it changed`
          : `${where} changes ${named}, which is not a source in this file`,
      );
    }
    const edit = parseEdit(where, raw);
    const expected = (counted.get(source) ?? 0) + 1;
    if (edit.seq !== expected) {
      throw new Error(
        `${where} is edit ${edit.seq} of ${source}, where edit ${expected} comes next`,
      );
    }
    counted.set(source, expected);
    log.push({ source, edit });
  }
  return log;
}

/**
 * readExtra collects the entries beyond those the manifest names, so the
 * next save writes them back.
 */
function readExtra(entries: Record<string, Uint8Array>, m: Manifest): Map<string, Uint8Array> {
  const known = new Set([MANIFEST_ENTRY, m.sheet.entry, m.edits.entry]);
  for (const s of m.sources) if (s.entry !== undefined && s.entry !== "") known.add(s.entry);

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

/** Whether a value is a byte count: a whole number of zero or more. */
function isByteCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isText(v: unknown): v is string {
  return typeof v === "string";
}

function isFlag(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/** The wording a refusal uses for each guard. */
const NOT = new Map<(v: unknown) => boolean, string>([
  [isText, "is not text"],
  [isFlag, "is neither true nor false"],
  [isByteCount, "is not a number of bytes"],
]);

/**
 * optional reads a field a record may leave out: undefined when absent, the
 * value when `is` holds, and otherwise an error naming `where`, the key and
 * the guard's wording.
 */
function optional<T>(
  o: Record<string, unknown>,
  key: string,
  is: (v: unknown) => v is T,
  where: string,
): T | undefined {
  const v = o[key];
  if (v !== undefined && !is(v)) throw new Error(`${where}: ${key} ${NOT.get(is)}`);
  return v;
}

/**
 * parseManifest reads either manifest layout into one shape with a list of
 * sources. Before format 4 a manifest held one `source` and the grid's shape
 * under `sheet`. That source gets the id a new workspace would give it.
 */
function parseManifest(name: string, v: unknown): Manifest {
  const o = asRecord(v);
  const sheet = asRecord(o["sheet"]);
  const edits = asRecord(o["edits"]);

  const listed = o["sources"];
  let sources: Source[];
  if (Array.isArray(listed)) {
    sources = listed.map((raw) => parseSource(name, asRecord(raw)));
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
        path: "",
        version: "",
        connection: "",
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
    // A file source needs an entry or a path.
    if (s.parts === undefined && s.entry === "" && s.path === "") {
      throw new Error(`${name}: ${s.name} has no entry in this file and no path to the original`);
    }
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
 * parseSource reads one of the manifest's sources: a parts source when it
 * has `parts`, otherwise a file source. A file source is read leniently,
 * with a missing key read as its zero value. Parts are read strictly, and a
 * bad list is refused naming the part.
 */
function parseSource(name: string, s: Record<string, unknown>): Source {
  const base = {
    id: asString(s["id"]),
    name: asString(s["name"]),
    connection: asString(s["connection"]),
    rows: asNumber(s["rows"]),
    cols: asNumber(s["cols"]),
  };
  if (s["parts"] === undefined) {
    return {
      ...base,
      bytes: asNumber(s["bytes"]),
      sha256: asString(s["sha256"]),
      entry: asString(s["entry"]),
      path: asString(s["path"]),
      version: asString(s["version"]),
    };
  }

  if (base.name === "") throw new Error(`${name}: the manifest names no source file`);
  const source = `${name}: ${base.name}`;

  // A source has exactly one of a path, an entry or parts.
  const one = asString(s["path"]) !== "" ? "a path" : asString(s["entry"]) !== "" ? "an entry" : "";
  if (one !== "") {
    throw new Error(
      `${source} has both ${one} and parts · a source is one file or several read as one`,
    );
  }

  const listed = s["parts"];
  if (!Array.isArray(listed)) throw new Error(`${source}: parts is not a list of files`);
  if (listed.length === 0) {
    throw new Error(`${source} has no parts · several files read as one need at least one`);
  }
  const parts = listed.map((raw, i) =>
    parsePart(`${source}: part ${i + 1} of ${listed.length}`, raw),
  );

  const known = KNOWN_HEADER_MODES.map((mode) => JSON.stringify(mode)).join(", ");
  const header = s["header"];
  if (header === undefined) {
    throw new Error(
      `${source} has parts and no header · it has to say whether they have a header row, as one of ${known}`,
    );
  }
  if (typeof header !== "string" || !isHeaderMode(header)) {
    throw new Error(
      `${source}: this build does not know header ${JSON.stringify(header)} · it reads ${known}`,
    );
  }
  const fileColumn = optional(s, "fileColumn", isFlag, source);
  return { ...base, parts, header, fileColumn: fileColumn ?? false };
}

/**
 * parsePart reads one part. `which` names it in an error before its path is
 * known. `skip` and `unterminated` default to 0 and false when missing.
 */
function parsePart(which: string, raw: unknown): SourcePart {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${which} is not a file with a path and bytes`);
  }
  const p = asRecord(raw);

  const path = p["path"];
  if (typeof path !== "string" || path === "") throw new Error(`${which} has no path`);
  const part = `${which} (${path})`;

  const bytes = p["bytes"];
  if (!isByteCount(bytes)) throw new Error(`${part} does not say how many bytes it is`);

  const partName = optional(p, "name", isText, part);
  const version = optional(p, "version", isText, part);
  const skip = optional(p, "skip", isByteCount, part);
  const unterminated = optional(p, "unterminated", isFlag, part);

  return {
    name: partName ?? "",
    path,
    bytes,
    version: version ?? "",
    skip: skip ?? 0,
    unterminated: unterminated ?? false,
  };
}

/**
 * parseState reads either state layout. Before format 4 the entry was one
 * grid's state. From format 4 it names the active source and holds one
 * state per source.
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

/**
 * parseEdit reads one log line. `where` names the line in an error. `seq`,
 * `row` and `col` must be whole numbers. The sheet checks the operation and
 * bounds the row and column.
 */
function parseEdit(where: string, v: unknown): Edit {
  const o = asRecord(v);
  for (const key of ["seq", "row", "col"] as const) {
    if (!Number.isInteger(o[key])) throw new Error(`${where}: ${key} is not a whole number`);
  }
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

// The key order below, and in fileSource and partsSource above, is the order
// uno.json is written in. JSON.stringify follows insertion order.
//
// `single` is the layout every build before format 4 reads: one source, and
// log lines that leave it implied.

function manifestJSON(m: Manifest): unknown {
  const head = {
    format: m.format,
    generator: m.generator,
    created: m.created === undefined ? undefined : rfc3339(m.created),
    modified: m.modified === undefined ? undefined : rfc3339(m.modified),
  };
  const edits = m.edits;

  if (m.format < SOURCES_VERSION) {
    // This layout holds one carried file.
    const s = m.sources[0]!;
    return {
      ...head,
      source: { name: s.name, bytes: s.bytes, sha256: s.sha256, entry: s.entry },
      sheet: { rows: s.rows, cols: s.cols, entry: m.sheet.entry },
      edits,
    };
  }
  return { ...head, sources: m.sources.map(sourceJSON), sheet: m.sheet, edits };
}

/**
 * sourceJSON writes a source's set fields only, so a file source has exactly
 * one of an entry and a path. A parts source writes each part's set fields
 * only.
 */
function sourceJSON(s: Source): unknown {
  if (s.parts !== undefined) {
    const parts = s.parts.map((p) => omitempty(p, "name", "version", "skip", "unterminated"));
    return { ...omitempty(s, "connection", "fileColumn"), parts };
  }
  return omitempty(s, "connection", "sha256", "entry", "path", "version");
}

/** omitempty returns `o` with each of `keys` dropped where its value is "",
 * 0 or false. */
function omitempty<T extends object>(o: T, ...keys: Array<keyof T>): Partial<T> {
  const empty = new Set<PropertyKey>(keys);
  const kept = Object.entries(o).filter(([k, v]) => !empty.has(k) || Boolean(v));
  return Object.fromEntries(kept) as Partial<T>;
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
    // Written only when a column is bound.
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

/** formatJSON indents with two spaces and ends with a newline. */
function formatJSON(v: unknown): string {
  return JSON.stringify(v, undefined, 2) + "\n";
}

/**
 * formatLog writes one edit per line as JSONL. A log cut short still
 * replays up to its last complete line.
 */
function formatLog(log: readonly Logged[], single: boolean): string {
  return log.map((l) => JSON.stringify(editJSON(l, single)) + "\n").join("");
}
