import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // One entry per package folder, plus three store modules imported on
    // their own. `exports: true` writes the subpath map into package.json
    // from these.
    // store/node is the only module that imports node:fs. store/s3 holds the
    // request signing code. store/sts holds the role assumption code.
    entry: [
      "src/index.ts",
      "src/*/index.ts",
      "src/store/node.ts",
      "src/store/s3.ts",
      "src/store/sts.ts",
    ],
    deps: { resolveDepSubpath: true },
    dts: {
      generator: "tsgo",
    },
    exports: true,
  },
  test: {
    // Fails a test file that leaves a file handle open.
    setupFiles: ["tests/handles.ts"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
