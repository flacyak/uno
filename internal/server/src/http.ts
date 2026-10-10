// HTTP helpers shared by the engine and the gate: read a request body, answer
// with JSON, and serve a file from a folder.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

/** An error carrying the HTTP status to answer with. */
export class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Writes `value` as a JSON response with the given status. */
export function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Reads the whole request body. Rejects with a 413 `Refused` once more than
 * `limit` bytes have arrived.
 */
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

/** Content types by extension. Other extensions are served as octet-stream. */
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
 * Serves the files of one folder, a built single-page app. index.html is
 * served for a directory, a missing file, or a path outside the folder.
 */
export class Static {
  private readonly root: string;
  constructor(root: string) {
    this.root = normalize(root);
  }

  /** The file under the root that `pathname` names, or the root itself when
   * the path points outside it. */
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
      // index.html is fetched fresh each time. Every other asset has a hash in
      // its name, so it is cached for a year.
      "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(res);
  }
}
