/**
 * @fileoverview The WebAssembly SIMD variant: wasm/scan.c compiled by
 * wasm/build.sh, driven from JS.
 *
 * Each push copies the chunk into the module's memory a piece at a time,
 * scans the piece there and hands the begins it wrote to the consumer, one
 * at a time or as one run. The
 * module keeps no state between calls that matters: each scanner holds its
 * own and passes it in, so one instance serves them all. Scanning is
 * synchronous, so two scanners never share the buffers at once.
 *
 * The copy is part of the cost. CopyIntoWasm does only the copy, so the
 * benchmark can say what reading straight into wasm memory would save.
 */

import { readFileSync } from 'node:fs';

import { LINE, LINE_CR, STATES_BY_NUMBER, separatorByte } from './common.ts';
import type { Consumer, LabScanner, State } from './common.ts';

/**
 * A kernel scans the first `end` bytes of the piece from state `from` and
 * returns the begins it wrote.
 */
type Kernel = (end: number, sep: number, from: number) => number;

/** The kernels scan.c exports: 16 bytes at a time, or 64-byte masks. */
export type KernelName = 'vectors' | 'blocks';

/** What scan.c exports, with its buffers viewed from JS. */
interface Module {
  readonly piece: Uint8Array;
  readonly begins: Int32Array;
  /** The state after the last scan. */
  state(): number;
  readonly kernels: Readonly<Record<KernelName, Kernel>>;
}

/** A module instance's exports, by name. */
type Exports = Readonly<Record<string, unknown>>;

/**
 * The part of the WebAssembly JS API this file uses. Core compiles against
 * es2023 and Node's types, neither of which declares WebAssembly, and
 * pulling in the DOM library would declare it for every file in core.
 */
interface WebAssemblyApi {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Exports };
  Memory: new (descriptor: { initial: number }) => { buffer: ArrayBuffer };
}

const { WebAssembly: wasmApi } = globalThis as unknown as {
  WebAssembly: WebAssemblyApi;
};

/** A function the module exports, typed by what scan.c declares. */
function exported<T>(exports: Exports, name: string): T {
  const value = exports[name];
  if (typeof value !== 'function') throw new Error(`scan.wasm lacks ${name}`);
  return value as T;
}

/** instantiate loads scan.wasm and views its buffers. */
function instantiate(): Module {
  const module = new wasmApi.Module(
    readFileSync(new URL('./wasm/scan.wasm', import.meta.url)),
  );
  const { exports } = new wasmApi.Instance(module, {});
  const memory = exports['memory'];
  if (!(memory instanceof wasmApi.Memory)) {
    throw new Error('scan.wasm lacks its memory');
  }
  type Address = () => number;
  const pieceBytes = exported<Address>(exports, 'pieceBytes')();
  // At most one begin per two bytes, plus one.
  const maxBegins = pieceBytes / 2 + 1;
  return {
    piece: new Uint8Array(
      memory.buffer,
      exported<Address>(exports, 'piece')(),
      pieceBytes,
    ),
    begins: new Int32Array(
      memory.buffer,
      exported<Address>(exports, 'begins')(),
      maxBegins,
    ),
    state: exported<Address>(exports, 'state'),
    kernels: {
      vectors: exported<Kernel>(exports, 'scan'),
      blocks: exported<Kernel>(exports, 'scanBlocks'),
    },
  };
}

/** The one instance every scanner uses. */
const MODULE = instantiate();

/**
 * How a WasmScanner reports the begins of a piece: one call to Begin each,
 * or one call to Many with the module's array.
 */
export type Handoff = 'each' | 'many';

/** WasmScanner runs the scan in WebAssembly with one of its kernels. */
export class WasmScanner implements LabScanner {
  private readonly consumer: Consumer;
  private readonly handoff: Handoff;

  state: State = LINE;
  crAt = 0;
  private readonly sep: number;
  private readonly scan: Kernel;

  constructor(
    comma: string,
    consumer: Consumer,
    kernel: KernelName,
    handoff: Handoff,
  ) {
    this.consumer = consumer;
    this.handoff = handoff;
    this.sep = separatorByte(comma);
    this.scan = MODULE.kernels[kernel];
  }

  push(chunk: Uint8Array, base: number): void {
    const { piece, begins } = MODULE;
    const { scan, sep, consumer } = this;
    const each = this.handoff === 'each';
    const pieceBytes = piece.length;
    let s: number = this.state;
    for (let at = 0; at < chunk.length; at += pieceBytes) {
      const length = Math.min(pieceBytes, chunk.length - at);
      piece.set(chunk.subarray(at, at + length));
      const count = scan(length, sep, s);
      s = MODULE.state();
      const start = base + at;
      if (each) {
        for (let k = 0; k < count; k++) consumer.begin(start + begins[k]!);
      } else {
        consumer.many(begins, count, start);
      }
    }
    this.state = STATES_BY_NUMBER[s]!;
    // LINE_CR outlives a push only when the CR was its last byte.
    if (chunk.length > 0 && this.state === LINE_CR) {
      this.crAt = base + chunk.length - 1;
    }
  }
}

/** CopyIntoWasm copies chunks into wasm memory as WasmScanner does, and
 * nothing more. */
export class CopyIntoWasm {
  push(chunk: Uint8Array): void {
    const { piece } = MODULE;
    for (let at = 0; at < chunk.length; at += piece.length) {
      piece.set(chunk.subarray(at, Math.min(at + piece.length, chunk.length)));
    }
  }
}
