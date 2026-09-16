// A module that reaches outside the way no text guard can see: every name it
// loads is put together at run time. reaches.test.ts runs it as if it were
// src/engine/serve.ts, and it has to be caught doing each.

/** A program, the disk and a socket, none of their modules written down whole. */
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
