// Asks the script that started the app to do something, over stdio.
//
// The smoke run and the preview are started by a script that holds the
// stand-in bucket. The app prints a request on stdout and waits for the
// script to print a matching done line on the app's stdin.

import { createInterface } from "node:readline";

/** The script's answers, one line each, read from this process's stdin. */
let answers: AsyncIterator<string> | undefined;

/**
 * ask prints `<who>: ask <what>` and waits for `<who>: done <what>` on stdin.
 * `who` is the script's name: `smoke` or `preview`. Any other line is thrown
 * as an error.
 */
export async function ask(who: string, what: string): Promise<void> {
  answers ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  console.log(`${who}: ask ${what}`);
  const next = await answers.next();
  if (next.done === true) throw new Error(`${who} stopped answering before ${what}`);
  if (next.value !== `${who}: done ${what}`) throw new Error(next.value.replace(`${who}: `, ""));
}
