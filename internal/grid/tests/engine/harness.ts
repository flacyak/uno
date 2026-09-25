// What the engine tests share: a real MessageChannel between a client and
// `serve`, the fixture, and a way to compare rows with what a Sheet builds.

import { Engine, messagePort, serve } from "../../src/engine/index.ts";
import type {
  MessagePortLike,
  Reply,
  Request,
  SourceHandle,
  SourceRef,
  Tuning,
} from "../../src/engine/index.ts";
import type { Connecting } from "../../src/engine/index.ts";
import { read } from "../../src/ingest/index.ts";
import { sources } from "../../src/plugin/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import type { Sheet } from "../../src/sheet/index.ts";
import { blobProvider } from "../../src/store/index.ts";
import type { Connections } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { bytes, FIXTURE } from "../testdata/sales-q3.ts";

// The fixture and its bytes live in testdata/sales-q3.ts, beside the facts
// about what it holds. They are passed on from here because most of the tests
// that want them want the rest of this file too.
export { bytes, FIXTURE };
export const sales = read("sales-q3.csv", bytes);

/** The rows a viewport shows. */
export const SCREEN = 22;

/** Small enough that the 240 KB fixture spans hundreds of blocks and the cache has to evict. */
export const TINY: Tuning = { chunkBytes: 4096, blockRows: 7, blockBytes: 512, cacheBytes: 8192 };

/**
 * connect wires a client to an engine over a real channel.
 *
 * What it is handed is providers and not handlers, because that is what a
 * platform hands `serve`: opening and browsing are one decision, and a test
 * that wired the handler and forgot the lister would be testing an engine no
 * platform builds.
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
    // A bare Connections is the common case in a test, and is wired the way
    // a platform with nothing else to offer would wire it.
    connecting === undefined || "connections" in connecting
      ? connecting
      : { connections: connecting },
  );
  const engine = new Engine(messagePort<Reply, Request>(port2 as unknown as MessagePortLike));
  return {
    engine,
    // Only the client's end is closed. It posts the close request first, and
    // closing one end of a channel closes the other once what was already
    // posted has been delivered. Closing the engine's end here as well would
    // drop that request unread, and the workspace would never close the files
    // it holds.
    done: () => engine.close(),
  };
}

/** openOne adds a file that is one source, and hands back that source. */
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

/** What a Sheet shows and stores for a run of rows, as wide as its header. */
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

/** Rows as wide as the header, the way a Sheet reads a short one: padded with "". */
export function widened(rows: string[][]): string[][] {
  return rows.map((r) => sales.columns.map((_, col) => r[col] ?? ""));
}
