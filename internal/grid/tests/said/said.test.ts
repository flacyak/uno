// What the engine says, as data: the English it has always been, and what
// crosses a port so a client can say it in another language.

import { describe, expect, test } from "vite-plus/test";

import { Refusal, english, saidOf } from "../../src/said/index.ts";
import type { Said } from "../../src/said/index.ts";
import { FIXTURE, connect, openOne } from "../engine/harness.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe("english", () => {
  test("is the sentence as it was written before it was data", () => {
    expect(english({ t: "nothing-to-undo" })).toBe("there is nothing to undo");
    expect(english({ t: "read", delimiter: ",", header: "first" })).toBe("UTF-8 · delimiter ','");
    expect(english({ t: "read", delimiter: "\t", header: "none" })).toBe(
      "UTF-8 · tab-separated · no header row",
    );
    expect(
      english({ t: "workspace-too-large", name: "q4.uno", bytes: 3 * GB, limit: 256 * MB }),
    ).toBe("q4.uno is 3.0 GB, over the 256 MB a workspace can be read whole");
  });

  test("says what went wrong with something by naming it first, however deep", () => {
    const said: Said = {
      t: "about",
      subject: "q4.uno",
      why: { t: "replaying", name: "ads.csv", why: { t: "text", text: "row 9 is not there" } },
    };
    expect(english(said)).toBe("q4.uno: replaying edits to ads.csv: row 9 is not there");
  });

  test("describes a program a step at a time", () => {
    expect(english({ t: "program", steps: [] })).toBe("change nothing");
    expect(
      english({
        t: "program",
        steps: [
          { t: "remove", what: { t: "chars", names: ["commas", "spaces"], where: "end" } },
          { t: "replace", what: { t: "literal", text: "N/A" }, with: "" },
          { t: "upper" },
        ],
      }),
    ).toBe('remove commas and spaces from the end, then replace "N/A" with "", then upper-case it');
  });

  test("says a file changed with both sizes, or that only its version did", () => {
    expect(english({ t: "version-changed", name: "ads.csv" })).toBe(
      "ads.csv is not the version the workspace was saved against · it is the same size",
    );
    expect(english({ t: "size-changed", name: "ads.csv", now: 2048, was: 1024 })).toBe(
      "ads.csv is 2.0 KB now and was 1.0 KB when the workspace was saved",
    );
  });
});

describe("a Refusal", () => {
  test("is an Error whose message is the English of what it says", () => {
    const err = new Refusal({ t: "only-source", name: "ads.csv" });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("ads.csv is the only source here, and a workspace needs one");
    expect(saidOf(err)).toEqual({ t: "only-source", name: "ads.csv" });
  });

  test("anything else that was thrown says its message as text", () => {
    expect(saidOf(new Error("ENOENT: no such file"))).toEqual({
      t: "text",
      text: "ENOENT: no such file",
    });
    expect(saidOf("a string was thrown")).toEqual({ t: "text", text: "a string was thrown" });
  });

  test("crosses the port as data, and is a Refusal again on the other side", async () => {
    const { engine, done } = connect();
    try {
      const src = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
      engine.mode(true);
      const refused: unknown = await src.undo().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refused).toBeInstanceOf(Refusal);
      expect(saidOf(refused)).toEqual({ t: "nothing-to-undo" });
      expect((refused as Error).message).toBe("there is nothing to undo");
    } finally {
      done();
    }
  });
});
