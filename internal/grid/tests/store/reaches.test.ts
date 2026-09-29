// The guard of opens.test.ts, with the core running.
//
// Reading the source catches a way out wherever it is written, but not one
// whose name is put together at run time, or one a module is handed rather
// than loads. So this runs the core -- the way the desktop engine does, through
// every way out it has -- in a process of its own where each of them is
// watched, and holds what it saw to the places in ways.ts.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

import { offences, PLACES } from "./ways.ts";
import type { Way } from "./ways.ts";

const run = promisify(execFile);
const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const REACH = fileURLToPath(new URL("./reach/", import.meta.url));

/** How long one watched run gets. It starts a stand-in S3 and STS and runs a program. */
const RUN_MS = 60_000;

/** What `scenario` reached for, run under `root`, as run.ts prints it. */
async function watched(root: string, scenario: string): Promise<Array<{ file: string; way: Way }>> {
  const { stdout } = await run(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", `${REACH}run.ts`, root, scenario],
    { timeout: RUN_MS },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as Array<{ file: string; way: Way }>;
}

test(
  "run as the desktop runs it, the core reaches outside only where it is allowed",
  async () => {
    const uses = await watched(SRC, `${REACH}everything.ts`);
    expect(offences(uses)).toEqual([]);
    // And the run took every way the core has, each in a place it is allowed,
    // which is what makes nothing else doing so worth saying.
    const taken = new Set(uses.map((u) => u.way));
    for (const way of Object.keys(PLACES) as Way[]) {
      if (PLACES[way].length > 0) expect(taken, way).toContain(way);
    }
  },
  RUN_MS,
);

// The plant puts every name together at run time, so there is nothing in its
// text for opens.test.ts to find, and this has to find it doing each.
test(
  "a planted module that builds the names it loads is caught at run time",
  async () => {
    const root = `${REACH}planted`;
    const uses = await watched(root, `${root}/engine/serve.ts`);
    expect(offences(uses)).toEqual([
      "engine/serve.ts: a program",
      "engine/serve.ts: a socket",
      "engine/serve.ts: the disk",
    ]);
    const text = readFileSync(`${root}/engine/serve.ts`, "utf8");
    expect(text, "no module named whole in the plant").not.toMatch(
      /["'](node:)?(child_process|fs|net)["']/,
    );
  },
  RUN_MS,
);
