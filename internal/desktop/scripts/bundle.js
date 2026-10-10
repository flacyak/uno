// Bundles the Node side of the app: main, preload and the engine.
//
// The renderer is built by Vite through `vp build`. These three run under
// Electron's own module loader and are built here as CommonJS.

import { build } from "vite";

/** @param {{ watch?: boolean }} [opts] */
export async function bundleElectron(opts = {}) {
  for (const [name, entry] of [
    ["main", "src/main/index.ts"],
    ["preload", "src/preload/index.ts"],
    // The utility process that owns an open file. Main starts one per workspace.
    ["engine", "src/engine/index.ts"],
  ]) {
    await build({
      configFile: false,
      logLevel: "warn",
      build: {
        outDir: `out/${name}`,
        emptyOutDir: true,
        target: "node22",
        minify: false,
        sourcemap: true,
        watch: opts.watch === true ? {} : null,
        lib: {
          entry,
          formats: ["cjs"],
          fileName: () => "index.cjs",
        },
        rollupOptions: {
          // Electron and Node's built-in modules come from the runtime.
          external: [/^node:/, "electron"],
        },
      },
    });
  }
}
