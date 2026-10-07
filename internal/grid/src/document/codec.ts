import { Zip, deflateSync, unzipSync } from "fflate";
import type { ZipInputFile } from "fflate";

import { compareStrings, nowTruncated, parseTime, rfc3339, sha256Hex } from "../go/index.ts";
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
 * readDocument restores a document from the bytes of a .uno, and builds a sheet
 * for every source the file carries.
 *
 * It opens nothing: a source the workspace points at gets no sheet here,
 * because reading it means reading a file, and this module cannot. The engine
 * is what opens those, an index at a time. So `sheets` holds the carried
 * sources and `sources` holds them all, and a caller that wants the rest has
 * come to the wrong function.
 *
 * `name` is only ever used to name the file in an error. An error dialog that
 * does not say which of twelve dropped files failed is useless.
 */
export function readDocument(name: string, bytes: Uint8Array, at = ""): Document {
  const doc = readContainer(name, bytes, at);

  // The same call a plain CSV takes. One way to build a sheet is the only
  // reason a restored workspace is guaranteed to match the one that was saved.
  const sheets = new Map<string, Sheet>();
  for (const src of doc.sources) {
    if (src.raw === undefined) continue;
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
 * the bytes of each source it carries, where each source it points at is, the
 * state, the log and whatever this build did not recognise. It is what the
 * engine opens a workspace with, since the engine reads each source through an
 * index and replays the log over pages instead.
 *
 * `at` is where this .uno is, which is what the relative pointers in it are
 * read from. A caller that has no path for it -- a browser, a test holding
 * bytes -- passes nothing, and a relative pointer comes back as it was written
 * and fails to open under its own name.
 */
export function readContainer(name: string, bytes: Uint8Array, at = ""): Document {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new Error(`${name} is not a readable .uno file: ${(err as Error).message}`);
  }

  const manifest = readJSON(name, entries, MANIFEST_ENTRY);

  // A reader that guesses at a layout it does not know will either crash or,
  // far worse, silently drop the entries it did not recognise and then save
  // that loss back over the original.
  //
  // The format is the first thing read out of the manifest and the only thing
  // read before this, so a newer file is refused as a newer file whatever it
  // has done to the rest of the layout, and not as a broken one for holding a
  // kind of source this build has never heard of.
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

/** One file as the workspace holds it: the bytes the container carried for
 * it, or where it is, read from where the .uno is now. */
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
    raw: src.entry === "" ? undefined : readEntry(name, entries, src.entry),
    path: src.path === "" ? undefined : resolvedPath(src.path, at),
    bytes: src.bytes,
    version: src.version === "" ? undefined : src.version,
    connection: src.connection === "" ? undefined : src.connection,
    rows: src.rows,
    cols: src.cols,
    state,
  };
}

/** Several files read as one as the workspace holds them: where each part is,
 * read from where the .uno is now, and what the save measured of it. */
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
 * writeDocument lays out the container.
 *
 * A source the workspace carries goes in byte for byte: uno has no opinion
 * about your file's line endings or quoting and must not acquire one by
 * round-tripping it. A source it points at goes in as a path and costs the zip
 * nothing, which is the whole reason a workspace can hold a 30 GB ledger.
 *
 * A workspace of one carried source is written the way every build before
 * format 4 wrote one, so it still opens in them. A second source, or a pointer,
 * changes the layout. Several files read as one are the only thing that needs
 * format 6, and a workspace without them is written as format 5 wrote it, to
 * the byte.
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

  // The entries this build did not understand go back in, in name order rather
  // than in whatever order they were read, so the layout of a saved file does
  // not shuffle between saves that changed nothing.
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

/** One entry of the container. `key` is what a carried source's deflated
 * bytes are kept under between saves: the hash the manifest records of them. */
interface Entry {
  name: string;
  bytes: Uint8Array;
  key?: string;
}

/** An entry's bytes as the zip holds them, and what its header says of the
 * bytes they were. */
interface Deflated {
  bytes: Uint8Array<ArrayBuffer>;
  size: number;
  crc: number;
}

/** How hard an entry is squeezed, on fflate's scale of 0 to 9. */
const DEFLATE_LEVEL = 6;

/** The method a zip entry names DEFLATE by, from APPNOTE.txt section 4.4.5. */
const DEFLATE_METHOD = 8;

/**
 * What the last save deflated of the sources it carried, under the hash the
 * manifest recorded of each.
 *
 * A carried source's bytes never change: the log is what changes between one
 * save and the next. Deflating them is most of what a save costs -- the
 * better part of a second for 24 MB, during which the engine answers nothing
 * -- so the next save of the same bytes writes them as they were deflated the
 * first time. The hash is the key rather than the array, because a dropped
 * file is read into a fresh array at every save. What one save carried is
 * all that is kept, so this weighs at most one save's worth.
 */
let deflated = new Map<string, Deflated>();

/** squeeze deflates one entry's bytes, and measures what its header needs. */
function squeeze(bytes: Uint8Array): Deflated {
  return {
    bytes: deflateSync(bytes, { level: DEFLATE_LEVEL }),
    size: bytes.length,
    crc: crc32(bytes),
  };
}

/**
 * pack writes the entries as one zip, in the order given. Every entry goes in
 * deflated already, through fflate's streaming writer, which is what lets a
 * carried source deflated by an earlier save go in without being deflated
 * again.
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
    // Adding the file is what gives it `ondata`, and the bytes go in through
    // it, in one piece: there is nothing left to do to them.
    file.ondata!(null, entry.bytes, true);
  }
  zip.end();
  if (failed !== undefined) throw failed;
  deflated = kept;

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The CRC-32 polynomial, reflected, which is how a zip entry's checksum is computed. */
const CRC32_POLYNOMIAL = 0xedb88320;
const BITS_PER_BYTE = 8;
const BYTE_VALUES = 1 << BITS_PER_BYTE;
const BYTE_MASK = BYTE_VALUES - 1;

/** The CRC-32 of every one-byte message, which is what each byte of a longer one is folded through. */
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

/** crc32 is the checksum a zip entry carries of its bytes before deflation. */
function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & BYTE_MASK]! ^ (c >>> BITS_PER_BYTE);
  }
  return ~c >>> 0;
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
    if (src.parts !== undefined) {
      checkParts(src);
    } else if ((src.raw === undefined) === (src.path === undefined)) {
      // Neither is a source that would open as an empty grid and save over the
      // one it came from. Both is a file the reader has two answers for.
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
 * checkParts refuses several files read as one with no files, or with one
 * there is no path to: a part is always pointed at, so a part without a path
 * is a part the file could not say anything about.
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
 * manifestFor measures the container from the container.
 *
 * Everything the file says about itself -- the sizes, the hashes, the counts,
 * the entry names, the version -- is taken from what is actually being
 * written, so no code path can produce a manifest describing a different file.
 * What the caller supplies is what the writer cannot see: where the bytes came
 * from, when the document was first saved, and the shape of the grid each log
 * builds.
 *
 * A pointed-at source is the one thing not measured here, because measuring it
 * means reading it. Its size is what the workspace saw when it opened the file,
 * and it carries no hash at all: a hash nobody can afford to check is a field
 * that only ever goes stale.
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

/** What the manifest says of one file, for a .uno going to `at`. */
function fileSource(src: HeldFile, single: boolean, at: string): FileSource {
  return {
    id: src.id,
    name: src.name,
    bytes: src.raw?.length ?? src.bytes ?? 0,
    sha256: src.raw === undefined ? "" : sha256Hex(src.raw),
    entry:
      src.raw === undefined ? "" : single ? sourceEntry(src.name) : sourceEntry(src.name, src.id),
    path: src.path === undefined ? "" : storedPath(src.path, at),
    // Both are about the file pointed at, so a carried source has neither.
    version: src.path === undefined ? "" : (src.version ?? ""),
    connection: src.path === undefined ? "" : (src.connection ?? ""),
    rows: src.rows,
    cols: src.cols,
  };
}

/**
 * What the manifest says of several files read as one, for a .uno going to
 * `at`. Each part is written down the way a file source's path is, so a
 * folder of parts beside the workspace moves with it.
 */
function partsSource(src: HeldParts, at: string): PartsSource {
  return {
    id: src.id,
    name: src.name,
    connection: src.connection ?? "",
    parts: src.parts.map((part): SourcePart => ({
      // Only a name the path does not already say is worth a key.
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
 * formatFor is the oldest build that could open this workspace: several files
 * read as one need the layout that lists parts, a pointer the layout that can
 * hold one, a second source the layout that lists them, and one carried source
 * whatever its log needs.
 */
export function formatFor(sources: readonly Held[], log: readonly Logged[]): number {
  if (sources.some((s) => s.parts !== undefined)) return PARTS_VERSION;
  if (sources.some((s) => s.path !== undefined)) return POINTED_VERSION;
  if (sources.length > 1) return SOURCES_VERSION;
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

/** Whether a value out of a file is a count of bytes: a whole number, and not
 * a negative one. */
function isByteCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
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
    // A file source with neither would open as an empty grid and then save
    // over whatever it came from. Better to say so before anything is decoded.
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
 * parseSource reads one of the manifest's sources: one file, or several read
 * as one where it has `parts`.
 *
 * A file source is read the way it always was, a key at a time and with
 * nothing asked of a key that is missing. Parts are read strictly, because
 * every row's number depends on every part before it: a list that is not
 * quite what was written is refused, saying which part and what is wrong with
 * it, before a single file is opened.
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

  // One file and several at once is a source the reader has two answers for.
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
  const fileColumn = s["fileColumn"];
  if (fileColumn !== undefined && typeof fileColumn !== "boolean") {
    throw new Error(`${source}: fileColumn is neither true nor false`);
  }
  return { ...base, parts, header, fileColumn: fileColumn ?? false };
}

/**
 * parsePart reads one part. `which` is what an error calls it before its path
 * is known: the file, the source, and the part's place in the list.
 *
 * `skip` and `unterminated` are left out of the file where a part is there
 * whole and ends in a newline, which is what a missing key means.
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

  const partName = p["name"];
  if (partName !== undefined && typeof partName !== "string") {
    throw new Error(`${part}: name is not text`);
  }
  const version = p["version"];
  if (version !== undefined && typeof version !== "string") {
    throw new Error(`${part}: version is not text`);
  }
  const skip = p["skip"];
  if (skip !== undefined && !isByteCount(skip)) {
    throw new Error(`${part}: skip is not a number of bytes`);
  }
  const unterminated = p["unterminated"];
  if (unterminated !== undefined && typeof unterminated !== "boolean") {
    throw new Error(`${part}: unterminated is neither true nor false`);
  }

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
    // One carried file, which is the only source this layout can hold.
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

/** omitempty over the half that does not apply, so a person reading uno.json
 * sees either an entry or a path and never an empty one of each. Several files
 * read as one have neither, and a list of parts where a file has its path. */
function sourceJSON(s: Source): unknown {
  if (s.parts !== undefined) {
    return {
      id: s.id,
      name: s.name,
      connection: s.connection === "" ? undefined : s.connection,
      parts: s.parts.map(partJSON),
      header: s.header,
      fileColumn: s.fileColumn ? true : undefined,
      rows: s.rows,
      cols: s.cols,
    };
  }
  return {
    id: s.id,
    name: s.name,
    connection: s.connection === "" ? undefined : s.connection,
    bytes: s.bytes,
    sha256: s.sha256 === "" ? undefined : s.sha256,
    entry: s.entry === "" ? undefined : s.entry,
    path: s.path === "" ? undefined : s.path,
    version: s.version === "" ? undefined : s.version,
    rows: s.rows,
    cols: s.cols,
  };
}

/**
 * omitempty over what most parts do not have: a name the path does not say, a
 * version, a header to leave out, a last row with no newline. The first part
 * of a folder of exports on a disk is its path and its size.
 */
function partJSON(p: SourcePart): unknown {
  return {
    name: p.name === "" ? undefined : p.name,
    path: p.path,
    bytes: p.bytes,
    version: p.version === "" ? undefined : p.version,
    skip: p.skip === 0 ? undefined : p.skip,
    unterminated: p.unterminated ? true : undefined,
  };
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
