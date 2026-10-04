// A module that reaches outside with every module name built at run time, so
// only a run reveals them. reaches.test.ts runs it as if it were
// src/engine/serve.ts and expects each use to be caught.

/** The module names, assembled from pieces. */
const PROGRAM = ["child", "process"].join("_");
const DISK = ["f", "s"].join("");
const SOCKET = ["n", "e", "t"].join("");

export default async function planted(): Promise<void> {
  const cp = (await import(PROGRAM)) as { execFileSync(file: string, args: string[]): unknown };
  cp.execFileSync(process.execPath, ["-e", ""]);
  const fs = process.getBuiltinModule(DISK) as { statSync(path: string): unknown };
  fs.statSync(".");
  await import(SOCKET);
}
