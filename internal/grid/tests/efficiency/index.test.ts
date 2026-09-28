// What indexing a file costs per byte and per row.
//
// The index pass reads a file once, start to end, and every row after that is
// served by range. On a 30 GB file that one read is the wait, so what matters
// is bytes per second through the scanner and bytes kept per row. The file is
// a synthetic 200 MB CSV with the things a scanner has to carry state for:
// quoted commas, quoted newlines, CRLF on some rows, and multi-byte
// characters. It is written to the temp directory once and reused.

import { closeSync, existsSync, openSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

import { afterEach, expect, test } from "vite-plus/test";

import { RowIndex, TUNING } from "../../src/engine/index.ts";
import type { Engine } from "../../src/engine/index.ts";
import { peekFormat } from "../../src/ingest/index.ts";
import type { ByteSource } from "../../src/store/index.ts";
import { diskProvider, nodeSource } from "../../src/store/node.ts";
import { SCREEN, connect, indexed, openOne } from "../engine/harness.ts";
import { record } from "./record.ts";
import type { Metric } from "./record.ts";

/** The file is this many bytes, give or take the last row. */
const FILE_BYTES = 200 << 20;
/** Named for its size, so a change to the generator makes a new file. */
const FILE = join(tmpdir(), `uno-index-${FILE_BYTES}.csv`);
/** Rows written per `writeSync`. */
const BATCH = 4096;

/** One in this many rows has a newline inside a quoted field. */
const NEWLINE_EVERY = 7;
/** One in this many rows ends in CRLF. */
const CRLF_EVERY = 5;
/** One in this many rows has a multi-byte character. */
const WIDE_EVERY = 3;

const HEADER = "id,customer,note,amount,city\n";
const LF = 0x0a;
const CUSTOMERS = ['"Okafor, Ada"', "Lindqvist", '"Diaz ""Pepe"" Ruiz"', "Nakamura"];
const CITIES = ["Lagos", "Malmö", "São Paulo", "東京", "Lyon"];

/** How many of the file's bytes a megabyte is. */
const MB = 1 << 20;
/** Milliseconds in a second. */
const SECOND_MS = 1000;

/** The least bytes per second the pass has to manage, read and scan together. */
const THROUGHPUT_FLOOR_MB_S = 150;
/**
 * The most the scanner may cost over a loop that only counts newlines in the
 * same bytes. That loop is the floor for anything that has to look at every
 * byte, and measuring against it in the same process keeps the bound about the
 * scanner and not the machine. A switch reached once per byte is six times it.
 */
const SCAN_OVER_COUNT_BUDGET = 3;
/** The most heap bytes the index may keep per row. A block start is 16 bytes over 1024 rows. */
const HEAP_PER_ROW_BUDGET = 1;
/** The most bytes a sniff may read to pick a delimiter and find the header. */
const SNIFF_BYTES_BUDGET = 64 << 10;
/**
 * The most a window asked for during the pass may wait, as a fraction of the
 * whole pass. One chunk of scanning out of 25 is 4%.
 */
const WINDOW_WAIT_FRACTION = 0.1;

/**
 * Picking the rows: a cheap, deterministic generator. The file is the same on
 * every machine, so the numbers are comparable.
 */
function* rows(): Generator<string> {
  for (let i = 0; ; i++) {
    const customer = CUSTOMERS[i % CUSTOMERS.length]!;
    const note =
      i % NEWLINE_EVERY === 0
        ? '"first line\nsecond line, with a comma"'
        : i % WIDE_EVERY === 0
          ? "naïve café"
          : "plain";
    const city = CITIES[i % CITIES.length]!;
    const end = i % CRLF_EVERY === 0 ? "\r\n" : "\n";
    yield `${i},${customer},${note},${(i * 37) % 100000}.${i % 100},${city}${end}`;
  }
}

/** writeFile writes the file once. Rows are written until the size is reached. */
function writeFile(): number {
  if (existsSync(FILE) && statSync(FILE).size >= FILE_BYTES) return countRows();
  const fd = openSync(FILE, "w");
  let written = writeSync(fd, HEADER);
  let count = 0;
  let batch: string[] = [];
  for (const row of rows()) {
    batch.push(row);
    count++;
    if (batch.length === BATCH) {
      written += writeSync(fd, batch.join(""));
      batch = [];
      if (written >= FILE_BYTES) break;
    }
  }
  closeSync(fd);
  return count;
}

/** countRows counts the rows a written file has, by the generator's rules. */
function countRows(): number {
  const size = statSync(FILE).size;
  let at = HEADER.length;
  let count = 0;
  for (const row of rows()) {
    at += Buffer.byteLength(row);
    count++;
    if (at >= size) break;
  }
  return count;
}

/** countNewlines is the loop every scanner has to at least be. */
function countNewlines(chunk: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < chunk.length; i++) if (chunk[i] === LF) n++;
  return n;
}

/** A gc the test can call, whether or not the process was started with one. */
function collector(): () => void {
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
}

/** counted wraps a source and counts the bytes read through it. */
function counted(src: ByteSource): { source: ByteSource; bytes: () => number } {
  let bytes = 0;
  return {
    bytes: () => bytes,
    source: {
      size: src.size,
      async read(offset, length) {
        const out = await src.read(offset, length);
        bytes += out.length;
        return out;
      },
      close: () => src.close(),
    },
  };
}

let engine: Engine | undefined;
let done: (() => void) | undefined;
afterEach(() => {
  done?.();
  engine = undefined;
  done = undefined;
});

test("the index pass scans bytes at disk speed and keeps little per row", async () => {
  const expected = writeFile();
  const gc = collector();
  const metrics: Metric[] = [];

  // The sniff: what it reads to pick a delimiter and find the header.
  const src = await nodeSource(FILE);
  const sniffed = counted(src);
  const format = await peekFormat("index.csv", sniffed.source);
  if (format === undefined) throw new Error("the file read as empty");
  metrics.push({ name: "index: bytes read to sniff", unit: "bytes", value: sniffed.bytes() });
  expect(sniffed.bytes()).toBeLessThanOrEqual(SNIFF_BYTES_BUDGET);
  expect(format.delimiter).toBe(",");
  expect(format.columns).toEqual(["id", "customer", "note", "amount", "city"]);

  // The pass itself, read and scan timed apart, with the heap measured around it.
  const index = new RowIndex(format.dataStart, src.size, TUNING);
  const scanner = format.scanner((offset) => index.begin(offset));
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let readMs = 0;
  let countMs = 0;
  let scanMs = 0;
  let newlines = 0;
  for (let at = format.dataStart; at < src.size;) {
    const t0 = performance.now();
    const chunk = await src.read(at, Math.min(TUNING.chunkBytes, src.size - at));
    const t1 = performance.now();
    newlines += countNewlines(chunk);
    const t2 = performance.now();
    scanner.push(chunk, at);
    scanMs += performance.now() - t2;
    countMs += t2 - t1;
    readMs += t1 - t0;
    at += chunk.length;
    index.scanned = at;
  }
  index.complete = true;
  gc();
  const heapPerRow = (process.memoryUsage().heapUsed - heapBefore) / index.counted;
  await src.close();

  expect(index.counted).toBe(expected);
  // Every row ends in one, and one in NEWLINE_EVERY holds another.
  expect(newlines).toBeGreaterThan(expected);
  const scanned = src.size - format.dataStart;
  const scanOverCount = scanMs / countMs;
  metrics.push(
    { name: "index: read ms per 200 MB", unit: "ms", value: Math.round(readMs) },
    { name: "index: scan ms per 200 MB", unit: "ms", value: Math.round(scanMs) },
    { name: "index: scan time over a newline count", unit: "x", value: scanOverCount },
    { name: "index: heap bytes kept per row", unit: "bytes", value: heapPerRow },
  );
  expect(scanOverCount).toBeLessThanOrEqual(SCAN_OVER_COUNT_BUDGET);
  expect(heapPerRow).toBeLessThanOrEqual(HEAP_PER_ROW_BUDGET);
  const scanRate = scanned / MB / (scanMs / SECOND_MS);
  expect(scanRate).toBeGreaterThanOrEqual(THROUGHPUT_FLOOR_MB_S);

  // End to end through the engine, with a window asked for during the pass.
  ({ engine, done } = connect(TUNING, [diskProvider()]));
  const began = performance.now();
  const handle = await openOne(engine, { name: "index.csv", path: FILE });
  const firstProgress = new Promise<void>((resolve) => {
    handle.onProgress = (p) => {
      if (p.readable > 0) resolve();
    };
  });
  await firstProgress;
  const asked = performance.now();
  const reply = await handle.rows(0, SCREEN);
  const answered = performance.now() - asked;
  const completeBeforeAnswer = handle.progress.complete;
  await indexed(handle);
  const passMs = performance.now() - began;

  expect(reply.rows.length).toBe(SCREEN);
  expect(reply.rows[0]![1]).toBe("Okafor, Ada");
  expect(completeBeforeAnswer).toBe(false);
  expect(handle.progress.rows).toBe(expected);
  metrics.push(
    { name: "index: pass ms per 200 MB through the engine", unit: "ms", value: Math.round(passMs) },
    { name: "index: window asked mid-pass, ms to answer", unit: "ms", value: Math.round(answered) },
  );
  expect(answered).toBeLessThanOrEqual(passMs * WINDOW_WAIT_FRACTION);
  expect(src.size / MB / (passMs / SECOND_MS)).toBeGreaterThanOrEqual(THROUGHPUT_FLOOR_MB_S);

  record("index", metrics);
}, 120_000);
