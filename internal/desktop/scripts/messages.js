// Compiling the app's text.
//
// Every sentence the app says is in messages/<locale>.json, one file a
// language, in inlang's message format. Paraglide compiles them to
// src/paraglide: a typed function for each message, so a key that is not there
// or a parameter left out fails `vp check` and never reaches a person.
//
// The options are here because four things compile with them: the Vite plugin
// for the renderer and the tests, the build before it bundles main and preload,
// `vp run check`, which lints against the compiled functions, and the web
// build in @uno/web, which runs the same plugin over the same files.
//
// The pseudo-locale is written from the English before each of them compiles.
// See pseudo.js for what it is for.

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
  // Absolute, so the web build compiles them from its own package's cwd.
  project: join(PACKAGE, "project.inlang"),
  outdir: join(PACKAGE, "src", "paraglide"),
  // The locale is a variable the app sets: the renderer from its settings, main
  // from what the renderer tells it. Until it is set the app speaks the base
  // locale, which is what a test gets.
  strategy: ["globalVariable", "baseLocale"],
  // The same output in dev and in a build, where the plugin would otherwise
  // choose by NODE_ENV.
  outputStructure: "message-modules",
  // Main has no requests to keep apart, so the locale needs no async storage.
  disableAsyncLocalStorage: true,
  emitReadme: false,
};

/**
 * writePseudo writes the pseudo-locale's messages from the base locale's. It
 * leaves a file that already says the same alone, so a watcher is not told of
 * a change that was not one.
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
 * The Vite plugins that keep the compiled messages current: the pseudo-locale
 * written again whenever the English changes, and Paraglide compiling whatever
 * message file changed.
 *
 * @returns {import("vite").PluginOption[]}
 */
export function messagesPlugins() {
  // Now, and not in a hook: Paraglide compiles as the build starts, and the
  // pseudo-locale has to be on disk by then.
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

// `node scripts/messages.js`, for a check that has no build before it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await compileMessages();
}
