/**
 * @fileoverview Shared helpers for the engine tests: a client and `serve`
 * joined by a real MessageChannel, the fixture, and row comparisons against a
 * Sheet.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Engine, Refusal, english, messagePort, serve } from '@engine';
import type {
  MessagePortLike,
  Reply,
  Request,
  Said,
  SourceHandle,
  SourceRef,
  Tuning,
} from '@engine';
import type { Connecting } from '@engine';
import { read } from '@ingest';
import { sources } from '@plugin';
import type { Provider } from '@plugin';
import type { Sheet } from '@sheet';
import { blobProvider, multiProvider } from '@store';
import type { Connections, FileRef } from '@store';
import { diskProvider } from '@store/node';
import { bytes, FIXTURE } from '@core-tests/testdata/sales-q3';

// Re-exported from testdata/sales-q3.ts.
export { bytes, FIXTURE };
export const sales = read('sales-q3.csv', bytes);

/** The rows a viewport shows. */
export const SCREEN = 22;

/** Small enough that the 240 KB fixture spans hundreds of blocks and the cache has to evict. */
export const TINY: Tuning = {
  chunkBytes: 4096,
  blockRows: 7,
  blockBytes: 512,
  cacheBytes: 8192,
};

/**
 * connect serves an engine over a real MessageChannel and returns a client
 * for it. `providers` go to `serve` as a platform would hand them, and `tap`
 * is handed every reply the client is sent, in order, before the client.
 */
export function connect(
  tuning?: Tuning,
  providers: Provider[] = [diskProvider(), blobProvider()],
  connecting?: Connecting | Connections,
  tap?: (reply: Reply) => void,
): { engine: Engine; done: () => void } {
  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
    sources(providers),
    tuning,
    // A bare Connections is wrapped as a Connecting holding only it.
    connecting === undefined || 'connections' in connecting
      ? connecting
      : { connections: connecting },
  );
  const client = messagePort<Reply, Request>(
    port2 as unknown as MessagePortLike,
  );
  const engine = new Engine(
    tap === undefined
      ? client
      : {
          ...client,
          listen: (fn, gone) =>
            client.listen((reply) => {
              tap(reply);
              fn(reply);
            }, gone),
        },
  );
  return {
    engine,
    // Only the client's end is closed. Its close request is delivered to the
    // engine before the channel shuts, so the engine closes its own files.
    done: () => engine.close(),
  };
}

/**
 * readsThrough returns `provider` with `before` awaited ahead of every read,
 * given the file it reads and the range it asks for.
 */
export function readsThrough(
  provider: Provider,
  before: (ref: FileRef, offset: number, length: number) => Promise<void>,
): Provider {
  const { files } = provider;
  return {
    ...provider,
    files: {
      label: files.label,
      handles: (ref) => files.handles(ref),
      async open(ref) {
        const source = await files.open(ref);
        return {
          size: source.size,
          version: source.version,
          async read(offset, length) {
            await before(ref, offset, length);
            return source.read(offset, length);
          },
          close: () => source.close(),
        };
      },
    },
  };
}

/**
 * slowed returns `provider` with `ms` added before every read, so an index
 * over it spans several progress replies.
 */
export function slowed(provider: Provider, ms: number): Provider {
  return readsThrough(provider, () => sleep(ms));
}

/** `disk` and a blob provider, plus a multi provider over both. */
export function multiProviders(disk = diskProvider()): Provider[] {
  const single = [disk, blobProvider()];
  return [...single, multiProvider(single)];
}

/** Every row of a source, read `page` rows at a time. */
export async function everyRow(
  src: SourceHandle,
  page = 500,
): Promise<string[][]> {
  const rows: string[][] = [];
  for (let first = 0; first < src.progress.rows; first += page) {
    rows.push(...(await src.rows(first, page)).rows);
  }
  return rows;
}

/** openOne opens `ref` and returns its one source. Throws if there are more. */
export async function openOne(
  engine: Engine,
  ref: SourceRef,
): Promise<SourceHandle> {
  const { sources } = await engine.open(ref);
  if (sources.length !== 1)
    throw new Error(`${ref.name} opened ${sources.length} sources`);
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
  what: 'raw' | 'display',
): string[][] {
  const out: string[][] = [];
  for (let row = first; row < Math.min(first + count, s.rows()); row++) {
    out.push(s.columns.map((_, col) => s[what](row, col)));
  }
  return out;
}

/**
 * padded returns `rows` with "" out to `width` cells, as a short row shows.
 * A row wider than `width` keeps every cell.
 */
export function padded(rows: string[][], width: number): string[][] {
  return rows.map((row) =>
    Array.from({ length: Math.max(width, row.length) }, (_, i) => row[i] ?? ''),
  );
}

/** Rows padded with "" to the fixture's column count. */
export function widened(rows: string[][]): string[][] {
  return padded(rows, sales.columns.length);
}

/** A fixture's path in tests/testdata. */
export function testdata(name: string): string {
  return fileURLToPath(new URL(`../testdata/${name}`, import.meta.url));
}

/** The Refusal `asked` rejects with. Fails if it is anything else. */
export async function refusal(asked: Promise<unknown>): Promise<Refusal> {
  const err: unknown = await asked.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof Refusal)) {
    throw new Error(`expected a Refusal, and got ${String(err)}`);
  }
  return err;
}

/** `said` in English, or undefined for an undefined `said`. */
export function saidIn(said: Said | undefined): string | undefined {
  return said === undefined ? undefined : english(said);
}
