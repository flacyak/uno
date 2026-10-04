/**
 * @fileoverview WasmScanner from ../../scanner/wasm.ts, loading any build of
 * scan.c, so the checks in exact.test.ts can be run against mutated kernels
 * to show they catch a broken one.
 */

import { readFileSync } from 'node:fs';

import {
  LINE,
  LINE_CR,
  STATES_BY_NUMBER,
  separatorByte,
} from '../../scanner/common.ts';
import type { Consumer, LabScanner, State } from '../../scanner/common.ts';
import type { KernelName } from '../../scanner/wasm.ts';

type Kernel = (end: number, sep: number, from: number) => number;
type Exports = Readonly<Record<string, unknown>>;

interface WebAssemblyApi {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Exports };
  Memory: new (descriptor: { initial: number }) => { buffer: ArrayBuffer };
}

const { WebAssembly: wasmApi } = globalThis as unknown as {
  WebAssembly: WebAssemblyApi;
};

function fn<T>(exports: Exports, name: string): T {
  const value = exports[name];
  if (typeof value !== 'function') throw new Error(`lacks ${name}`);
  return value as T;
}

/** A loaded build: its buffers and kernels. */
export interface Build {
  readonly piece: Uint8Array;
  readonly begins: Int32Array;
  readonly state: () => number;
  readonly kernels: Readonly<Record<KernelName, Kernel>>;
}

/** load instantiates the scan.wasm at `path`. */
export function load(path: string): Build {
  const { exports } = new wasmApi.Instance(
    new wasmApi.Module(readFileSync(path)),
    {},
  );
  const memory = exports['memory'];
  if (!(memory instanceof wasmApi.Memory)) throw new Error('lacks memory');
  const pieceBytes = fn<() => number>(exports, 'pieceBytes')();
  return {
    piece: new Uint8Array(
      memory.buffer,
      fn<() => number>(exports, 'piece')(),
      pieceBytes,
    ),
    begins: new Int32Array(
      memory.buffer,
      fn<() => number>(exports, 'begins')(),
      pieceBytes / 2 + 1,
    ),
    state: fn<() => number>(exports, 'state'),
    kernels: {
      vectors: fn<Kernel>(exports, 'scan'),
      blocks: fn<Kernel>(exports, 'scanBlocks'),
    },
  };
}

/** MutantScanner is WasmScanner's push over a given build, handing on runs. */
export class MutantScanner implements LabScanner {
  state: State = LINE;
  crAt = 0;
  private readonly sep: number;

  constructor(
    comma: string,
    private readonly consumer: Consumer,
    private readonly build: Build,
    private readonly kernel: KernelName,
  ) {
    this.sep = separatorByte(comma);
  }

  push(chunk: Uint8Array, base: number): void {
    const { piece, begins } = this.build;
    const scan = this.build.kernels[this.kernel];
    let s: number = this.state;
    for (let at = 0; at < chunk.length; at += piece.length) {
      const length = Math.min(piece.length, chunk.length - at);
      piece.set(chunk.subarray(at, at + length));
      const count = scan(length, this.sep, s);
      s = this.build.state();
      this.consumer.many(begins, count, base + at);
    }
    this.state = STATES_BY_NUMBER[s]!;
    if (chunk.length > 0 && this.state === LINE_CR) {
      this.crAt = base + chunk.length - 1;
    }
  }
}
