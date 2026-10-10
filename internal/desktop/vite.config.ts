import { defineConfig } from "vite-plus";

import { messagesPlugins } from "./scripts/messages.js";

export default defineConfig({
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
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
