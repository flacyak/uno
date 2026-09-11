// @vitest-environment happy-dom
//
// The 17 `run` checks from open.ts and default.ts, driven by a DOM shim
// instead of Electron: no window, no display, no Xvfb.
//
// This exists to answer a question the Electron-only suite could not: is
// `Page` actually enough for a second backend, or does it secretly lean on
// something only a real browser window can give it? See dom-harness.ts and
// dom-page.ts for how the shim is built.
//
// The checks are order-dependent -- default.ts says so about its own, and
// open.ts leaves the window in the state default.ts's first check assumes --
// so they run here exactly the way runSmoke in index.ts runs them: in list
// order, against one shell, one page, never in parallel. `beforeAll` boots the
// shell once; every test below shares that one instance.
//
// Only checks carrying `run` are read at all: one with `script` needs real
// layout or the real preload bridge, and one with `input` needs a person's own
// event reaching (or not reaching) a driven window. Neither exists here, and
// converting either is out of scope for this file. See check.ts.

import { beforeAll, expect, test } from "vite-plus/test";

import type { Check } from "../../src/main/smoke/check.ts";
import { DEFAULT_INPUT } from "../../src/main/smoke/default.ts";
import { OPEN } from "../../src/main/smoke/open.ts";
import type { Page } from "../../src/main/smoke/page.ts";
import { bootShell } from "./dom-harness.ts";
import { domPage } from "./dom-page.ts";

type RunCheck = Check & { run: NonNullable<Check["run"]> };

const CHECKS: RunCheck[] = [...OPEN, ...DEFAULT_INPUT].filter(
  (c): c is RunCheck => c.run !== undefined,
);

/**
 * The one check of the 17 this harness cannot honestly answer either way.
 *
 * `bridgeExposed()` asks whether `window.uno.open` is a function --
 * `window.uno` being what Electron's preload assigns through contextBridge.
 * This harness follows the task's own instruction: build a `Host` and hand it
 * to `new Shell(host)` directly, the way index.ts never does, rather than
 * booting main.ts and preload the way a real window does. So `window.uno` is
 * never assigned here, by construction, and `bridgeExposed()` can only ever
 * read false -- not because anything is broken, but because there is no
 * bridge in this picture to expose. Faking `window.uno` just to make this one
 * check pass would be the mock-engine mistake in miniature: a bridge that
 * answers with no contextBridge behind it proves nothing.
 */
const UNBRIDGED = "the preload bridge is there";

beforeAll(async () => {
  await bootShell();
}, 20_000);

const page: Page = domPage();

for (const check of CHECKS) {
  test(
    check.name,
    async () => {
      const message = await check.run(page);
      if (check.name === UNBRIDGED) {
        // Documented above: this is the one check the shim cannot support.
        expect(message).toBe("window.uno is missing");
      } else {
        expect(message).toBe("");
      }
    },
    10_000,
  );
}
