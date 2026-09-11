// The engine: one file, served to one client.
//
// `serve` is what a worker does, minus the worker. A platform's entry file
// builds a Port from whatever its runtime hands it, says how to open a
// SourceRef, and calls this. Electron's utility process and a browser's Web
// Worker are each a few lines around the same call.

import { openFormat } from "../ingest/index.ts";
import type { Format } from "../ingest/index.ts";
import { SAMPLE_ROWS, inferKind } from "../sheet/index.ts";
import type { ByteSource } from "../store/index.ts";
import { indexPass } from "./pass.ts";
import type { Opened, Port, Progress, Reply, Request, SourceRef } from "./protocol.ts";
import { messageOf } from "./protocol.ts";
import { Pages, RowIndex, TUNING } from "./rows.ts";
import type { Tuning } from "./rows.ts";

export type OpenSource = (ref: SourceRef) => Promise<ByteSource>;

/** How often progress is posted while a pass runs. The status bar needs no more. */
const PROGRESS_MS = 100;

export function serve(
  port: Port<Request, Reply>,
  openSource: OpenSource,
  tuning: Tuning = TUNING,
): void {
  let view: Promise<View> | undefined;

  async function handle(msg: Request): Promise<void> {
    switch (msg.t) {
      case "open": {
        if (view !== undefined) throw new Error("this engine already has a file open");
        view = View.start(msg.ref, openSource, port, tuning);
        try {
          port.post({ t: "opened", opened: (await view).opened });
        } catch (err) {
          view = undefined; // a failed open leaves the engine free to try another
          throw err;
        }
        return;
      }
      case "rows": {
        if (view === undefined) throw new Error("no file is open");
        const rows = await (await view).pages.rows(msg.first, msg.count);
        port.post({ t: "rows", id: msg.id, first: msg.first, rows });
        return;
      }
      case "bytes": {
        port.post({ t: "bytes", id: msg.id, bytes: await whole(msg.ref, msg.limit) });
        return;
      }
      case "close": {
        await (await view)?.close();
        return;
      }
    }
  }

  async function whole(ref: SourceRef, limit: number): Promise<Uint8Array> {
    const source = await openSource(ref);
    try {
      if (source.size > limit) {
        throw new Error(
          `${ref.name} is ${formatBytes(source.size)}, over the ${formatBytes(limit)} that can be read whole`,
        );
      }
      return await source.read(0, source.size);
    } finally {
      await source.close();
    }
  }

  port.listen((msg) => {
    handle(msg).catch((err: unknown) => {
      port.post({ t: "error", id: "id" in msg ? msg.id : undefined, message: messageOf(err) });
    });
  });
}

/** The file being viewed: its format, its index, and the pages read through them. */
class View {
  private constructor(
    readonly opened: Opened,
    readonly pages: Pages,
    private readonly source: ByteSource,
    private readonly abort: AbortController,
  ) {}

  static async start(
    ref: SourceRef,
    openSource: OpenSource,
    port: Port<Request, Reply>,
    tuning: Tuning,
  ): Promise<View> {
    const source = await openSource(ref);
    let format: Format;
    try {
      format = await openFormat(ref.name, source);
    } catch (err) {
      await source.close();
      throw err;
    }

    const index = new RowIndex(format.dataStart, source.size, tuning);
    const pages = new Pages(ref.name, source, format, index, tuning.cacheBytes);
    const abort = new AbortController();

    // Kinds come from the first rows, the sample a Sheet reads, so the header
    // waits until the index has closed enough blocks to hold them.
    let sampled = (): void => {};
    const enough = new Promise<void>((resolve) => (sampled = resolve));
    let told = 0;
    let started = false;

    const indexing = indexPass({
      source,
      format,
      index,
      tuning,
      signal: abort.signal,
      progress() {
        if (index.complete || index.readable() >= SAMPLE_ROWS) sampled();
        const now = Date.now();
        if (!index.complete && now - told < PROGRESS_MS) return;
        told = now;
        port.post({ t: "progress", progress: progressOf(index) });
      },
    });
    indexing.catch((err: unknown) => {
      // Before the open answers, the open fails with it instead.
      if (started) port.post({ t: "error", message: `${ref.name}: ${messageOf(err)}` });
    });

    try {
      await Promise.race([enough, indexing]);
      started = true;
      const sample = await pages.rows(0, SAMPLE_ROWS);
      const columns = format.columns.map((header, col) => ({
        header,
        ...inferKind(sample.length, (row) => sample[row]![col] ?? ""),
      }));

      const opened = {
        size: source.size,
        label: format.label,
        columns,
        progress: progressOf(index),
      };
      return new View(opened, pages, source, abort);
    } catch (err) {
      abort.abort();
      await source.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.source.close();
  }
}

function progressOf(index: RowIndex): Progress {
  return {
    done: index.scanned,
    total: index.size,
    readable: index.readable(),
    rows: index.rows(),
    complete: index.complete,
  };
}

export function formatBytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
