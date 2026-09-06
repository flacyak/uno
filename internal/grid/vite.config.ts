import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // One entry per ported Go package, so the Electron main process and the
    // renderer can each pull only what they need. `exports: true` writes the
    // subpath map into package.json from these.
    entry: ["src/index.ts", "src/*/index.ts"],
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
