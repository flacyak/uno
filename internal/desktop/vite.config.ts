import { defineConfig } from "vite-plus";

export default defineConfig({
  // The renderer is an ordinary web app: index.html at the package root, built
  // to out/renderer. Relative paths, because a packaged app loads it off disk
  // with file:// and an absolute /assets/ would resolve to the filesystem root.
  base: "./",
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
