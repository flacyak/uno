// Reading a source out of a real bucket, with the credentials this machine
// has.
//
// It runs only when UNO_S3_LIVE names objects to read (s3:// URLs separated
// by spaces or commas) and is skipped otherwise, CI included. Each object
// must be a copy of testdata/sales-q3.csv.
//
//   UNO_S3_LIVE="s3://uno-live-use1/sales-q3.csv s3://uno-live-euw1/sales-q3.csv" vp test s3.live
//
// UNO_S3_LIVE_ELSEWHERE names one such object in a bucket outside the region
// the credentials sign for. The block that reads it asserts a refusal was
// seen and reports which channel carried the region:
//
//   UNO_S3_LIVE_ELSEWHERE="s3://uno-live-euw1/sales-q3.csv" \
//     AWS_REGION=us-east-1 vp test s3.live
//
// UNO_S3_LIVE_KEYS names an s3:// prefix holding a copy of the fixture under
// each key in awkward.ts. Seed it once:
//
//   for k in "sales q3.csv" "sales+q3.csv" "100%.csv" ... ; do
//     aws s3api put-object --bucket uno-live-use1 --key "awkward/$k" \
//       --body testdata/sales-q3.csv
//   done
//   UNO_S3_LIVE_KEYS="s3://uno-live-use1/awkward/" vp test s3.live
//
// The dot-segment keys are tested only against the stand-in.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { readContainer } from "../../src/document/index.ts";
import { awsCredentials, diskProvider } from "../../src/store/node.ts";
import { s3Files, s3Location, s3Provider } from "../../src/store/s3.ts";
import { bytes, connect, indexed, openOne, sales, sheetRows, widened } from "../engine/harness.ts";
import { LAST_ROW, ROWS, UNITS } from "../testdata/sales-q3.ts";
import { AWKWARD_KEYS } from "./awkward.ts";

const URLS = (process.env["UNO_S3_LIVE"] ?? "").split(/[\s,]+/).filter((u) => u !== "");
/** An s3:// prefix holding a copy of the fixture under each awkward key. */
const PREFIX = (process.env["UNO_S3_LIVE_KEYS"] ?? "").trim();
/** One copy of the fixture, in a bucket outside the credentials' own region. */
const ELSEWHERE = (process.env["UNO_S3_LIVE_ELSEWHERE"] ?? "").trim();

/** A real round trip is slower than localhost. */
const TIMEOUT = 120_000;

/** How much of a refusal body is kept, matching what s3.ts reads of one. */
const REFUSAL_BYTES = 64 << 10;

/** One request uno sent, and what S3 answered it with. */
interface Exchange {
  method: string;
  range: string | undefined;
  status: number;
  /**
   * The `x-amz-bucket-region` header, or undefined when absent.
   */
  region: string | undefined;
  /** The XML of a refusal, kept only for a 301 or a 400. */
  body: string | undefined;
}

/**
 * watched is a fetch that records both halves of every exchange in `seen`.
 * With `strip`, it removes `x-amz-bucket-region` from the reply before uno
 * sees it, leaving the body as the only channel.
 */
function watched(seen: Exchange[], strip = false): typeof fetch {
  return async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const res = await fetch(input, init);
    const refused = res.status === 301 || res.status === 400;
    seen.push({
      method: init?.method ?? "GET",
      range: headers["range"],
      status: res.status,
      region: res.headers.get("x-amz-bucket-region") ?? undefined,
      body: refused ? await refusalText(res) : undefined,
    });
    if (!strip) return res;
    const kept = new Headers(res.headers);
    kept.delete("x-amz-bucket-region");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: kept,
    });
  };
}

/** A refusal as text, read off a clone so the reply uno gets is still whole. */
async function refusalText(res: Response): Promise<string> {
  const all = await res.clone().arrayBuffer();
  const keep = Math.min(all.byteLength, REFUSAL_BYTES);
  return new TextDecoder().decode(new Uint8Array(all, 0, keep));
}

/** The three shapes s3.ts reads a region out of a refusal's XML. */
const REGION_IN_BODY = /<Region>|expecting '|<Endpoint>/i;

describe.skipIf(URLS.length === 0)("a source in a real bucket", () => {
  for (const url of URLS) {
    const loc = s3Location(url);
    const name = loc?.key.slice(loc.key.lastIndexOf("/") + 1) ?? url;

    /** Providers with the machine's credentials, and every request they send. */
    function providers() {
      const seen: Exchange[] = [];
      const wired = [
        diskProvider(),
        s3Provider({ credentials: awsCredentials(), fetch: watched(seen) }),
      ];
      return { wired, seen };
    }

    test(
      `${url}: opens, indexes, reads its last rows, and saves as a pointer`,
      async () => {
        expect(loc, `${url} is not an s3:// URL`).toBeDefined();
        const dir = await mkdtemp(join(tmpdir(), "uno-s3-live-"));

        const first = providers();
        const a = connect(undefined, first.wired);
        let uno: Uint8Array;
        try {
          const src = await openOne(a.engine, { name, path: url });
          expect(src.opened.link).toEqual({ path: url });
          await indexed(src);
          expect(src.progress.rows, `${url} should be a copy of testdata/sales-q3.csv`).toBe(ROWS);

          // The end of the object is where a range off by one byte shows.
          const { rows } = await src.rows(LAST_ROW - 4, 10);
          expect(widened(rows)).toEqual(sheetRows(sales, LAST_ROW - 4, 10, "raw"));

          // S3 was asked for its size and for ranges only.
          const gets = first.seen.filter((r) => r.method === "GET");
          expect(first.seen.some((r) => r.method === "HEAD")).toBe(true);
          expect(gets.length).toBeGreaterThan(0);
          expect(gets.every((r) => r.range !== undefined)).toBe(true);

          a.engine.mode(true);
          await src.edit({ op: "set", row: LAST_ROW, col: UNITS, now: "1204" });
          uno = await a.engine.save(
            { source: src.id, cells: [], at: join(dir, "q3.uno") },
            1 << 20,
          );
        } finally {
          a.done();
        }

        // The .uno holds where the object is and the edit, and is smaller than
        // the object.
        expect(readContainer("q3.uno", uno).manifest.sources[0]!.path).toBe(url);
        expect(uno.length).toBeLessThan(bytes.length);
        await writeFile(join(dir, "q3.uno"), uno);

        const b = connect(undefined, providers().wired);
        try {
          const src = await openOne(b.engine, { name: "q3.uno", path: join(dir, "q3.uno") });
          expect(src.opened.link).toEqual({ path: url });
          expect((await src.rows(LAST_ROW, 1)).rows[0]![UNITS]).toBe("1204");
        } finally {
          b.done();
        }
      },
      TIMEOUT,
    );
  }
});

// This block reads the refusal S3 sends for a bucket in another region and
// reports which channel, header or body, carried the region.
describe.skipIf(ELSEWHERE === "")("a bucket in another region", () => {
  const loc = s3Location(ELSEWHERE);
  const name = loc?.key.slice(loc.key.lastIndexOf("/") + 1) ?? ELSEWHERE;

  test(
    "opens, reads its last rows, and says which channel carried the region",
    async () => {
      expect(loc, `${ELSEWHERE} is not an s3:// URL`).toBeDefined();
      const seen: Exchange[] = [];
      const { engine, done } = connect(undefined, [
        diskProvider(),
        s3Provider({ credentials: awsCredentials(), fetch: watched(seen) }),
      ]);
      try {
        const src = await openOne(engine, { name, path: ELSEWHERE });
        await indexed(src);
        expect(src.progress.rows, `${ELSEWHERE} should be a copy of testdata/sales-q3.csv`).toBe(
          ROWS,
        );
        const { rows } = await src.rows(LAST_ROW - 4, 10);
        expect(widened(rows)).toEqual(sheetRows(sales, LAST_ROW - 4, 10, "raw"));
      } finally {
        done();
      }

      // A refusal must have been seen. Otherwise the object was in the
      // credentials' own region and went straight through.
      const refusals = seen.filter((r) => r.status === 301 || r.status === 400);
      expect(
        refusals.length,
        `${ELSEWHERE} was never refused · UNO_S3_LIVE_ELSEWHERE has to name an ` +
          `object in a bucket outside the region the credentials sign for`,
      ).toBeGreaterThan(0);

      const header = refusals.some((r) => r.region !== undefined);
      const body = refusals.some((r) => r.body !== undefined && REGION_IN_BODY.test(r.body));
      const channel =
        header && body ? "both" : header ? "the header" : body ? "the body" : "neither";
      console.log(`${ELSEWHERE}: S3 named the region in ${channel}`);
      expect(header || body, `S3 refused, and named the region in ${channel}`).toBe(true);
    },
    TIMEOUT,
  );

  // Only the header is stripped. The 400 and its body come from AWS.
  test(
    "opens on the body alone when the header never arrives",
    async () => {
      expect(loc, `${ELSEWHERE} is not an s3:// URL`).toBeDefined();
      const seen: Exchange[] = [];
      const s3 = s3Files({ credentials: awsCredentials(), fetch: watched(seen, true) });
      const file = await s3.open({ name, path: ELSEWHERE });
      try {
        expect(file.size, `${ELSEWHERE} should be a copy of testdata/sales-q3.csv`).toBe(
          bytes.length,
        );
        expect(await file.read(0, 512)).toEqual(bytes.subarray(0, 512));
      } finally {
        await file.close();
      }

      // A HEAD carries headers only, so uno must have sent a GET probe to read
      // the XML.
      const probe = seen.find((r) => r.method === "GET" && r.range === "bytes=0-0");
      expect(probe, "the region came from somewhere a body could reach").toBeDefined();
    },
    TIMEOUT,
  );
});

// Each awkward key against real S3: a HEAD and two ranges. A matching size
// and both ends of the fixture mean the signature was accepted and the right
// object was read.
describe.skipIf(PREFIX === "")("awkward keys in a real bucket", () => {
  const s3 = () => s3Files({ credentials: awsCredentials() });
  /** Enough of each end to be sure, and short enough to be two small requests. */
  const EDGE = 512;

  for (const [key] of AWKWARD_KEYS) {
    const url = `${PREFIX.replace(/\/+$/, "")}/${key}`;

    test(
      `${key}: opens, and both ends are the fixture`,
      async () => {
        expect(s3Location(url), `${url} is not an s3:// URL`).toBeDefined();
        const file = await s3().open({ name: key, path: url });
        try {
          expect(file.size, `${url} should be a copy of testdata/sales-q3.csv`).toBe(bytes.length);
          expect(await file.read(0, EDGE)).toEqual(bytes.subarray(0, EDGE));
          const tail = bytes.length - EDGE;
          expect(await file.read(tail, EDGE)).toEqual(bytes.subarray(tail));
        } finally {
          await file.close();
        }
      },
      TIMEOUT,
    );
  }

  // One awkward key indexed and read to the end, like the plain one above.
  test(
    "one of them indexes and reads its last rows like any other source",
    async () => {
      const key = AWKWARD_KEYS[0]![0];
      const url = `${PREFIX.replace(/\/+$/, "")}/${key}`;
      const { engine, done } = connect(undefined, [
        diskProvider(),
        s3Provider({ credentials: awsCredentials() }),
      ]);
      try {
        const src = await openOne(engine, { name: key, path: url });
        expect(src.opened.link).toEqual({ path: url });
        await indexed(src);
        expect(src.progress.rows).toBe(ROWS);
        const { rows } = await src.rows(LAST_ROW - 4, 10);
        expect(widened(rows)).toEqual(sheetRows(sales, LAST_ROW - 4, 10, "raw"));
      } finally {
        done();
      }
    },
    TIMEOUT,
  );
});
