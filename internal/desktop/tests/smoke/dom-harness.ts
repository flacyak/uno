// Boots the real shell over a real, in-process engine, on a plain happy-dom
// document -- no Electron, no display.
//
// This is the thing electron-page.ts never had to build: something to be a
// page for. index.ts (Electron's flavour) gets a window for free from
// `BrowserWindow`, wires the engine through `process.parentPort`, and loads
// `main.ts`, which pulls in the menu and everything that goes with it. None of
// that exists here, so this file does the three things that matter and nothing
// else: the DOM skeleton the real app ships (from index.html, not retyped),
// the real engine over a real channel, and the layout numbers happy-dom will
// never compute for itself.
//
// The channel is Node's own `MessageChannel`, from node:worker_threads, not
// happy-dom's. happy-dom's `MessagePort` is a stub -- postMessage, start and
// close all say `// TODO: Implement` in its own source -- so it cannot carry a
// message end to end. Node's is a real, working implementation of the same
// `MessagePortLike` shape `messagePort()` in @uno/grid/engine already wants,
// and it is what @uno/grid/engine's own protocol comment names as the third
// place these messages run, beside Electron's MessagePortMain and a browser's
// MessagePort. There is no mock engine here: `serve` is the same function
// src/engine/index.ts hands its provider list to, and a disk provider reads
// the same bytes off the same fixture path a real open would.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";

import { messagePort, serve } from "@uno/grid/engine";
import type { MessagePortLike, Reply, Request } from "@uno/grid/engine";
import { sources } from "@uno/grid/plugin";
import { diskProvider } from "@uno/grid/store/node";

import type { Host } from "../../src/shared/host.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The same fixture scripts/smoke.js drives the real Electron path with. */
export const FIXTURE = join(HERE, "..", "..", "..", "grid", "tests", "testdata", "sales-q3.csv");

/** How long the first rows get to arrive from the engine, mirroring index.ts's
 * own DRAW_TRIES/DRAW_MS. */
const DRAW_TRIES = 120;
const DRAW_MS = 50;

/**
 * Body markup, read from the real index.html and not retyped: a second copy
 * drifts from what Shell actually queries (`#app`, `#tabs`, `#banner`,
 * `#empty`, `#content`, and the status bar's ids) without anyone noticing.
 */
function bodyMarkup(): string {
  const html = readFileSync(join(HERE, "..", "..", "index.html"), "utf8");
  const open = html.indexOf("<body>") + "<body>".length;
  const close = html.indexOf("</body>");
  // The module script that boots main.ts is the one piece of the body this
  // harness must not run -- see the file header on why.
  return html.slice(open, close).replace(/<script[\s\S]*?<\/script>\s*/, "");
}

/**
 * Stands in for the row a real CSS engine would compute. happy-dom parses and
 * mutates a tree but never lays one out, so `clientHeight` and `offsetHeight`
 * are 0 on every element, always. Left alone the virtualiser reads a
 * zero-height viewport and draws `ceil(0 / 29) + 6` rows -- six -- which is
 * short of several rows these checks read (row 6, for one).
 *
 * Faked on the prototype, keyed by what the element is, rather than on the
 * specific nodes: View builds its scroller and its `<thead>` itself, inside a
 * dynamic import this harness does not otherwise touch, so there is no hook to
 * patch particular instances before the first layout reads them. The numbers
 * are the ones the task suggested: a 600px scroller, a 30px header.
 *
 * `--row-h` needs no such fake. `readRowHeight` in view.ts already falls back
 * to 29 when it cannot parse the custom property, and happy-dom's
 * `getComputedStyle` does not resolve one out of the stylesheet Vite injects,
 * so the fallback is exactly what runs.
 *
 * No production file changes for any of this: it is all done from outside, on
 * the DOM this harness itself builds.
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
 * bootShell wires a real Shell to a real engine over a real (Node) channel,
 * opens the fixture, and waits for its first rows to land -- the same
 * condition runSmoke's own prelude waits on in index.ts, since nothing here
 * runs that prelude for it.
 */
export async function bootShell(): Promise<void> {
  document.body.innerHTML = bodyMarkup();
  fakeLayout();

  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port2 as unknown as MessagePortLike),
    sources([diskProvider()]).files,
  );

  const host: Host = {
    open: () => Promise.resolve(undefined),
    add: () => Promise.resolve([]),
    dropped: () => {
      throw new Error("dropped() is window-bound and not used by any run check");
    },
    connect: () => Promise.resolve(port1 as unknown as MessagePort),
    pickSave: () => Promise.resolve(undefined),
    save: () => Promise.resolve(),
  };

  const { Shell } = await import("../../src/renderer/shell/shell.ts");
  const shell = new Shell(host);
  await shell.openPath(FIXTURE);

  for (let i = 0; i < DRAW_TRIES; i++) {
    if (document.querySelector("tbody tr:not(.pending)") !== null) return;
    await new Promise((resolve) => setTimeout(resolve, DRAW_MS));
  }
  throw new Error("no rows were ever drawn");
}
