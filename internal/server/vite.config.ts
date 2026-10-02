import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Two programs, each one file: the engine an instance runs, and the gate
    // in front of the instances. The core and the socket library are bundled
    // in, so an instance needs Node and this file and nothing else.
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
