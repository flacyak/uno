// Bundling the Node side of the app.
//
// The renderer goes through Vite, which is what `vp build` does. Main, preload
// and the engine cannot: they run with Electron's own module loader, so they
// are built here, as CommonJS, which is the format a preload script has to be.

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
          // Electron and Node's own modules are provided by the runtime;
          // bundling them in would be shipping a second copy of the platform.
          external: [/^node:/, "electron"],
        },
      },
    });
  }
}
