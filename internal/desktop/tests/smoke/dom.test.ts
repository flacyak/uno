// @vitest-environment happy-dom
//
// The `run` checks from open.ts and default.ts, driven by the DOM shim in
// plain Node, headless. See dom-harness.ts and dom-page.ts.
//
// The checks are order-dependent, so they run in list order against one
// shell and one page, as runSmoke in index.ts runs them. `beforeAll` boots
// the shell once.
//
// Only checks with `run` are read. One with `script` needs real layout or the
// real preload bridge, and one with `input` needs a real event reaching a
// driven window. See check.ts.

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
 * The one check this harness fails. `bridgeExposed()` asks whether
 * `window.uno.open` is a function, which Electron's preload assigns through
 * contextBridge. This harness hands a `Host` to `new Shell(host)` directly
 * and skips preload, so `window.uno` stays unassigned.
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
        // See UNBRIDGED.
        expect(message).toBe("window.uno is missing");
      } else {
        expect(message).toBe("");
      }
    },
    10_000,
  );
}
