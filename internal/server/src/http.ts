// What both programs do with a request: read its body, answer with JSON, and
// hand out a file from a folder.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

/** An answer with a status and a sentence, thrown from anywhere under a route. */
export class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** json answers with one value, as the page reads it. */
export function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** body reads a request whole, refusing one over `limit` bytes before it is held. */
export function body(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new Refused(413, `the body is over the ${limit} bytes this takes in one request`));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(parts))));
    req.on("error", reject);
  });
}

/** The types a web build is made of. Anything else is handed out as bytes. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * Static hands out the files of one folder: a built web page. A path that
 * names no file, or one outside the folder, is the page itself, since the
 * page is the whole app and its router is the address bar.
 */
export class Static {
  private readonly root: string;
  constructor(root: string) {
    this.root = normalize(root);
  }

  /** The file under the root a request path names, or the page. */
  private fileFor(pathname: string): string {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = join(this.root, rel);
    return full.startsWith(this.root + sep) || full === this.root ? full : this.root;
  }

  async serve(pathname: string, res: ServerResponse): Promise<void> {
    let file = this.fileFor(pathname);
    let found = await stat(file).catch(() => undefined);
    if (found === undefined || found.isDirectory()) {
      file = join(this.root, "index.html");
      found = await stat(file).catch(() => undefined);
    }
    if (found === undefined) throw new Refused(404, `no page is built at ${this.root}`);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": found.size,
      // The page is small and its assets are named by their hash, so the
      // page is asked for every time and the assets never are.
      "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(res);
  }
}
