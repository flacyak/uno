/**
 * @fileoverview A fetch that counts what the engine sends to a bucket: every
 * request, the bytes its range asks for, and the most out at once.
 *
 * It holds nothing back, unlike the Door in tests/efficiency/remote.ts, so
 * the requests go out when the engine sends them and the timing stays the
 * engine's own. Counts are taken between marks.
 */

import { setTimeout as sleep } from 'node:timers/promises';

/** Sent is one request as it went out. */
export interface Sent {
  method: string;
  /** Where the range starts, or undefined for a request without one. */
  offset: number | undefined;
  /** How many bytes the range asks for. 0 without a range. */
  length: number;
}

/** Cost is what a stretch of work sent to the bucket. */
export interface Cost {
  requests: number;
  /** Bytes the ranges asked for. */
  bytes: number;
}

/** Milliseconds of silence that make one quiet round. */
const QUIET_MS = 5;
/** Quiet rounds in a row before the bucket counts as quiet. */
const QUIET_ROUNDS = 3;

const RANGE = /^bytes=(\d+)-(\d+)$/;

/** sentOf reads the method and range of a request about to go out. */
function sentOf(init: RequestInit | undefined): Sent {
  const method = init?.method ?? 'GET';
  const m = RANGE.exec(new Headers(init?.headers).get('range') ?? '');
  if (m === null) return { method, offset: undefined, length: 0 };
  return {
    method,
    offset: Number(m[1]),
    length: Number(m[2]) - Number(m[1]) + 1,
  };
}

/** Milliseconds in a second. */
const SECOND_MS = 1000;

/**
 * paced hands on `res` with its body let through at `bytesPerSecond`,
 * counted from when its headers came: a link that carries one answer that
 * fast. A late start, while the event loop was busy, is caught up on, as
 * a socket's buffer would hold the bytes meanwhile.
 */
function paced(res: Response, bytesPerSecond: number): Response {
  const body = res.body;
  if (body === null) return res;
  const reader = body.getReader();
  const started = performance.now();
  let through = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        through += next.value.length;
        const due = started + (through / bytesPerSecond) * SECOND_MS;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
        controller.enqueue(next.value);
      },
      cancel: (why) => reader.cancel(why),
    }),
    { status: res.status, statusText: res.statusText, headers: res.headers },
  );
}

/**
 * Tally counts every request that goes through its `fetch`. Given a rate,
 * it also lets each answer's body through no faster than that.
 */
export class Tally {
  readonly sent: Sent[] = [];
  /** The most requests waiting on an answer at once since the last reset. */
  peak = 0;
  private out = 0;
  /** Bytes a second one answer's body arrives at, or undefined for as fast as it comes. */
  private readonly bytesPerSecond: number | undefined;

  constructor(bytesPerSecond?: number) {
    this.bytesPerSecond = bytesPerSecond;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.sent.push(sentOf(init));
    this.peak = Math.max(this.peak, ++this.out);
    try {
      const res = await fetch(input, init);
      return this.bytesPerSecond === undefined
        ? res
        : paced(res, this.bytesPerSecond);
    } finally {
      this.out--;
    }
  };

  /** mark is where the next request will be in `sent`. */
  mark(): number {
    return this.sent.length;
  }

  /** since is what was sent from mark `from` up to mark `to`, or to now. */
  since(from: number, to: number = this.sent.length): Cost {
    const sent = this.sent.slice(from, to);
    return {
      requests: sent.length,
      bytes: sent.reduce((sum, s) => sum + s.length, 0),
    };
  }

  /** resetPeak starts counting the most out at once afresh. */
  resetPeak(): void {
    this.peak = this.out;
  }

  /**
   * quiet resolves once every request has been answered and none has been
   * sent for QUIET_ROUNDS rounds in a row.
   */
  async quiet(): Promise<void> {
    for (let rounds = 0; rounds < QUIET_ROUNDS;) {
      const before = this.sent.length;
      await sleep(QUIET_MS);
      rounds = this.out === 0 && this.sent.length === before ? rounds + 1 : 0;
    }
  }
}
