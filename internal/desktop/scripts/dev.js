// `vp run dev`: a Vite dev server for the renderer, and Electron pointed at it.
//
// The dev server's URL is passed to Electron in UNO_RENDERER_URL, and lives
// only in that environment.

import { spawn } from "node:child_process";
import { createServer } from "vite";

import { bundleElectron } from "./bundle.js";
import { electronEnv } from "./launch.js";
import { compileMessages } from "./messages.js";

// Compiled first: the server and the bundles all import the messages. The
// server's plugin recompiles them when one changes.
await compileMessages();

const server = await createServer({ configFile: "vite.config.ts" });
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (url === undefined) {
  await server.close();
  throw new Error("the dev server started without an address to give Electron");
}
server.printUrls();

// Main, preload and the engine are bundled by bundleElectron: built before
// Electron starts and rebuilt when they change.
await bundleElectron({ watch: true });

const electron = spawn((await import("electron")).default, ["."], {
  stdio: "inherit",
  env: electronEnv(process.env, { UNO_RENDERER_URL: url }),
});

console.log(`electron pid ${electron.pid}`);

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(code);
}

// Closing the window stops the server. Ctrl+C stops Electron, which closes
// the window.
electron.on("close", (code) => void stop(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (electron.pid !== undefined) process.kill(electron.pid, "SIGTERM");
  });
}
