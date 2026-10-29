import { defineConfig } from "vite-plus";

import { messagesPlugins } from "./scripts/messages.js";

export default defineConfig({
  // The alias map in ../../tsconfig.paths.json, for the renderer and vitest.
  resolve: { tsconfigPaths: true },
  // Relative asset paths. The packaged app loads the renderer over file://,
  // where an absolute /assets/ would resolve to the filesystem root.
  base: "./",
  // Compiles messages/ before the build, and on change under the dev server.
  plugins: messagesPlugins(),
  build: {
    outDir: "out/renderer",
    emptyOutDir: true,
    target: "chrome130",
  },
  test: {
    // Node 25 and later put a localStorage of their own on globalThis, with
    // nothing in it unless a file is named, and it stands in front of the
    // one happy-dom gives the renderer. The shell reads its settings from that.
    execArgv: ["--no-experimental-webstorage"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
