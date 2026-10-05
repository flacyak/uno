// Compiling the app's text.
//
// Every sentence the app says is in messages/<locale>.json, one file a
// language, in inlang's message format. Paraglide compiles them to
// src/paraglide: a typed function for each message, so a key that is not there
// or a parameter left out fails `vp check` and never reaches a person.
//
// The options are here because three things compile with them: the Vite plugin
// for the renderer and the tests, the build before it bundles main and preload,
// and `vp run check`, which lints against the compiled functions.

import { pathToFileURL } from "node:url";

import { compile } from "@inlang/paraglide-js";

/** @type {import("@inlang/paraglide-js").CompilerOptions} */
export const MESSAGES = {
  project: "./project.inlang",
  outdir: "./src/paraglide",
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

export async function compileMessages() {
  await compile(MESSAGES);
}

// `node scripts/messages.js`, for a check that has no build before it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await compileMessages();
}
