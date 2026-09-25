// Asking the script that started the app to do what only it can.
//
// The smoke run and the preview both start the app from a script that holds
// the stand-in bucket, and a change a person would make in the bucket -- an
// export written over -- is made there. The app asks on stdout and the script
// answers on the app's stdin once it has acted, so what follows can rely on
// the change having happened rather than on a timer.

import { createInterface } from "node:readline";

/** The script's answers, a line each, read off this process's stdin. */
let answers: AsyncIterator<string> | undefined;

/**
 * ask has the script that started the app do `what`, and waits for it to be
 * done. `who` is the script's name as the lines carry it: `smoke`, `preview`.
 */
export async function ask(who: string, what: string): Promise<void> {
  answers ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  console.log(`${who}: ask ${what}`);
  const next = await answers.next();
  if (next.done === true) throw new Error(`${who} stopped answering before ${what}`);
  if (next.value !== `${who}: done ${what}`) throw new Error(next.value.replace(`${who}: `, ""));
}
