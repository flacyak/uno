// What the + menu makes of a pasted S3 address, before any engine is asked.

import { expect, test } from "vite-plus/test";

import { remoteRef } from "../src/renderer/shell/add.ts";

test("an S3 address becomes a source named after its object, in s3:// form", () => {
  expect(
    remoteRef("https://acme-exports.s3.eu-west-1.amazonaws.com/2025/q3/Google%20Ads.csv"),
  ).toEqual({
    name: "Google Ads.csv",
    path: "s3://acme-exports/2025/q3/Google Ads.csv",
  });
  expect(remoteRef("s3://acme-exports/ledger.csv")).toEqual({
    name: "ledger.csv",
    path: "s3://acme-exports/ledger.csv",
  });
});

test("anything else is answered with what an address should look like", () => {
  for (const typed of ["", "ledger.csv", "s3://acme-exports", "https://example.com/a.csv"]) {
    expect(remoteRef(typed), typed).toMatch(/^not an S3 object · /);
  }
});

test("an address the URL parser chokes on is answered, not thrown", () => {
  // A bare per cent is a stray escape, and decoding a path that holds one
  // raises a URIError rather than returning anything. The + menu asks about
  // whatever was typed, so a typo like this reaches the check before anything
  // else, and the person gets the same answer as for any other address that is
  // not an object in S3 -- an Enter that appears to do nothing is the one
  // outcome the menu cannot explain.
  for (const typed of [
    "https://example.com/100%.csv",
    "https://s3.eu-west-1.amazonaws.com/acme/50%off.csv",
    "https://acme-exports.s3.amazonaws.com/50%off.csv",
    "https://s3.amazonaws.com/100%/ledger.csv",
  ]) {
    expect(() => remoteRef(typed), typed).not.toThrow();
    expect(remoteRef(typed), typed).toMatch(/^not an S3 object · /);
  }
});
