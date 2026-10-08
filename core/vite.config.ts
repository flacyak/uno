import { defineConfig } from 'vite-plus';

export default defineConfig({
  // The alias map in ../tsconfig.paths.json, for vitest.
  resolve: { tsconfigPaths: true },
  pack: {
    // One entry per package folder, plus five store modules imported on
    // their own. `exports: true` writes the subpath map into package.json
    // from these.
    // store/node is the only module that imports node:fs. store/s3 holds the
    // request signing code. store/sts holds the role assumption code.
    // store/metadata asks the host a process runs on for its role's keys.
    // store/otlp sends an engine's measurements to a collector.
    entry: [
      'src/index.ts',
      'src/*/index.ts',
      'src/store/metadata.ts',
      'src/store/node.ts',
      'src/store/otlp.ts',
      'src/store/s3.ts',
      'src/store/sts.ts',
    ],
    deps: { resolveDepSubpath: true },
    dts: {
      generator: 'tsgo',
    },
    exports: true,
  },
  test: {
    // Fails a test file that leaves a file handle open.
    setupFiles: ['tests/handles.ts'],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'default-case': 'error',
    },
  },
  fmt: { singleQuote: true, printWidth: 80 },
});
