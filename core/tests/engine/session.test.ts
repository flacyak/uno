// A session over a socket that drops: what was in flight arrives, once, and
// nothing is handled twice. The sockets are fakes joined back to back, so a
// drop is what a dropped connection is: both ends told, and nothing sent
// across. The engine is real, over the disk and over memory.

import { expect, test } from 'vite-plus/test';
import { CLOSED, Engine, Session, english, messagePort, serve } from '@engine';
import type { Reply, Request, WebSocketLike } from '@engine';
import { sources } from '@plugin';
import { blobProvider } from '@store';
import { diskProvider } from '@store/node';
import { Op } from '@sheet';
import { FIXTURE, bytes } from './harness.ts';

/** The units column of the fixture, where an edit goes. */
const UNITS = 4;

/** The close code of a connection lost rather than closed: what a browser reports. */
const LOST = 1006;

/**
 * A fake socket joined to a peer. Each delivers what the other sends
 * asynchronously and in order: text as a string, bytes as an ArrayBuffer.
 * One that is cut delivers nothing from then on, as a socket whose far end
 * has silently gone does.
 */
class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  peer: FakeSocket | undefined;
  cut = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly messages: Array<(e: { data: unknown }) => void> = [];
  private readonly closes: Array<(e: { code: number }) => void> = [];

  send(data: string | Blob): void {
    if (this.cut) return;
    const peer = this.peer;
    this.queue = this.queue.then(async () => {
      const delivered =
        typeof data === 'string' ? data : await data.arrayBuffer();
      for (const fn of peer?.messages ?? []) fn({ data: delivered });
    });
  }

  close(code = CLOSED): void {
    const peer = this.peer;
    this.queue = this.queue.then(() => {
      for (const fn of peer?.closes ?? []) fn({ code });
    });
  }

  /** lost is the connection gone under both ends, with no close from either. */
  lost(): void {
    for (const end of [this, this.peer]) {
      for (const fn of end?.closes ?? []) fn({ code: LOST });
    }
  }

  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close', fn: (e: { code: number }) => void): void;
  addEventListener(type: 'message' | 'close', fn: (e: never) => void): void {
    if (type === 'message')
      this.messages.push(fn as (e: { data: unknown }) => void);
    else this.closes.push(fn as (e: { code: number }) => void);
  }
}

function socketPair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * An engine and a client, each on a session, joined by `link`. The sessions
 * are left to their owners here: a close is recorded and nothing is ended,
 * which is the test's to decide.
 */
function sessions(): {
  engine: Engine;
  near: Session;
  far: Session;
  closed: number[];
  link: () => [FakeSocket, FakeSocket];
} {
  const near = new Session('the engine');
  const far = new Session('the page');
  const closed: number[] = [];
  near.onClose = (code) => closed.push(code);
  far.onClose = (code) => closed.push(code);
  serve(
    messagePort<Request, Reply>(far.port),
    sources([diskProvider(), blobProvider()]),
  );
  const engine = new Engine(messagePort<Reply, Request>(near.port));
  return {
    engine,
    near,
    far,
    closed,
    link: () => {
      const [a, b] = socketPair();
      near.attach(a);
      far.attach(b);
      return [a, b];
    },
  };
}

test('a request in flight when the socket drops is answered over the next one', async () => {
  const { engine, near, far, closed, link } = sessions();
  const [, b] = link();
  const added = await engine.open({ name: 'sales-q3.csv', path: FIXTURE });
  const source = added.sources[0]!;

  // The engine's reply goes into a socket that has silently gone.
  b.cut = true;
  const asked = source.rows(0, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(far.unacknowledged).toBeGreaterThan(0);
  b.lost();
  expect(closed).toEqual([LOST, LOST]);

  link();
  const { rows } = await asked;
  expect(rows[0]).toEqual([
    '2026-07-01',
    'West',
    'Ada Okafor',
    'direct',
    '1,204',
    '48160.00',
  ]);
  // Each side has said what it heard, and the other keeps nothing.
  await expect
    .poll(() => [near.unacknowledged, far.unacknowledged])
    .toEqual([0, 0]);
  engine.close();
});

test('a request sent again after a drop is handled once', async () => {
  const { engine, link } = sessions();
  const [, b] = link();
  const added = await engine.open({
    name: 'sales-q3.csv',
    blob: new Blob([bytes]),
  });
  const source = added.sources[0]!;
  engine.mode(true);

  // The edit lands, and its reply is lost.
  b.cut = true;
  const first = source.edit({ op: Op.Set, row: 0, col: UNITS, now: '1' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  b.lost();
  link();
  expect((await first).edit.seq).toBe(1);

  // The client sent the edit again with the resume, and the log has it once.
  const second = await source.edit({
    op: Op.Set,
    row: 1,
    col: UNITS,
    now: '2',
  });
  expect(second.edit.seq).toBe(2);
  expect((await source.rows(0, 2)).rows.map((r) => r[UNITS])).toEqual([
    '1',
    '2',
  ]);
  engine.close();
});

test('a lost socket is reported to the owner with its code; a session left to itself ends', async () => {
  const [a, b] = socketPair();
  const near = new Session('the engine');
  near.attach(a);
  const far = new Session('the page');
  far.attach(b);
  const engine = new Engine(messagePort<Reply, Request>(near.port));
  const said: string[] = [];
  engine.onError = (heard) => said.push(english(heard));
  const reported: number[] = [];
  far.onClose = (code) => reported.push(code);

  b.lost();
  expect(reported).toEqual([LOST]);
  await expect
    .poll(() => said)
    .toEqual(['the connection to the engine closed']);
});

test('a socket closed on purpose by one side closes the other with the code that says so', async () => {
  const [a, b] = socketPair();
  const near = new Session('the engine');
  near.attach(a);
  const far = new Session('the page');
  far.attach(b);
  const reported: number[] = [];
  near.onClose = (code) => {
    reported.push(code);
    near.end();
  };
  const engine = new Engine(messagePort<Reply, Request>(near.port));
  const said: string[] = [];
  engine.onError = (heard) => said.push(english(heard));

  far.port.close();
  await expect
    .poll(() => said)
    .toEqual(['the connection to the engine closed']);
  expect(reported).toEqual([CLOSED]);
});

test('a frame that does not decode is answered in a sentence naming the far side', async () => {
  const [a, b] = socketPair();
  const near = new Session('the engine');
  near.attach(a);
  const heard: unknown[] = [];
  near.port.addEventListener('message', (e) => heard.push(e.data));
  b.send('{not json');
  await expect
    .poll(() => heard)
    .toEqual([
      {
        t: 'error',
        said: { t: 'text', text: 'the engine sent a frame that is not JSON' },
      },
    ]);
});
