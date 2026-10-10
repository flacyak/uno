// Runs a scenario under plain Node with every way out of the core watched,
// and prints which module under <root> took which way.
//
// reaches.test.ts starts it as its own process. It installs a resolve hook,
// wraps process.getBuiltinModule, wraps every function of the watched Node
// modules, and wraps fetch, WebSocket, XMLHttpRequest, EventSource and
// Blob.prototype.arrayBuffer. Node's own type stripping runs the .ts source,
// so a use is attributed to the .ts file that made it.
//
// Usage: node --experimental-transform-types run.ts <root> <scenario>
// <root> is the folder uses are attributed under, and <scenario> a module
// whose default export is run.

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

/** The path under root of a URL or path, or undefined for anything else. */
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
 * caller is the module that called the wrapped function: the stack frame two
 * above here. Only the direct caller counts.
 */
function caller(): string | undefined {
  const frames = (new Error().stack ?? "").split("\n").slice(3);
  const at = /\((.*):\d+:\d+\)$|at (.*):\d+:\d+$/.exec(frames[0] ?? "");
  return under(at?.[1] ?? at?.[2]);
}

/** The way each Node module is, by module name. */
const WAY_OF = new Map<string, Way>(
  Object.entries(MODULES).flatMap(([way, modules]) => modules.map((m) => [m, way as Way])),
);

// Every module load, including a dynamic import, goes through this hook with
// the module that asked for it.
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

// process.getBuiltinModule hands a module out past the resolve hook.
const getBuiltin = process.getBuiltinModule.bind(process);
process.getBuiltinModule = ((id: string) => {
  const way = WAY_OF.get(id.replace(/^node:/, ""));
  if (way !== undefined) use(caller(), way);
  return getBuiltin(id);
}) as typeof process.getBuiltinModule;

// Every lower-case function of the watched modules is wrapped. Constructors
// are left alone.
/**
 * watch is `fn` with every call recorded as `way`. Function-valued properties
 * of `fn` are wrapped the same way, such as execFile's promisified form.
 */
const wrapped = new WeakMap<object, (...a: unknown[]) => unknown>();
function watch(fn: (...a: unknown[]) => unknown, way: Way): (...a: unknown[]) => unknown {
  // A function already wrapped gets the same wrapper again.
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

/** Wraps a global function so each call or construction is recorded as `way`. */
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
// Exit now, whatever the scenario left listening.
process.exit(0);
