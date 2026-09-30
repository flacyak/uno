// Encoding of engine messages as web socket frames.
//
// A message made of JSON values is one text frame of JSON. A message holding
// Uint8Array or Blob values is one binary frame: a 4-byte length, a JSON
// envelope, then the bytes in order. One message is one frame, so each
// frame is decoded on its own.
//
// Dates, Maps, undefined, and non-finite numbers are tagged in the JSON so
// they round-trip. Bytes ride beside the JSON, so a browser can send a
// dropped file as a Blob and leave the socket to read it.
//
// This file is encoding only, so both a page and a Node process import it.

import { formatBytes, messageOf } from "./protocol.ts";
import type { MessagePortLike, Reply } from "./protocol.ts";
import { WHOLE_LIMIT } from "./workspace.ts";

/**
 * One frame: a text string, or the pieces of a binary frame in order. The
 * sender joins the pieces: a Blob in a page, one buffer in Node.
 */
export type Frame = string | Array<Uint8Array<ArrayBuffer> | Blob>;

/** Bytes allowed for a frame's JSON on top of the bytes it carries. */
const HEADER_ALLOWANCE = 1 << 20;

/**
 * The largest frame accepted: a whole .uno or carried file, plus the JSON
 * header.
 */
export const FRAME_LIMIT = WHOLE_LIMIT + HEADER_ALLOWANCE;

/** The key that marks a tagged value in the JSON. */
const TAG = "$";

/** Bytes at the start of a binary frame holding the JSON length. */
const LENGTH_BYTES = 4;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A binary frame's JSON: the message, and the length of each byte run after it. */
interface Envelope {
  sizes: number[];
  message: Json;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * encode writes a message as a frame. It throws on a value outside the
 * encoding, such as a class instance or a function.
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

/** Whether the array is over a plain ArrayBuffer, which a Blob can be made of. */
function owned(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

function sizeOf(part: Uint8Array | Blob): number {
  return part instanceof Uint8Array ? part.byteLength : part.size;
}

/** The most bytes UTF-8 uses for one UTF-16 code unit. */
const UTF8_BYTES_PER_UNIT = 3;

/**
 * frameBytes returns a frame's size on the wire from its pieces. Text is
 * sized at its maximum UTF-8 length.
 */
export function frameBytes(frame: Frame): number {
  if (typeof frame === "string") return frame.length * UTF8_BYTES_PER_UNIT;
  return frame.reduce((n, part) => n + sizeOf(part), 0);
}

/**
 * decode reads a frame back into a message. It throws on a malformed frame.
 * The result is `unknown`; the caller checks the message's shape.
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

/** write turns a value into JSON. Bytes are moved into `attached` and replaced by an index. */
function write(value: unknown, attached: Array<Uint8Array<ArrayBuffer> | Blob>): Json {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // JSON holds only finite numbers. NaN and infinity are tagged to survive.
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
    // An array over a SharedArrayBuffer is copied to a plain one.
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
    // Undefined fields are dropped, as JSON.stringify would.
    if (v !== undefined) out[k] = write(v, attached);
  }
  // A plain object with the tag as a key is wrapped so it reads back as a
  // plain object.
  return TAG in out ? { [TAG]: "object", v: out } : out;
}

/** read is the inverse of write. */
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
      // Copied out of the frame, so the frame can be freed while the Blob lives.
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
    // defineProperty, so a key called __proto__ is an own property.
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

/** trouble builds an unnumbered error reply for a frame that failed to decode. */
function trouble(text: string): Reply {
  return { t: "error", said: { t: "text", text } };
}

/** The event type and listener pairs a port accepts. */
type Listening = ["message", (e: { data: unknown }) => void] | ["close", () => void];

/** The part of a browser web socket this uses. The `ws` package's has it too. */
export interface WebSocketLike {
  binaryType: string;
  send(data: string | Blob): void;
  close(): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: () => void): void;
}

/**
 * socketPort wraps an open web socket as a MessagePortLike.
 *
 * `postMessage` throws if the encoded frame is over `limit` bytes. A socket
 * close fires the port's close listeners.
 */
export function socketPort(socket: WebSocketLike, limit = FRAME_LIMIT): MessagePortLike {
  const listeners: Array<(e: { data: unknown }) => void> = [];
  const closes: Array<() => void> = [];
  let closed = false;

  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (e) => {
    const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data;
    if (typeof data !== "string" && !(data instanceof Uint8Array)) return;
    let message: unknown;
    try {
      message = decode(data);
    } catch (err) {
      message = trouble(`the engine sent ${messageOf(err)}`);
    }
    for (const fn of listeners) fn({ data: message });
  });
  socket.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    for (const fn of closes) fn();
  });

  function addEventListener(...[type, fn]: Listening): void {
    if (type === "message") listeners.push(fn);
    else closes.push(fn);
  }

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
    addEventListener,
    // A web socket delivers from the moment it opens, so start returns at once.
    start: () => undefined,
    close() {
      if (closed) return;
      closed = true;
      socket.close();
    },
  };
}
