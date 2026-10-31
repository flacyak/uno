/**
 * @fileoverview The engine's messages as WebSocket frames: every kind of value
 * comes back as what it was, bytes ride beside the JSON uncopied, and a bad
 * frame is refused in a sentence. The last tests run a real engine over the
 * frames.
 */

import { expect, test } from 'vite-plus/test';

import {
  CLOSED,
  Engine,
  decode,
  encode,
  english,
  frameBytes,
  messagePort,
  serve,
  socketPort,
} from '@engine';
import type {
  Carried,
  Frame,
  MessagePortLike,
  Reply,
  Request,
  SourceHandle,
  SourceRef,
  Tally,
  WebSocketLike,
} from '@engine';
import { sources } from '@plugin';
import { blobProvider } from '@store';
import { diskProvider } from '@store/node';
import { GroupsFold, SampleFold } from '@tally';
import { FIXTURE, bytes, sales } from './harness.ts';

/** join turns a frame into the one value a socket would deliver. */
async function join(frame: Frame): Promise<string | Uint8Array> {
  if (typeof frame === 'string') return frame;
  return new Uint8Array(await new Blob(frame).arrayBuffer());
}

/** numbered is a message as the first frame of a session carries it. */
function numbered(message: unknown): Carried {
  return { seq: 1, ack: 0, message };
}

async function across(message: unknown): Promise<unknown> {
  return decode(await join(encode(numbered(message)))).message;
}

test('plain data is one text frame, and reads back equal', async () => {
  const message = {
    t: 'rows',
    id: 7,
    first: 0,
    rows: [['a', '1']],
    raws: [null],
  };
  const frame = encode(numbered(message));
  expect(typeof frame).toBe('string');
  expect(await across(message)).toEqual(message);
});

test("a chart's tally from either fold is plain data, and crosses as one text frame", async () => {
  const groups = new GroupsFold('sum');
  const sample = new SampleFold();
  // A region, a revenue and a units cell, with a blank and a word left out.
  const rows: Array<[string, string, string]> = [
    ['North', '1.5', '2'],
    ['South', '', '4'],
    ['North', '3', 'n/a'],
  ];
  // Every row is in the first block.
  const block = 0;
  rows.forEach(([region, revenue, units], row) => {
    groups.add(region, revenue);
    sample.add(block, row, revenue, units);
  });
  const coverage = { rows: rows.length, total: rows.length, complete: true };
  const by = { col: 0, header: 'region' };
  const sum = { col: 1, header: 'revenue' };
  const y = { col: 2, header: 'units' };
  const tallies: Tally[] = [
    {
      t: 'groups',
      plot: { t: 'bars', by, sum },
      coverage,
      ...groups.snapshot(),
    },
    {
      t: 'sample',
      plot: { t: 'scatter', x: sum, y },
      coverage,
      ...sample.snapshot(),
    },
  ];
  for (const tally of tallies) {
    expect(JSON.parse(JSON.stringify(tally))).toEqual(tally);
    expect(typeof encode(numbered(tally))).toBe('string');
    expect(await across(tally)).toEqual(tally);
  }
});

test('a Date, a Map and the numbers JSON has no word for come back as themselves', async () => {
  const message = {
    modified: new Date('2026-03-04T05:06:07.008Z'),
    never: new Date(Number.NaN),
    extra: new Map<string, unknown>([['tags', ['a', new Date(0)]]]),
    ratio: Number.NaN,
    most: Number.POSITIVE_INFINITY,
    least: Number.NEGATIVE_INFINITY,
    holes: [undefined, null],
  };
  const back = (await across(message)) as typeof message;
  expect(back.modified).toEqual(message.modified);
  expect(Number.isNaN(back.never.getTime())).toBe(true);
  expect(back.extra).toEqual(message.extra);
  expect(back.ratio).toBeNaN();
  expect(back.most).toBe(Number.POSITIVE_INFINITY);
  expect(back.least).toBe(Number.NEGATIVE_INFINITY);
  expect(back.holes).toEqual([undefined, null]);
});

test('an undefined field is an absent one', async () => {
  expect(await across({ a: 1, b: undefined })).toEqual({ a: 1 });
});

test('bytes ride beside the JSON, as the pieces they were handed over as', async () => {
  const saved = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const frame = encode(numbered({ t: 'saved', id: 3, bytes: saved }));
  expect(Array.isArray(frame)).toBe(true);
  // The same array, by identity.
  expect(frame).toContain(saved);
  expect(await across({ t: 'saved', id: 3, bytes: saved })).toEqual({
    t: 'saved',
    id: 3,
    bytes: saved,
  });
});

test('a Blob crosses with its bytes and its type, and several keep their order', async () => {
  const first = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
  const second = new Blob(['c\n3\n']);
  const frame = encode(
    numbered({
      parts: [
        { name: 'one.csv', blob: first },
        { name: 'two.csv', blob: second },
      ],
    }),
  );
  expect(frame).toContain(first);

  const back = decode(await join(frame)).message as {
    parts: Array<{ name: string; blob: Blob }>;
  };
  expect(back.parts.map((p) => p.name)).toEqual(['one.csv', 'two.csv']);
  expect(back.parts[0]!.blob.type).toBe('text/csv');
  expect(await back.parts[0]!.blob.text()).toBe('a,b\n1,2\n');
  expect(await back.parts[1]!.blob.text()).toBe('c\n3\n');
});

test("an object of somebody's own that uses the tag as a key is still theirs", async () => {
  const extra = new Map<string, unknown>([['note', { $: 'date', v: 0 }]]);
  expect(await across({ extra, plain: { $: 'bytes', i: 0 } })).toEqual({
    extra,
    plain: { $: 'bytes', i: 0 },
  });
});

test('a key called __proto__ is a key, and reaches no prototype', () => {
  const back = decode(
    '{"seq":1,"ack":0,"message":{"__proto__":{"polluted":true}}}',
  ).message as Record<string, unknown>;
  expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(Object.keys(back)).toEqual(['__proto__']);
});

test('what cannot be written down is refused at the sender, by name', () => {
  class Sheet {}
  expect(() => encode(numbered({ sheet: new Sheet() }))).toThrow(
    'a Sheet cannot cross to an engine',
  );
  expect(() => encode(numbered({ fn: () => 1 }))).toThrow(
    'a function cannot cross to an engine',
  );
});

test('a frame this did not write is refused in a sentence', async () => {
  expect(() => decode('{not json')).toThrow('a frame that is not JSON');
  expect(() => decode('{"seq":1,"ack":0,"message":{"$":"sheet"}}')).toThrow(
    'written down as "sheet"',
  );
  expect(() =>
    decode('{"seq":1,"ack":0,"message":{"$":"bytes","i":0}}'),
  ).toThrow('naming bytes its frame does not hold');
  expect(() => decode(new Uint8Array([0, 0]))).toThrow(
    'too short to hold a message',
  );
  expect(() => decode(new Uint8Array([0, 0, 0, 9, 123]))).toThrow(
    'shorter than its own header',
  );

  const whole = (await join(
    encode(numbered({ bytes: new Uint8Array(8) })),
  )) as Uint8Array;
  expect(() => decode(whole.subarray(0, whole.length - 1))).toThrow(
    'do not add up',
  );
});

test('a frame is numbered, says what was heard, or carries the acknowledgement alone', async () => {
  expect(decode('{"ack":4}')).toEqual({ ack: 4 });
  expect(encode({ ack: 4 })).toBe('{"ack":4}');
  const frame = encode({ seq: 9, ack: 4, message: { t: 'close' } });
  expect(frame).toBe('{"seq":9,"ack":4,"message":{"t":"close"}}');
  const binary = decode(
    await join(
      encode({ seq: 2, ack: 1, message: { bytes: new Uint8Array(3) } }),
    ),
  );
  expect(binary.seq).toBe(2);
  expect(binary.ack).toBe(1);

  expect(() => decode('{"t":"close"}')).toThrow('without an acknowledgement');
  expect(() => decode('{"ack":-1}')).toThrow('without an acknowledgement');
  expect(() => decode('{"seq":1,"ack":0}')).toThrow(
    'numbered without a message',
  );
  expect(() => decode('{"seq":1.5,"ack":0,"message":1}')).toThrow(
    'numbered without a message',
  );
});

test('frameBytes weighs a binary frame exactly', () => {
  const frame = encode(numbered({ blob: new Blob([new Uint8Array(1000)]) }));
  const pieces = frame as Array<Uint8Array | Blob>;
  expect(frameBytes(frame)).toBe(
    pieces.reduce(
      (n, p) => n + (p instanceof Uint8Array ? p.byteLength : p.size),
      0,
    ),
  );
});

/**
 * A pair of fake sockets joined back to back. Each delivers what the other
 * sends asynchronously and in order: text as a string, bytes as an
 * ArrayBuffer.
 */
function socketPair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  peer: FakeSocket | undefined;
  sent: Array<string | Blob> = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly messages: Array<(e: { data: unknown }) => void> = [];
  private readonly closes: Array<(e: { code: number }) => void> = [];

  send(data: string | Blob): void {
    this.sent.push(data);
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

  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close', fn: (e: { code: number }) => void): void;
  addEventListener(type: 'message' | 'close', fn: (e: never) => void): void {
    if (type === 'message')
      this.messages.push(fn as (e: { data: unknown }) => void);
    else this.closes.push(fn as (e: { code: number }) => void);
  }
}

const LIMIT = 1 << 20;

/** An engine served over the fake sockets, with disk and blob providers. */
function overSockets(limit = LIMIT): {
  engine: Engine;
  client: FakeSocket;
  far: MessagePortLike;
} {
  const [client, server] = socketPair();
  const far = socketPort(server, limit);
  serve(
    messagePort<Request, Reply>(far),
    sources([diskProvider(), blobProvider()]),
  );
  const engine = new Engine(
    messagePort<Reply, Request>(socketPort(client, limit)),
  );
  return { engine, client, far };
}

/** Opens `ref` and returns its first source. */
async function opened(engine: Engine, ref: SourceRef): Promise<SourceHandle> {
  const added = await engine.open(ref);
  return added.sources[0]!;
}

test('an engine behind a socket opens a file by path and serves its rows', async () => {
  const { engine } = overSockets();
  const source = await opened(engine, { name: 'sales-q3.csv', path: FIXTURE });
  expect(source.opened.columns.map((c) => c.header)).toEqual(
    sales.columns.map((c) => c.header),
  );

  const { rows } = await source.rows(0, 3);
  expect(rows).toHaveLength(3);
  engine.close();
});

test('a dropped file crosses as its bytes, and its workspace saves as bytes back', async () => {
  const { engine, client } = overSockets();
  const source = await opened(engine, {
    name: 'sales-q3.csv',
    blob: new Blob([bytes]),
  });
  expect(source.opened.size).toBe(bytes.byteLength);
  // The open went as a binary frame holding the Blob.
  expect(client.sent.some((frame) => frame instanceof Blob)).toBe(true);

  const saved = await engine.save(
    { source: source.id, cells: [], at: '' },
    LIMIT,
  );
  expect(saved).toBeInstanceOf(Uint8Array);
  // A .uno is a zip.
  expect([...saved.subarray(0, 2)]).toEqual([0x50, 0x4b]);
  engine.close();
});

test('a message over the limit is refused where it is sent, and the engine stays up', async () => {
  const small = 4096;
  const { engine } = overSockets(small);
  await expect(
    engine.open({ name: 'sales-q3.csv', blob: new Blob([bytes]) }),
  ).rejects.toThrow('this engine takes in one message');
  const source = await opened(engine, { name: 'sales-q3.csv', path: FIXTURE });
  expect(source.opened.columns.length).toBeGreaterThan(0);
  engine.close();
});

test('a socket that closes under the client says so once', async () => {
  const { engine, far } = overSockets();
  const said: string[] = [];
  engine.onError = (heard) => said.push(english(heard));
  far.close();
  await expect
    .poll(() => said)
    .toEqual(['the connection to the engine closed']);
});

test('a socket that closes with a request out refuses it, and every request after it', async () => {
  const { engine, far } = overSockets();
  const said: string[] = [];
  engine.onError = (heard) => said.push(english(heard));
  const opening = engine.open({
    name: 'sales-q3.csv',
    blob: new Blob([bytes]),
  });
  far.close();
  await expect(opening).rejects.toThrow('the connection to the engine closed');
  await expect(
    engine.open({ name: 'sales-q3.csv', blob: new Blob([bytes]) }),
  ).rejects.toThrow('the connection to the engine closed');
  expect(said).toEqual(['the connection to the engine closed']);
});
