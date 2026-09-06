import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // One entry per ported Go package, so the Electron main process and the
    // renderer can each pull only what they need. `exports: true` writes the
    // subpath map into package.json from these.
    // store/node is its own entry because it is the one module that imports
    // node:fs: a worker on a desktop reaches for it, and a browser never should.
    entry: ["src/index.ts", "src/*/index.ts", "src/store/node.ts"],
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
