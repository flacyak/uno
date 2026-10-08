// A bucket whose answers the test hands out one at a time.
//
// What reading from a bucket costs is requests and bytes, and both depend on
// the order things happen in: the index pass asks for a chunk, the grid asks
// for a block, read-ahead asks for what it guesses comes next. Left to run
// against a server on this machine that order is a race, and the count changes
// from run to run. So every ranged read here is held at the door until the
// test lets it through, and the test only does that once the engine has gone
// quiet. The same scenario then asks for the same ranges in the same order
// every time, and its counts are exact.
//
// The engine is the real one, opening through the real S3 provider against
// the stand-in bucket. Only `fetch` is wrapped.

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
  /** Where the range starts, or undefined for a request with no range. */
  offset: number | undefined;
  /** How many bytes the range asks for. 0 for a request with no range. */
  length: number;
}

/** A ranged read waiting to be let through. */
interface Held {
  asked: Asked;
  go(): void;
}

/** How long the engine has to send nothing for before it counts as quiet. */
const QUIET_MS = 5;
/** How many quiet stretches in a row it takes. One could fall between two of
 * the engine's own steps. */
const QUIET_ROUNDS = 3;

const RANGE = /^bytes=(\d+)-(\d+)$/;

function askedOf(init: RequestInit | undefined): Asked {
  const m = RANGE.exec(new Headers(init?.headers).get("range") ?? "");
  if (m === null) return { offset: undefined, length: 0 };
  return { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 };
}

/** The order ranged reads are let through in when one is let through at a time. */
function byOffset(a: Held, b: Held): number {
  return (a.asked.offset ?? 0) - (b.asked.offset ?? 0);
}

/**
 * Door stands between the engine and the bucket.
 *
 * `asked` is every request the engine sent, in the order it sent them, whether
 * or not it has been let through. `passed` is the ones that were.
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
      // The body is read here, so that once nothing is out, nothing is still
      // arriving either.
      const body = await res.arrayBuffer();
      return new Response(body.byteLength === 0 ? null : body, {
        status: res.status,
        headers: res.headers,
      });
    } finally {
      this.out--;
    }
  };

  /** quiet waits until the engine has stopped asking and nothing is on its way. */
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

  /** letLowest lets through the waiting read nearest the front of the object. */
  letLowest(): void {
    const next = this.held.toSorted(byOffset)[0];
    if (next === undefined) return;
    this.held = this.held.filter((h) => h !== next);
    next.go();
  }

  /**
   * during runs `work` to its end, letting reads through with `step` each time
   * the engine goes quiet without having finished it.
   */
  async during<T>(work: Promise<T>, step: () => void = () => this.letAll()): Promise<T> {
    let settled = false;
    const done = work.finally(() => {
      settled = true;
    });
    // Reported by `done` below, which is what the caller awaits.
    done.catch(() => undefined);
    for (;;) {
      await this.quiet();
      if (settled) return done;
      if (this.held.length === 0)
        throw new Error("the engine is waiting on nothing the bucket holds");
      step();
    }
  }

  /** release stops holding anything, so what is left can finish and be closed. */
  release(): void {
    this.open = true;
    this.letAll();
  }

  /** How many requests were sent from the `from`th on, and the bytes their ranges asked for. */
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

/** Remote is one object in a bucket, an engine that can open it, and the door between. */
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
