// Shared helpers for the engine tests: a client and `serve` joined by a real
// MessageChannel, the fixture, and row comparisons against a Sheet.

import { Engine, english, messagePort, serve } from "../../src/engine/index.ts";
import type {
  MessagePortLike,
  Reply,
  Request,
  Said,
  SourceHandle,
  SourceRef,
  Tuning,
} from "../../src/engine/index.ts";
import type { Connecting } from "../../src/engine/index.ts";
import { read } from "../../src/ingest/index.ts";
import { sources } from "../../src/plugin/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import type { Sheet } from "../../src/sheet/index.ts";
import { blobProvider, multiProvider } from "../../src/store/index.ts";
import type { Connections } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { bytes, FIXTURE } from "../testdata/sales-q3.ts";

// Re-exported from testdata/sales-q3.ts.
export { bytes, FIXTURE };
export const sales = read("sales-q3.csv", bytes);

/** The rows a viewport shows. */
export const SCREEN = 22;

/** Small enough that the 240 KB fixture spans hundreds of blocks and the cache has to evict. */
export const TINY: Tuning = { chunkBytes: 4096, blockRows: 7, blockBytes: 512, cacheBytes: 8192 };

/**
 * connect serves an engine over a real MessageChannel and returns a client
 * for it. `providers` go to `serve` as a platform would hand them.
 */
export function connect(
  tuning?: Tuning,
  providers: Provider[] = [diskProvider(), blobProvider()],
  connecting?: Connecting | Connections,
): { engine: Engine; done: () => void } {
  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
    sources(providers),
    tuning,
    // A bare Connections is wrapped as a Connecting holding only it.
    connecting === undefined || "connections" in connecting
      ? connecting
      : { connections: connecting },
  );
  const engine = new Engine(messagePort<Reply, Request>(port2 as unknown as MessagePortLike));
  return {
    engine,
    // Only the client's end is closed. Its close request is delivered to the
    // engine before the channel shuts, so the engine closes its own files.
    done: () => engine.close(),
  };
}

/** Disk and blob providers, plus a multi provider over both. */
export function multiProviders(): Provider[] {
  const single = [diskProvider(), blobProvider()];
  return [...single, multiProvider(single)];
}

/** Every row of a source, read `page` rows at a time. */
export async function everyRow(src: SourceHandle, page = 500): Promise<string[][]> {
  const rows: string[][] = [];
  for (let first = 0; first < src.progress.rows; first += page) {
    rows.push(...(await src.rows(first, page)).rows);
  }
  return rows;
}

/** openOne opens `ref` and returns its one source. Throws if there are more. */
export async function openOne(engine: Engine, ref: SourceRef): Promise<SourceHandle> {
  const { sources } = await engine.open(ref);
  if (sources.length !== 1) throw new Error(`${ref.name} opened ${sources.length} sources`);
  return sources[0]!;
}

export function indexed(source: SourceHandle): Promise<void> {
  return new Promise((resolve) => {
    if (source.progress.complete) return resolve();
    source.onProgress = (p) => {
      if (p.complete) resolve();
    };
  });
}

/** `count` rows of a Sheet from `first`, raw or display, one cell per column. */
export function sheetRows(
  s: Sheet,
  first: number,
  count: number,
  what: "raw" | "display",
): string[][] {
  const out: string[][] = [];
  for (let row = first; row < Math.min(first + count, s.rows()); row++) {
    out.push(s.columns.map((_, col) => s[what](row, col)));
  }
  return out;
}

/** Rows padded with "" to the fixture's column count. */
export function widened(rows: string[][]): string[][] {
  return rows.map((r) => sales.columns.map((_, col) => r[col] ?? ""));
}

/** `said` in English, or undefined for an undefined `said`. */
export function saidIn(said: Said | undefined): string | undefined {
  return said === undefined ? undefined : english(said);
}
