/**
 * @fileoverview Boots the real shell over a real in-process engine on a
 * happy-dom document, in plain Node, headless.
 *
 * This file provides three things: the DOM skeleton from index.html, the real
 * engine over a Node MessageChannel, and the layout numbers happy-dom leaves
 * at zero.
 *
 * The channel is Node's MessageChannel from node:worker_threads. happy-dom's
 * MessagePort is an empty stub. `serve` is the same
 * function src/engine/index.ts uses, and the disk provider reads the real
 * fixture.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

import { afterAll } from "vite-plus/test";

import { messagePort, serve } from "@engine";
import type { MessagePortLike, Reply, Request } from "@engine";
import { sources } from "@plugin";
import type { Provider } from "@plugin";
import { connectionsIn, saveConnection } from "@store";
import { diskProvider, nodeStore } from "@store/node";

import { DEFAULT_HEIGHT } from "@renderer/chart/place";
import type { Shell } from "@renderer/shell/shell";
import type { Host } from "@shared/host";
import { bodyMarkup } from "@desktop-tests/markup";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The fixtures: the one scripts/smoke.js drives the real Electron path
 * with, and a second export for a check that opens another file over it. */
const TESTDATA = join(HERE, "..", "..", "..", "..", "core", "tests", "testdata");
export const FIXTURE = join(TESTDATA, "sales-q3.csv");
export const SECOND = join(TESTDATA, "google-ads-sales.csv");

/** How long the first rows get to arrive from the engine, and how often the
 * DOM is polled, matching index.ts's FIRST_ROWS_MS and POLL_MS. */
export const FIRST_ROWS_MS = 20_000;

/** The engine's end of each channel the shell connected over, in order, for a check that closes one. */
export const engineEnds: MessagePort[] = [];
/** Ends each engine the shell connected to, with every file it holds open. */
const engineCloses: Array<() => Promise<void>> = [];

// Every file that boots a shell ends its engines before happy-dom goes, so an
// answer or an offer still on its way cannot reach a page with no document.
afterAll(async () => {
  await Promise.all(engineCloses.splice(0).map((close) => close()));
  for (const end of engineEnds.splice(0)) end.close();
});
const POLL_MS = 50;

/** A chart window's head, its caption and its two 1px borders, in px, which chart.css draws. */
const HEAD = 29;
const CAPTION = 22;
const BORDERS = 2;

/** What a new window leaves its plot. */
const PLOT_HEIGHT = DEFAULT_HEIGHT - HEAD - CAPTION - BORDERS;

/**
 * Fakes the layout happy-dom leaves at zero. `clientHeight` and
 * `offsetHeight` are 0 on every element in happy-dom, so the virtualiser
 * would draw only `ceil(0 / 29) + 6` rows. The getters are faked on the
 * prototype because View builds its scroller and `<thead>` itself, so the
 * prototype is what is in reach before the first layout. The scroller is 600px
 * and the header 30px, and a chart's plot PLOT_HEIGHT, so its bars draw.
 *
 * `--row-h` is left alone: `readRowHeight` in view.ts falls back to 29 when
 * happy-dom's `getComputedStyle` answers "" for the custom property.
 */
function fakeLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains("chart-plot")) return PLOT_HEIGHT;
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
 * `providers` replaces what the engine reads through, for a test that holds
 * a read back.
 */
export async function bootShell(
  over: Partial<Host> = {},
  providers: readonly Provider[] = [diskProvider()],
): Promise<Shell> {
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
    const close = serve(
      messagePort<Request, Reply>(port2 as unknown as MessagePortLike),
      sources(providers),
      undefined,
      {
        connections: connectionsIn(nodeStore(), kept),
        signIns: () =>
          Promise.resolve({ modes: ["machine", "profile", "public"], profiles: ["default"] }),
      },
    );
    engineCloses.push(close);
    engineEnds.push(port2);
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

  const { Shell } = await import("@renderer/shell/shell");
  const shell = new Shell({ ...host, ...over });
  await shell.openPath(FIXTURE);

  const start = performance.now();
  while (performance.now() - start < FIRST_ROWS_MS) {
    if (document.querySelector("tbody tr:not(.pending)") !== null) return shell;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`no rows were drawn within ${FIRST_ROWS_MS / 1000}s`);
}
