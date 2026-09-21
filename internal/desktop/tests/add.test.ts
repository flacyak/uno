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
