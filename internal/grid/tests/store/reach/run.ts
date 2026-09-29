// Runs part of the core under plain Node with every way out of it watched, and
// prints which of its modules took which way.
//
// It is started by reaches.test.ts as its own process, never imported: what it
// does to Node -- a resolve hook, and a wrapper around every function that
// reads a file, opens a socket or starts a program -- is for this process only.
// It runs the source itself, through Node's own type stripping, so a way out
// is attributed to the .ts file that took it and every load of a module goes
// through the hook, which Vitest's own loader would not.
//
// Usage: node --experimental-transform-types run.ts <root> <scenario>
// <root> is the folder uses are attributed under, and <scenario> a module whose
// default export is run with everything watched.

import { registerHooks, syncBuiltinESMExports } from "node:module";
import { createRequire } from "node:module";
import { relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MODULES } from "../ways.ts";
import type { Way } from "../ways.ts";

const [root, scenario] = process.argv.slice(2);
if (root === undefined || scenario === undefined) {
  throw new Error("usage: run.ts <root> <scenario>");
}

/** Every way out a module under root took, as `file\tway`, once each. */
const uses = new Set<string>();

/** The module under root a URL or a path is, or undefined for anything else. */
function under(at: string | undefined): string | undefined {
  if (at === undefined || at.startsWith("node:")) return undefined;
  const path = at.startsWith("file:") ? fileURLToPath(at) : at;
  const rel = relative(root!, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  return rel.split(sep).join("/");
}

function use(file: string | undefined, way: Way): void {
  if (file !== undefined) uses.add(`${file}\t${way}`);
}

/**
 * caller is the module that called the function wrapping this one: the frame
 * two above here. Only a direct call counts, so a socket fetch opens for its
 * own request is fetch's and not the socket rule's, and a file a dependency
 * reads is not blamed on whoever called the dependency.
 */
function caller(): string | undefined {
  const frames = (new Error().stack ?? "").split("\n").slice(3);
  const at = /\((.*):\d+:\d+\)$|at (.*):\d+:\d+$/.exec(frames[0] ?? "");
  return under(at?.[1] ?? at?.[2]);
}

/** Which way each Node module is, by the name it is loaded under. */
const WAY_OF = new Map<string, Way>(
  Object.entries(MODULES).flatMap(([way, modules]) => modules.map((m) => [m, way as Way])),
);

// Every load of a module, including one whose name is put together at run
// time, goes through here with the module that asked for it.
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (resolved.url.startsWith("node:")) {
      const way = WAY_OF.get(resolved.url.slice("node:".length));
      if (way !== undefined) use(under(context.parentURL), way);
    }
    return resolved;
  },
});

// A module can also be handed one without loading it at all.
const getBuiltin = process.getBuiltinModule.bind(process);
process.getBuiltinModule = ((id: string) => {
  const way = WAY_OF.get(id.replace(/^node:/, ""));
  if (way !== undefined) use(caller(), way);
  return getBuiltin(id);
}) as typeof process.getBuiltinModule;

// And every function of those modules, so a way out is seen where it is
// taken, however the module got into hand. Constructors are left alone, since
// a wrapper would break `new`; the functions that open or start one are what
// is watched.
/**
 * watch is `fn` with every call seen as `way`. What hangs off the function
 * comes with it, wrapped the same where it is a function too: execFile's
 * promisified form, realpath's native one.
 */
const wrapped = new WeakMap<object, (...a: unknown[]) => unknown>();
function watch(fn: (...a: unknown[]) => unknown, way: Way): (...a: unknown[]) => unknown {
  // A function whose own property is itself, or leads back to it, is wrapped
  // once and met again as the same wrapper.
  const known = wrapped.get(fn);
  if (known !== undefined) return known;
  const watched = function (this: unknown, ...args: unknown[]): unknown {
    use(caller(), way);
    return fn.apply(this, args);
  };
  wrapped.set(fn, watched);
  for (const key of Reflect.ownKeys(fn)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const value: unknown = (fn as unknown as Record<PropertyKey, unknown>)[key];
    Object.defineProperty(watched, key, {
      value:
        typeof value === "function" ? watch(value as (...a: unknown[]) => unknown, way) : value,
      writable: true,
      configurable: true,
    });
  }
  return watched;
}

const require = createRequire(import.meta.url);
for (const [name, way] of WAY_OF) {
  const mod = require(name) as Record<string, unknown>;
  for (const key of Object.keys(mod)) {
    const fn = mod[key];
    if (typeof fn !== "function" || !/^[a-z]/.test(key)) continue;
    mod[key] = watch(fn as (...a: unknown[]) => unknown, way);
  }
}
syncBuiltinESMExports();

/** globalThis's own ways out, which no import is needed to reach. */
function watchGlobal(key: string, way: Way): void {
  const g = globalThis as Record<string, unknown>;
  const fn = g[key];
  if (typeof fn !== "function") return;
  g[key] = new Proxy(fn, {
    apply(target, self, args) {
      use(caller(), way);
      return Reflect.apply(target, self, args);
    },
    construct(target, args) {
      use(caller(), way);
      return Reflect.construct(target, args);
    },
  });
}
watchGlobal("fetch", "fetch");
watchGlobal("WebSocket", "a page's own requests");
watchGlobal("XMLHttpRequest", "a page's own requests");
watchGlobal("EventSource", "a page's own requests");

const arrayBuffer = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer")!.value as (
  this: Blob,
) => Promise<ArrayBuffer>;
Blob.prototype.arrayBuffer = function watched(this: Blob) {
  use(caller(), "a Blob's bytes");
  return arrayBuffer.call(this);
};

const run = (await import(pathToFileURL(scenario).href)) as { default: () => Promise<void> };
await run.default();

process.stdout.write(
  JSON.stringify(
    [...uses].sort().map((u) => {
      const [file, way] = u.split("\t");
      return { file, way };
    }),
  ) + "\n",
);
// Whatever the scenario left listening is not this process's to wait for.
process.exit(0);
