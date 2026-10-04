// A stand-in bucket behind a Door that holds every ranged read until the test
// lets it through, once the engine has gone quiet. This makes the order of
// reads, and so the request and byte counts, the same on every run.
//
// The engine and the S3 provider are the real ones. Only `fetch` is wrapped.

import { Engine } from "../../src/engine/index.ts";
import type { SourceHandle, Tuning } from "../../src/engine/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { s3Provider } from "../../src/store/s3.ts";
import { bytes, connect, openOne } from "../engine/harness.ts";
import { HOME_REGION } from "../store/regions.ts";
import { BUCKET, KEYS, bucket } from "../store/standin.ts";
import type { Bucket } from "../store/standin.ts";

/** Asked is one request the engine sent. */
export interface Asked {
  /** Where the range starts, or undefined for an unranged request. */
  offset: number | undefined;
  /** How many bytes the range asks for. 0 for an unranged request. */
  length: number;
}

/** A ranged read waiting to be let through. */
interface Held {
  asked: Asked;
  go(): void;
}

/** Milliseconds of silence that make one quiet round. */
const QUIET_MS = 5;
/** Quiet rounds in a row before the engine counts as quiet. */
const QUIET_ROUNDS = 3;

const RANGE = /^bytes=(\d+)-(\d+)$/;

function askedOf(init: RequestInit | undefined): Asked {
  const m = RANGE.exec(new Headers(init?.headers).get("range") ?? "");
  if (m === null) return { offset: undefined, length: 0 };
  return { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 };
}

/** Sorts held reads by offset, lowest first. */
function byOffset(a: Held, b: Held): number {
  return (a.asked.offset ?? 0) - (b.asked.offset ?? 0);
}

/**
 * Door wraps `fetch` between the engine and the bucket. Ranged reads wait in
 * `held` until let through. `asked` is every request in the order sent, and
 * `passed` is every request that was let through.
 */
export class Door {
  readonly asked: Asked[] = [];
  readonly passed: Asked[] = [];
  private held: Held[] = [];
  private out = 0;
  private open = false;

  readonly fetch: typeof fetch = async (input, init) => {
    const asked = askedOf(init);
    this.asked.push(asked);
    if (asked.offset !== undefined && !this.open) {
      await new Promise<void>((go) => this.held.push({ asked, go }));
    }
    this.passed.push(asked);
    this.out++;
    try {
      const res = await fetch(input, init);
      // The whole body is read before `out` drops, so every byte has arrived
      // once `out` is 0.
      const body = await res.arrayBuffer();
      return new Response(body.byteLength === 0 ? null : body, {
        status: res.status,
        headers: res.headers,
      });
    } finally {
      this.out--;
    }
  };

  /** quiet resolves after QUIET_ROUNDS silent rounds with all requests done. */
  async quiet(): Promise<void> {
    for (let rounds = 0; rounds < QUIET_ROUNDS;) {
      const before = this.asked.length;
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
      rounds = this.out === 0 && this.asked.length === before ? rounds + 1 : 0;
    }
  }

  /** letAll lets through every read now waiting. */
  letAll(): void {
    for (const h of this.held.splice(0)) h.go();
  }

  /** letLowest lets through the waiting read with the lowest offset. */
  letLowest(): void {
    const next = this.held.toSorted(byOffset)[0];
    if (next === undefined) return;
    this.held = this.held.filter((h) => h !== next);
    next.go();
  }

  /**
   * during waits for `work`, calling `step` each time the engine goes quiet
   * before `work` has settled. Throws on a quiet with the hold empty.
   */
  async during<T>(work: Promise<T>, step: () => void = () => this.letAll()): Promise<T> {
    let settled = false;
    const done = work.finally(() => {
      settled = true;
    });
    // A rejection is reported through `done` below.
    done.catch(() => undefined);
    for (;;) {
      await this.quiet();
      if (settled) return done;
      if (this.held.length === 0)
        throw new Error("the engine is waiting on nothing the bucket holds");
      step();
    }
  }

  /** release lets every held read through and passes every later one. */
  release(): void {
    this.open = true;
    this.letAll();
  }

  /** Requests in `of` from index `from` on, and the bytes their ranges cover. */
  since(from: number, of: readonly Asked[] = this.asked): { requests: number; bytes: number } {
    const sent = of.slice(from);
    return { requests: sent.length, bytes: sent.reduce((sum, a) => sum + a.length, 0) };
  }
}

/** The fixture's rows `repeats` times over, under one header. */
export function repeated(repeats: number): Uint8Array<ArrayBuffer> {
  const header = bytes.indexOf(0x0a) + 1;
  const body = bytes.subarray(header);
  const out = new Uint8Array(header + body.length * repeats);
  out.set(bytes.subarray(0, header));
  for (let i = 0; i < repeats; i++) out.set(body, header + i * body.length);
  return out;
}

const KEY = "2025/big.csv";

/** Remote is one object in a stand-in bucket, an engine, and the Door between. */
export interface Remote {
  door: Door;
  engine: Engine;
  /** open asks the engine for the object. The caller lets its reads through. */
  open(): Promise<SourceHandle>;
  close(): Promise<void>;
}

/** remote serves `object` from the stand-in bucket to an engine tuned by `tuning`. */
export async function remote(object: Uint8Array, tuning: Tuning): Promise<Remote> {
  const b: Bucket = await bucket(undefined, HOME_REGION, new Map([[KEY, object]]));
  const door = new Door();
  const s3 = s3Provider({
    credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
    endpoint: b.endpoint,
    fetch: door.fetch,
  });
  const { engine, done } = connect(tuning, [diskProvider(), s3]);
  return {
    door,
    engine,
    open: () => openOne(engine, { name: "big.csv", path: `s3://${BUCKET}/${KEY}` }),
    async close() {
      door.release();
      await door.quiet();
      done();
      await b.close();
    },
  };
}
