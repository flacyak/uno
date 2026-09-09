// `vp run dev`: a Vite dev server for the renderer, and Electron pointed at it.
//
// The dev server's URL is handed to Electron in the environment and is never
// written into a config or a bundle. A localhost address compiled into a build
// is one that ships, and the installed app then tries to reach a dev server
// that is not running.
//
// The Electron process's pid is tracked so it can be stopped by pid. Killing by
// name would take down whatever else on this machine happens to be called
// electron, and there is usually something.

import { spawn } from "node:child_process";
import { createServer } from "vite";

import { bundleElectron } from "./bundle.js";

const server = await createServer({ configFile: "vite.config.ts" });
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (url === undefined) {
  await server.close();
  throw new Error("the dev server started without an address to give Electron");
}
server.printUrls();

// Main and preload are not served by Vite, so they are built before Electron
// starts and rebuilt whenever they change.
await bundleElectron({ watch: true });

const electron = spawn((await import("electron")).default, ["."], {
  stdio: "inherit",
  env: { ...process.env, UNO_RENDERER_URL: url },
});

console.log(`electron pid ${electron.pid}`);

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(code);
}

// Closing the window ends the session; Ctrl+C ends it from the other direction.
electron.on("close", (code) => void stop(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (electron.pid !== undefined) process.kill(electron.pid, "SIGTERM");
  });
}
