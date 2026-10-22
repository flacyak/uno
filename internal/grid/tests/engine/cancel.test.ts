/**
 * @fileoverview Cancelling an open: one cancelled while it waits for its sample
 * rows is refused, stops reading and leaves nothing behind; one already
 * answered is left alone; one given an aborted signal never reaches the engine.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { expect, test } from 'vite-plus/test';

import { Refusal, english, saidOf } from '#engine';
import type { Provider } from '#plugin';
import { diskProvider } from '#store/node';
import { ROWS } from '#tests/testdata/sales-q3';
import { FIXTURE, TINY, connect, indexed, slowed } from './harness.ts';

/** Milliseconds added before every read, so an open sits in its wait for the sample rows. */
const READ_MS = 20;

/** Milliseconds to watch for reads after a cancel: several reads' worth. */
const WATCH_MS = 5 * READ_MS;

const REF = { name: 'sales-q3.csv', path: FIXTURE };

/**
 * counted returns `provider` with its reads counted as they are asked for.
 * The index pass's first chunk, which is the first read past the front of
 * the file, is held until `go` is called. `indexing` resolves when it is
 * asked for, and from then until `go` the open waits for its sample rows.
 */
function counted(provider: Provider): {
  provider: Provider;
  reads: () => number;
  indexing: Promise<void>;
  go: () => void;
} {
  const { files } = provider;
  let reads = 0;
  let began = (): void => {};
  const indexing = new Promise<void>((resolve) => {
    began = resolve;
  });
  let go = (): void => {};
  const held = new Promise<void>((resolve) => {
    go = resolve;
  });
  let holding = true;
  return {
    provider: {
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
              reads++;
              if (holding && offset > 0) {
                holding = false;
                began();
                await held;
              }
              return source.read(offset, length);
            },
            close: () => source.close(),
          };
        },
      },
    },
    reads: () => reads,
    indexing,
    go,
  };
}

/** refusedAsCancelled checks that `opening` was refused as a cancelled open of the fixture. */
async function refusedAsCancelled(opening: Promise<unknown>): Promise<void> {
  const refused: unknown = await opening.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(refused).toBeInstanceOf(Refusal);
  expect(saidOf(refused)).toEqual({ t: 'cancelled', name: 'sales-q3.csv' });
  expect(english(saidOf(refused))).toBe('opening sales-q3.csv was cancelled');
}

test('an open cancelled while it waits for its sample rows stops reading and leaves nothing behind', async () => {
  const disk = counted(slowed(diskProvider(), READ_MS));
  const { engine, done } = connect(TINY, [disk.provider]);
  try {
    const abort = new AbortController();
    const opening = engine.open(REF, abort.signal);
    await disk.indexing;
    abort.abort();
    await refusedAsCancelled(opening);

    // The held chunk goes on to a closed file, and the pass asks for no more.
    const were = disk.reads();
    disk.go();
    await sleep(WATCH_MS);
    expect(disk.reads(), 'the index stopped reading').toBe(were);

    // The plain id, so the cancelled open left no source behind.
    const { showing } = await engine.open(REF);
    expect(showing).toBe('sales-q3');
  } finally {
    disk.go();
    done();
  }
});

test('an open cancelled as soon as it is asked for is refused the same way', async () => {
  const disk = counted(slowed(diskProvider(), READ_MS));
  const { engine, done } = connect(TINY, [disk.provider]);
  try {
    const abort = new AbortController();
    const opening = engine.open(REF, abort.signal);
    abort.abort();
    await refusedAsCancelled(opening);
    disk.go();
    const { showing } = await engine.open(REF);
    expect(showing).toBe('sales-q3');
  } finally {
    disk.go();
    done();
  }
});

test('a cancel after the open was answered leaves the source alone', async () => {
  const { engine, done } = connect(TINY, [slowed(diskProvider(), READ_MS)]);
  try {
    const abort = new AbortController();
    const { sources } = await engine.open(REF, abort.signal);
    abort.abort();
    const src = sources[0]!;
    expect((await src.rows(0, 5)).rows.length).toBe(5);
    await indexed(src);
    expect(src.progress.rows).toBe(ROWS);
  } finally {
    done();
  }
});

test('an open given an aborted signal is refused without reaching the engine', async () => {
  const disk = counted(slowed(diskProvider(), READ_MS));
  const { engine, done } = connect(TINY, [disk.provider]);
  try {
    const abort = new AbortController();
    abort.abort();
    await refusedAsCancelled(engine.open(REF, abort.signal));
    expect(disk.reads()).toBe(0);
  } finally {
    done();
  }
});
