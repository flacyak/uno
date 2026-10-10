// Compiles the app's messages.
//
// The messages are in messages/<locale>.json, one file per language, in
// inlang's message format. Paraglide compiles them to src/paraglide, one
// typed function per message.
//
// The options are shared by the Vite plugin for the renderer and the tests,
// the build before it bundles main and preload, and `vp run check`.
//
// The pseudo-locale is written from the English before each compile. See
// pseudo.js.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compile, paraglideVitePlugin } from "@inlang/paraglide-js";

import { PSEUDO_LOCALE, pseudoMessages } from "./pseudo.js";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The locale every other one is translated from. */
const BASE_LOCALE = "en-US";

/** @param {string} locale */
const messageFile = (locale) => join(PACKAGE, "messages", `${locale}.json`);

/** @type {import("@inlang/paraglide-js").CompilerOptions} */
export const MESSAGES = {
  // Absolute, so the compile works from any cwd.
  project: join(PACKAGE, "project.inlang"),
  outdir: join(PACKAGE, "src", "paraglide"),
  // The locale is a global variable the app sets. Until it is set, the base
  // locale is used.
  strategy: ["globalVariable", "baseLocale"],
  // The same output structure in dev and in a build.
  outputStructure: "message-modules",
  // The locale is one plain global.
  disableAsyncLocalStorage: true,
  emitReadme: false,
};

/**
 * writePseudo writes the pseudo-locale's messages from the base locale's. A
 * file that already has the same text is left alone, so watchers stay quiet.
 */
export function writePseudo() {
  const base = JSON.parse(readFileSync(messageFile(BASE_LOCALE), "utf8"));
  const text = `${JSON.stringify(pseudoMessages(base), null, 2)}\n`;
  const path = messageFile(PSEUDO_LOCALE);
  let was;
  try {
    was = readFileSync(path, "utf8");
  } catch {
    was = undefined;
  }
  if (was !== text) writeFileSync(path, text);
}

export async function compileMessages() {
  writePseudo();
  await compile(MESSAGES);
}

/**
 * The Vite plugins that keep the compiled messages current: one rewrites the
 * pseudo-locale when the English changes, and Paraglide recompiles whatever
 * message file changed.
 *
 * @returns {import("vite").PluginOption[]}
 */
export function messagesPlugins() {
  // Written as the plugins are made: Paraglide compiles as the build starts,
  // and the pseudo-locale has to be on disk by then.
  writePseudo();
  const base = messageFile(BASE_LOCALE);
  return [
    {
      name: "uno-pseudo-messages",
      watchChange(id) {
        if (id === base) writePseudo();
      },
    },
    paraglideVitePlugin(MESSAGES),
  ];
}

// Run directly as `node scripts/messages.js`: compile once.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await compileMessages();
}
