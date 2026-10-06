// The engine's messages as the frames of a web socket.
//
// A MessagePort carries a message by structured clone, so a Date, a Map, a
// Uint8Array and a Blob arrive as what they were. A web socket carries text and
// bytes, so the same messages are written down here: a message that is plain
// data is one text frame of JSON, and one holding bytes is one binary frame,
// the JSON first and the bytes after it, untouched.
//
// One message is one frame either way, so nothing here keeps state between
// frames and the order a socket promises is the order the messages have.
//
// The bytes ride beside the JSON rather than inside it as base64, which is
// what lets a browser send a dropped file without reading it: the frame is a
// Blob made of the header and the file, and the browser streams it.
//
// This file reads nothing and opens nothing: a socket is made by the platform
// and handed in, the way a handler is, so the core still reaches no network.
// Both ends import it, a page and a Node process, so it uses what both have
// and no more.

import { formatBytes, messageOf } from "./protocol.ts";
import type { MessagePortLike } from "./protocol.ts";
import { WHOLE_LIMIT } from "./workspace.ts";

/**
 * One frame: text, or the pieces of a binary one in order. The sender joins
 * the pieces the way its runtime does it best, a Blob of them in a page and
 * one buffer in Node.
 */
export type Frame = string | Array<Uint8Array<ArrayBuffer> | Blob>;

/** What a frame's JSON is allowed beside the bytes it carries. */
const HEADER_ALLOWANCE = 1 << 20;

/**
 * The most one frame may weigh. It is a workspace read whole, which is the
 * largest thing anybody sends an engine: a .uno, or a file that has no path
 * and so has to be carried in one. Anything larger has an address, and is
 * opened by it.
 */
export const FRAME_LIMIT = WHOLE_LIMIT + HEADER_ALLOWANCE;

/** The key a written-down value wears, saying what it was. */
const TAG = "$";

/** How many bytes of a binary frame say how long its JSON is. */
const LENGTH_BYTES = 4;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** What a binary frame's JSON holds: the message, and how long each run of bytes after it is. */
interface Envelope {
  sizes: number[];
  message: Json;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * encode writes a message down as a frame.
 *
 * It refuses, by name, a value it has no way to write: a class instance or a
 * function in a message is a mistake at the sender, and it is said there
 * rather than arriving as an empty object at the other end.
 */
export function encode(message: unknown): Frame {
  const attached: Array<Uint8Array<ArrayBuffer> | Blob> = [];
  const json = write(message, attached);
  if (attached.length === 0) return JSON.stringify(json);

  const envelope: Envelope = { sizes: attached.map(sizeOf), message: json };
  const head = encoder.encode(JSON.stringify(envelope));
  const length = new Uint8Array(LENGTH_BYTES);
  new DataView(length.buffer).setUint32(0, head.byteLength);
  return [length, head, ...attached];
}

/** Whether bytes sit in memory of their own, which is what a Blob can be made of. */
function owned(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

function sizeOf(part: Uint8Array | Blob): number {
  return part instanceof Uint8Array ? part.byteLength : part.size;
}

/** The most bytes UTF-8 spends on one UTF-16 code unit. */
const UTF8_BYTES_PER_UNIT = 3;

/**
 * frameBytes is how much a frame weighs on the wire, without joining it. Text
 * is weighed at the most its characters could come to, which is right for
 * asking whether it fits and costs nothing to work out.
 */
export function frameBytes(frame: Frame): number {
  if (typeof frame === "string") return frame.length * UTF8_BYTES_PER_UNIT;
  return frame.reduce((n, part) => n + sizeOf(part), 0);
}

/**
 * decode reads a frame back into the message it was.
 *
 * A frame that is not one this file wrote is refused in a sentence. What comes
 * back is `unknown`: this knows how values are written down and nothing about
 * which messages there are, so the caller says what it expected.
 */
export function decode(frame: string | Uint8Array): unknown {
  if (typeof frame === "string") return read(parse(frame), []);

  if (frame.byteLength < LENGTH_BYTES)
    throw new Error("a binary frame too short to hold a message");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headEnd = LENGTH_BYTES + view.getUint32(0);
  if (headEnd > frame.byteLength)
    throw new Error("a binary frame shorter than its own header says");

  const envelope = parse(decoder.decode(frame.subarray(LENGTH_BYTES, headEnd)));
  if (!isRecord(envelope) || !Array.isArray(envelope["sizes"]) || !("message" in envelope)) {
    throw new Error("a binary frame without sizes and a message");
  }

  const attached: Uint8Array[] = [];
  let at = headEnd;
  for (const size of envelope["sizes"]) {
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("a binary frame with a size that is not a count of bytes");
    }
    attached.push(frame.subarray(at, at + size));
    at += size;
  }
  if (at !== frame.byteLength) {
    throw new Error("a binary frame whose bytes do not add up to the sizes it gives");
  }
  return read(envelope["message"], attached);
}

function parse(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error("a frame that is not JSON");
  }
}

/** write turns a value into JSON, moving its bytes into `attached` and leaving their place. */
function write(value: unknown, attached: Array<Uint8Array<ArrayBuffer> | Blob>): Json {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // JSON has no NaN and no infinity, and would write each as null.
      return Number.isFinite(value) ? value : { [TAG]: "number", v: String(value) };
    case "undefined":
      return { [TAG]: "undefined" };
    case "object":
      break;
    default:
      throw new Error(`a ${typeof value} cannot cross to an engine`);
  }
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => write(v, attached));
  if (value instanceof Date) {
    const time = value.getTime();
    return { [TAG]: "date", v: Number.isNaN(time) ? null : time };
  }
  if (value instanceof Map) {
    return {
      [TAG]: "map",
      v: [...value].map(([k, v]): Json => [write(k, attached), write(v, attached)]),
    };
  }
  if (value instanceof Uint8Array) {
    // As it is, where it has memory of its own, which is every array an
    // engine or a page makes. One over shared memory is copied out of it.
    attached.push(owned(value) ? value : new Uint8Array(value));
    return { [TAG]: "bytes", i: attached.length - 1 };
  }
  if (value instanceof Blob) {
    attached.push(value);
    return { [TAG]: "blob", i: attached.length - 1, type: value.type };
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`a ${value.constructor.name} cannot cross to an engine`);
  }
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) {
    // An absent key and an undefined one read the same, and JSON keeps neither.
    if (v !== undefined) out[k] = write(v, attached);
  }
  // An object of somebody's own that happens to have the tag as a key is
  // wrapped, so it is never read back as one of the kinds above.
  return TAG in out ? { [TAG]: "object", v: out } : out;
}

/** read is write, backwards. */
function read(json: Json, attached: readonly Uint8Array[]): unknown {
  if (json === null || typeof json !== "object") return json;
  if (Array.isArray(json)) return json.map((v) => read(v, attached));
  if (!(TAG in json)) return fields(json, attached);

  switch (json[TAG]) {
    case "number":
      return Number(json["v"]);
    case "undefined":
      return undefined;
    case "date":
      return new Date(typeof json["v"] === "number" ? json["v"] : Number.NaN);
    case "map": {
      const pairs = json["v"];
      if (!Array.isArray(pairs)) throw new Error("a map written down as something else");
      return new Map(
        pairs.map((pair): [unknown, unknown] => {
          if (!Array.isArray(pair) || pair.length !== 2) {
            throw new Error("a map entry that is not a key and a value");
          }
          return [read(pair[0]!, attached), read(pair[1]!, attached)];
        }),
      );
    }
    case "bytes":
      return bytesAt(json["i"], attached);
    case "blob": {
      const type = json["type"];
      // Copied out of the frame, so the frame can be let go once the message
      // has been read and the Blob is all that holds the file.
      return new Blob([new Uint8Array(bytesAt(json["i"], attached))], {
        type: typeof type === "string" ? type : "",
      });
    }
    case "object": {
      const inner = json["v"];
      if (!isRecord(inner)) throw new Error("a wrapped object that is not an object");
      return fields(inner, attached);
    }
    default:
      throw new Error(`a value written down as ${JSON.stringify(json[TAG])}, which nothing reads`);
  }
}

function fields(json: { [key: string]: Json }, attached: readonly Uint8Array[]): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    // Defined rather than assigned, so a key called __proto__ is a key.
    Object.defineProperty(out, k, {
      value: read(v, attached),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function bytesAt(index: Json | undefined, attached: readonly Uint8Array[]): Uint8Array {
  const bytes = typeof index === "number" ? attached[index] : undefined;
  if (bytes === undefined) throw new Error("a message naming bytes its frame does not hold");
  return bytes;
}

function isRecord(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The part of a browser's web socket this uses. The `ws` package's has it too. */
export interface WebSocketLike {
  binaryType: string;
  send(data: string | Blob): void;
  close(): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: () => void): void;
}

/**
 * socketPort is an open web socket as the port a client talks to its engine
 * through, the shape a MessagePort has.
 *
 * `limit` is the most one message may weigh, which is the engine's to say: a
 * message over it is refused here, in a sentence, where sending it would have
 * the engine drop the connection and every tab with it.
 *
 * A socket that closes under the client says so once, as the error an engine
 * sends when something fails behind a source, since that is where a client
 * already listens for trouble nobody asked about.
 */
export function socketPort(socket: WebSocketLike, limit = FRAME_LIMIT): MessagePortLike {
  const listeners: Array<(e: { data: unknown }) => void> = [];
  let closed = false;

  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (e) => {
    const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data;
    if (typeof data !== "string" && !(data instanceof Uint8Array)) return;
    let message: unknown;
    try {
      message = decode(data);
    } catch (err) {
      message = { t: "error", message: `the engine sent ${messageOf(err)}` };
    }
    for (const fn of listeners) fn({ data: message });
  });
  socket.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    const gone = { t: "error", message: "the connection to the engine closed" };
    for (const fn of listeners) fn({ data: gone });
  });

  return {
    postMessage(message) {
      if (closed) return;
      const frame = encode(message);
      const weight = frameBytes(frame);
      if (weight > limit) {
        throw new Error(
          `${formatBytes(weight)} is over the ${formatBytes(limit)} this engine takes in one message`,
        );
      }
      socket.send(typeof frame === "string" ? frame : new Blob(frame));
    },
    addEventListener: (_type, fn) => void listeners.push(fn),
    // A web socket has no queue to start: it delivers as soon as it is open.
    start: () => undefined,
    close() {
      if (closed) return;
      closed = true;
      socket.close();
    },
  };
}
