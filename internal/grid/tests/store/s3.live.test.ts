// Reading a source out of a real bucket.
//
// s3.test.ts holds the signing to AWS's examples and runs everything else
// against a stand-in. This holds the stand-in to S3: the same open, index, read
// and save, against real objects, with the credentials this machine has.
//
// It runs only when UNO_S3_LIVE names objects to read -- s3:// URLs, separated
// by spaces or commas -- and is skipped everywhere else, CI included. Each
// object must be a copy of testdata/sales-q3.csv, so what comes back can be
// checked cell for cell. Put one in a bucket in the credentials' own region and
// one in a bucket somewhere else, and the redirect is exercised against S3 too.
//
//   UNO_S3_LIVE="s3://uno-live-use1/sales-q3.csv s3://uno-live-euw1/sales-q3.csv" vp test s3.live
//
// UNO_S3_LIVE_KEYS does the same for the keys in awkward.ts, and names an
// s3:// prefix rather than an object, because there are ten of them. Seed it
// once -- s3Files only ever reads, so nothing here can put them there:
//
//   for k in "sales q3.csv" "sales+q3.csv" "100%.csv" ... ; do
//     aws s3api put-object --bucket uno-live-use1 --key "awkward/$k" \
//       --body testdata/sales-q3.csv
//   done
//   UNO_S3_LIVE_KEYS="s3://uno-live-use1/awkward/" vp test s3.live
//
// The dot-segment keys are left to the stand-in. They never reach the wire
// intact, so there is nothing for a real bucket to say about them.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { readContainer } from "../../src/document/index.ts";
import { awsCredentials, localFiles } from "../../src/store/node.ts";
import { s3Files, s3Location } from "../../src/store/s3.ts";
import { bytes, connect, indexed, openOne, sales, sheetRows, widened } from "../engine/harness.ts";
import { LAST_ROW, ROWS, UNITS } from "../testdata/sales-q3.ts";
import { AWKWARD_KEYS } from "./awkward.ts";

const URLS = (process.env["UNO_S3_LIVE"] ?? "").split(/[\s,]+/).filter((u) => u !== "");
/** An s3:// prefix holding a copy of the fixture under each awkward key. */
const PREFIX = (process.env["UNO_S3_LIVE_KEYS"] ?? "").trim();

/** A real round trip is slower than localhost: an index pass is dozens of them. */
const TIMEOUT = 120_000;

describe.skipIf(URLS.length === 0)("a source in a real bucket", () => {
  for (const url of URLS) {
    const loc = s3Location(url);
    const name = loc?.key.slice(loc.key.lastIndexOf("/") + 1) ?? url;

    /** Handlers with the machine's credentials, and every request they send. */
    function handlers() {
      const seen: Array<{ method: string; range: string | undefined }> = [];
      const files = [
        localFiles(),
        s3Files({
          credentials: awsCredentials(),
          fetch: (input, init) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            seen.push({ method: init?.method ?? "GET", range: headers["range"] });
            return fetch(input, init);
          },
        }),
      ];
      return { files, seen };
    }

    test(
      `${url}: opens, indexes, reads its last rows, and saves as a pointer`,
      async () => {
        expect(loc, `${url} is not an s3:// URL`).toBeDefined();
        const dir = await mkdtemp(join(tmpdir(), "uno-s3-live-"));

        const first = handlers();
        const a = connect(undefined, first.files);
        let uno: Uint8Array;
        try {
          const src = await openOne(a.engine, { name, path: url });
          expect(src.opened.link).toEqual({ path: url });
          await indexed(src);
          expect(src.progress.rows, `${url} should be a copy of testdata/sales-q3.csv`).toBe(ROWS);

          // The end of the object is where a range off by one byte shows.
          const { rows } = await src.rows(LAST_ROW - 4, 10);
          expect(widened(rows)).toEqual(sheetRows(sales, LAST_ROW - 4, 10, "raw"));

          // S3 was asked for its size and for ranges, never for the whole object.
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

        // The .uno holds where the object is and the edit, and none of its bytes.
        expect(readContainer("q3.uno", uno).manifest.sources[0]!.path).toBe(url);
        expect(uno.length).toBeLessThan(bytes.length);
        await writeFile(join(dir, "q3.uno"), uno);

        const b = connect(undefined, handlers().files);
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

// S3 is the only thing that can settle whether uno encodes a key the way S3
// decodes it. The stand-in agrees with uno by construction -- both are this
// repository -- so agreeing with it proves the two halves match, not that
// either is right. One HEAD and two ranges per key is enough to tell: a size
// that matches and both ends of the fixture means the signature was accepted
// and the bytes came from the object that was asked for.
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

  // One of them read the whole way through, so the awkward key is held to the
  // same bar as the plain one in the test above: indexed, and read at the end.
  test(
    "one of them indexes and reads its last rows like any other source",
    async () => {
      const key = AWKWARD_KEYS[0]![0];
      const url = `${PREFIX.replace(/\/+$/, "")}/${key}`;
      const { engine, done } = connect(undefined, [
        localFiles(),
        s3Files({ credentials: awsCredentials() }),
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
