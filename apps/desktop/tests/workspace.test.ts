/**
 * @fileoverview The name a Save As suggests for a workspace: its first
 * source's stem, every extension dropped, plus .uno.
 */

import { expect, test } from "vite-plus/test";

import { m } from "@paraglide/messages";
import { suggestedName } from "@renderer/workspace";

test("a workspace is suggested its first source's name, with .uno for its extensions", () => {
  expect(suggestedName("sales-q3.csv")).toBe("sales-q3.uno");
  expect(suggestedName("orders.csv.gz")).toBe("orders.uno");
  expect(suggestedName("s3://acme-exports/2025/Q3 Ads.TSV")).toBe("Q3 Ads.uno");
});

test("a source with no stem suggests the workspace's own name", () => {
  expect(suggestedName("")).toBe(`${m.workspace_file_stem()}.uno`);
});
