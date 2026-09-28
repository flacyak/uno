// A connection is a .unof that says where a bucket is and how to sign in to it.
//
// What is under test is that the file travels: it reads back as the bytes it
// was written as, it carries what this build does not know, and it never holds
// anything a person could sign in with.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import {
  FORMAT_VERSION,
  covering,
  formatConnection,
  parseConnection,
  stampConnection,
} from "../../src/library/index.ts";
import type { Connection } from "../../src/library/index.ts";

function fixture(id: string): string {
  return readFileSync(fileURLToPath(new URL(`../testdata/${id}.unof`, import.meta.url)), "utf8");
}

/** A connection file as an object, so a test can change one key of it. */
function acme(): Record<string, unknown> {
  return JSON.parse(fixture("acme-exports")) as Record<string, unknown>;
}

function text(o: unknown): string {
  return JSON.stringify(o, undefined, 2) + "\n";
}

describe("the connection files in testdata", () => {
  test("a desktop connection reads as the bucket, the folder and the profile", () => {
    const c = parseConnection("acme-exports.unof", fixture("acme-exports"));
    expect(c).toMatchObject({
      id: "acme-exports",
      name: "ACME exports",
      provider: "s3",
      bucket: "acme-exports",
      prefix: "shop/",
      region: "eu-west-1",
      auth: { mode: "profile", profile: "finance" },
    });
    expect(c.created?.toISOString()).toBe("2026-09-21T09:12:40.000Z");
    expect(c.extra).toBeUndefined();
  });

  // The file is meant to be diffed. A read and a write with nothing changed in
  // between has to be no change at all.
  test("both round-trip byte for byte", () => {
    for (const id of ["acme-exports", "finance-lake"]) {
      const bytes = fixture(id);
      expect(formatConnection(parseConnection(`${id}.unof`, bytes)), id).toBe(bytes);
    }
  });

  test("a hosted connection names a role and no external ID", () => {
    const c = parseConnection("finance-lake.unof", fixture("finance-lake"));
    expect(c.auth).toEqual({ mode: "role", roleArn: "arn:aws:iam::210987654321:role/uno-read" });
    expect(c.created).toBeUndefined();
  });
});

describe("what this build does not know", () => {
  // A newer uno may add keys. An older one opening its file must not drop them
  // and then save the loss back over it.
  test("unknown keys are carried through, around auth and inside it, in name order", () => {
    const o = acme();
    o["zeta"] = { note: "kept" };
    o["alpha"] = [1, 2];
    o["auth"] = { mode: "profile", profile: "finance", ttl: 900 };
    const c = parseConnection("acme-exports.unof", text(o));
    expect([...(c.extra?.keys() ?? [])]).toEqual(["zeta", "alpha"]);

    const back = JSON.parse(formatConnection(c)) as Record<string, unknown>;
    expect(Object.keys(back).slice(-2)).toEqual(["alpha", "zeta"]);
    expect(back["zeta"]).toEqual({ note: "kept" });
    expect(back["auth"]).toEqual({ mode: "profile", profile: "finance", ttl: 900 });
  });

  test("an auth mode it does not know is refused by name", () => {
    const o = acme();
    o["auth"] = { mode: "keychain", item: "acme" };
    expect(() => parseConnection("acme-exports.unof", text(o))).toThrow(
      'acme-exports.unof: this build does not know auth mode "keychain" · it knows machine, profile, role, public',
    );
  });

  test("a provider it does not connect to is refused by name", () => {
    const o = acme();
    o["provider"] = "gcs";
    expect(() => parseConnection("acme-exports.unof", text(o))).toThrow(
      'acme-exports.unof: this build does not connect to "gcs" · it connects to s3',
    );
  });

  test("a file from a newer uno is refused rather than guessed at", () => {
    const o = acme();
    o["format"] = FORMAT_VERSION + 1;
    expect(() => parseConnection("acme-exports.unof", text(o))).toThrow(/newer uno/);
  });

  // The other direction of 2.1: a formula in connections/ is not a connection.
  test("a formula is refused by name, and told where it belongs", () => {
    const formula = fixture("unit-margin");
    expect(() => parseConnection("unit-margin.unof", formula)).toThrow(
      'unit-margin.unof is a formula ("kind": "column"), not a connection · it belongs in formulas/',
    );
  });
});

describe("a connection never holds a secret", () => {
  function withKey(place: (o: Record<string, unknown>) => void): Connection {
    const c = parseConnection("acme-exports.unof", fixture("acme-exports"));
    const o: Record<string, unknown> = {};
    place(o);
    return { ...c, extra: new Map(Object.entries(o)) };
  }

  test("the writer refuses aws_secret_access_key", () => {
    const c = withKey(
      (o) => (o["aws_secret_access_key"] = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    );
    expect(() => formatConnection(c)).toThrow(
      "acme-exports: aws_secret_access_key looks like a secret · uno does not save a connection holding a key",
    );
  });

  test("however it is spelled, and however deep it is", () => {
    for (const key of ["secretAccessKey", "Secret-Access-Key", "sessionToken", "password"]) {
      const c = withKey((o) => (o["vault"] = { nested: { [key]: "x" } }));
      expect(() => formatConnection(c), key).toThrow(`vault.nested.${key} looks like a secret`);
    }
  });

  test("inside the auth block too", () => {
    const c = parseConnection("acme-exports.unof", fixture("acme-exports"));
    const leaky: Connection = {
      ...c,
      auth: { ...c.auth, extra: new Map([["aws_session_token", "FwoGZXIvYXdzE"]]) },
    };
    expect(() => formatConnection(leaky)).toThrow("auth.aws_session_token looks like a secret");
  });

  // An access key id has a shape of its own, so one pasted under an innocent
  // name is caught by what it is rather than what it is called.
  test("an access key id under any name", () => {
    const c = withKey((o) => (o["note"] = "ask ana for AKIAIOSFODNN7EXAMPLE"));
    expect(() => formatConnection(c)).toThrow("note holds an AWS access key id");
  });

  // A file somebody sent that carries a key is refused on the way in, so it is
  // never half-loaded into something that could be saved again.
  test("the reader refuses one as well", () => {
    const o = acme();
    o["aws_secret_access_key"] = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(() => parseConnection("acme-exports.unof", text(o))).toThrow(
      "acme-exports.unof: aws_secret_access_key looks like a secret · a connection names how to sign in and never holds a key",
    );
  });
});

describe("the values that reach outside the file", () => {
  function refused(change: (o: Record<string, unknown>) => void): () => Connection {
    const o = acme();
    change(o);
    return () => parseConnection("acme-exports.unof", text(o));
  }

  // The bucket becomes part of a hostname, so one that could end the host or
  // start a path is a different server to sign for.
  test("a bucket that is not a bucket name", () => {
    for (const bucket of ["evil.example/x", "Acme", "a", "acme..exports", "acme@evil"]) {
      expect(
        refused((o) => (o["bucket"] = bucket)),
        bucket,
      ).toThrow(/is not a bucket name/);
    }
    expect(refused((o) => delete o["bucket"])).toThrow("acme-exports.unof: names no bucket");
  });

  // Without the trailing slash, shop would cover shop-old/ as well.
  test("a prefix that is not a folder", () => {
    for (const prefix of ["shop", "/shop/"]) {
      expect(
        refused((o) => (o["prefix"] = prefix)),
        prefix,
      ).toThrow(/is not a folder/);
    }
  });

  test("a region that could not be one label of a host", () => {
    expect(refused((o) => (o["region"] = "eu-west-1.evil.example"))).toThrow(/is not a region/);
  });

  test("an id that would name a path", () => {
    expect(refused((o) => (o["id"] = "../acme"))).toThrow(
      'acme-exports.unof: connection id "../acme" may not start with a dot',
    );
  });
});

test("a save stamps modified and keeps when it was created", () => {
  const c = parseConnection("acme-exports.unof", fixture("acme-exports"));
  const now = new Date("2026-09-28T10:00:00Z");
  const stamped = stampConnection(c, now);
  expect(stamped.modified).toEqual(now);
  expect(stamped.created).toEqual(c.created);

  const fresh = stampConnection({ ...c, created: undefined, modified: undefined }, now);
  expect(fresh.created).toEqual(now);
});

describe("which connection covers an address", () => {
  const base = parseConnection("acme-exports.unof", fixture("acme-exports"));
  const shop = { ...base, id: "shop", prefix: "shop/" };
  const orders = { ...base, id: "orders", prefix: "shop/2025/" };
  const whole = { ...base, id: "whole", prefix: "" };

  test("the one whose bucket it is in and whose prefix its key starts with", () => {
    expect(covering([shop], "acme-exports", "shop/a.csv")?.id).toBe("shop");
    expect(covering([shop], "acme-finance", "shop/a.csv")).toBeUndefined();
  });

  // The trailing slash 2.2 insists on is what keeps shop/ off shop-old/.
  test("a prefix is a folder, not the start of a name", () => {
    expect(covering([shop], "acme-exports", "shop-old/a.csv")).toBeUndefined();
  });

  test("of several, the longest prefix, whatever order they are listed in", () => {
    for (const list of [
      [whole, shop, orders],
      [orders, whole, shop],
    ]) {
      expect(covering(list, "acme-exports", "shop/2025/a.csv")?.id).toBe("orders");
      expect(covering(list, "acme-exports", "shop/2024/a.csv")?.id).toBe("shop");
      expect(covering(list, "acme-exports", "refunds/a.csv")?.id).toBe("whole");
    }
  });
});
