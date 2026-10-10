// Boots the real shell over a real in-process engine on a happy-dom document,
// in plain Node, headless.
//
// This file provides three things: the DOM skeleton from index.html, the real
// engine over a Node MessageChannel, and the layout numbers happy-dom leaves
// at zero.
//
// The channel is Node's MessageChannel from node:worker_threads. happy-dom's
// MessagePort is an empty stub. `serve` is the same
// function src/engine/index.ts uses, and the disk provider reads the real
// fixture.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";

import { messagePort, serve } from "@uno/grid/engine";
import type { MessagePortLike, Reply, Request } from "@uno/grid/engine";
import { sources } from "@uno/grid/plugin";
import { connectionsIn, saveConnection } from "@uno/grid/store";
import { diskProvider, nodeStore } from "@uno/grid/store/node";

import type { Shell } from "../../src/renderer/shell/shell.ts";
import type { Host } from "../../src/shared/host.ts";
import { bodyMarkup } from "../markup.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The fixture scripts/smoke.js drives the real Electron path with. */
export const FIXTURE = join(HERE, "..", "..", "..", "grid", "tests", "testdata", "sales-q3.csv");

/** How long the first rows get to arrive from the engine, and how often the
 * DOM is polled, matching index.ts's FIRST_ROWS_MS and POLL_MS. */
const FIRST_ROWS_MS = 20_000;
const POLL_MS = 50;

/**
 * Fakes the layout happy-dom leaves at zero. `clientHeight` and
 * `offsetHeight` are 0 on every element in happy-dom, so the virtualiser
 * would draw only `ceil(0 / 29) + 6` rows. The getters are faked on the
 * prototype because View builds its scroller and `<thead>` itself, so the
 * prototype is what is in reach before the first layout. The scroller is 600px
 * and the header 30px.
 *
 * `--row-h` is left alone: `readRowHeight` in view.ts falls back to 29 when
 * happy-dom's `getComputedStyle` answers "" for the custom property.
 */
function fakeLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains("grid-scroll") ? 600 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.tagName === "THEAD" ? 30 : 0;
    },
  });
}

/**
 * Wires a real Shell to a real engine over a Node channel, opens the
 * fixture, and waits for its first rows to land, as runSmoke's prelude in
 * index.ts does. Returns the shell.
 *
 * `over` replaces what the host answers, for a test that saves or quits.
 */
export async function bootShell(over: Partial<Host> = {}): Promise<Shell> {
  document.body.innerHTML = bodyMarkup();
  fakeLayout();

  // A connections folder of its own, as main hands the desktop's engine one,
  // so the shell's connection reads are answered.
  const kept = mkdtempSync(join(tmpdir(), "uno-dom-connections-"));
  // A new engine on a new channel per connect, as main makes a
  // MessageChannelMain per "engine:connect". The shell closes a workspace's
  // engine when the next file opens, so a shared port would close the new
  // engine with the old.
  const connect = (): MessagePortLike => {
    const { port1, port2 } = new MessageChannel();
    serve(
      messagePort<Request, Reply>(port2 as unknown as MessagePortLike),
      sources([diskProvider()]),
      undefined,
      {
        connections: connectionsIn(nodeStore(), kept),
        signIns: () =>
          Promise.resolve({ modes: ["machine", "profile", "public"], profiles: ["default"] }),
      },
    );
    return port1 as unknown as MessagePortLike;
  };

  const host: Host = {
    open: () => Promise.resolve(undefined),
    add: () => Promise.resolve([]),
    dropped: () => {
      throw new Error("dropped() is window-bound and not used by any run check");
    },
    connect: () => Promise.resolve(connect()),
    pickSave: () => Promise.resolve(undefined),
    save: () => Promise.resolve(),
    saveConnection: (c) => saveConnection(nodeStore(), kept, c),
    quit: () => {
      throw new Error("quit() is window-bound and not used by any run check");
    },
  };

  const { Shell } = await import("../../src/renderer/shell/shell.ts");
  const shell = new Shell({ ...host, ...over });
  await shell.openPath(FIXTURE);

  const start = performance.now();
  while (performance.now() - start < FIRST_ROWS_MS) {
    if (document.querySelector("tbody tr:not(.pending)") !== null) return shell;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`no rows were drawn within ${FIRST_ROWS_MS / 1000}s`);
}
