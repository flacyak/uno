import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Two bundles, one file each: the engine and the gate. The @uno packages
    // and ws are bundled in, so each runs with Node alone.
    entry: { engine: "src/engine/main.ts", gate: "src/gate/main.ts" },
    platform: "node",
    format: "esm",
    deps: { alwaysBundle: [/^@uno\//, "ws"] },
    dts: false,
  },
  test: {
    setupFiles: ["../grid/tests/handles.ts"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
