/**
 * @fileoverview Node reads the alias map the way TypeScript and Vite do.
 *
 * tsconfig.paths.json is where `@engine`, `@store/s3` and the rest are
 * defined. TypeScript reads it through each package's tsconfig, Vite through
 * resolve.tsconfigPaths and tsdown through the tsconfig it finds. Node reads
 * nothing of the kind, and the smoke, preview and efficiency scripts run
 * under Node alone with grid source loaded straight off the disk. This is
 * what lets them: `node --import ../paths.js scripts/smoke.js`.
 *
 * Every target in the map names a file with its extension, so a match is
 * handed to Node as a file URL and nothing is probed for.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const MAP = new URL("./tsconfig.paths.json", import.meta.url);

/** @type {Record<string, string[]>} */
const paths = JSON.parse(readFileSync(MAP, "utf8").replace(/^\s*\/\/.*$/gm, "")).compilerOptions
  .paths;

/**
 * The file a specifier names under the map, or undefined when none does.
 * @param {string} specifier
 * @returns {string | undefined}
 */
function mapped(specifier) {
  for (const [pattern, [target]] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (specifier === pattern) return new URL(target, MAP).href;
      continue;
    }
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (specifier.length <= head.length + tail.length) continue;
    if (!specifier.startsWith(head) || !specifier.endsWith(tail)) continue;
    const rest = specifier.slice(head.length, specifier.length - tail.length);
    return new URL(target.replace("*", rest), MAP).href;
  }
  return undefined;
}

registerHooks({
  resolve(specifier, context, next) {
    return next(mapped(specifier) ?? specifier, context);
  },
});
