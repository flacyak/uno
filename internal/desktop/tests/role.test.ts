// @vitest-environment happy-dom
//
// The block a role connection shows: uno's account and the external ID to
// hand to whoever makes the role, each with a Copy button, and what the role
// has to allow. Tested on its own, with no form around it, the way the web
// page and the desktop both mount it.

import { beforeEach, expect, test, vi } from "vite-plus/test";

import { setLocale } from "../src/paraglide/runtime.js";
import { RoleBlock } from "../src/renderer/shell/role.ts";

const TRUST = {
  principal: "arn:aws:iam::111122223333:role/uno-engine",
  externalId: "uno-t-7f3c9a21e04b7f3c9a21e04b7f3c9a21",
};

let copied: string[];
let refuse: boolean;
let block: RoleBlock;

beforeEach(() => {
  void setLocale("en-US", { reload: false });
  copied = [];
  refuse = false;
  block = new RoleBlock((text) => {
    if (refuse) return Promise.reject(new Error("refused"));
    copied.push(text);
    return Promise.resolve();
  });
  document.body.replaceChildren(block.el);
});

const text = (selector: string): string => block.el.querySelector(selector)!.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...block.el.querySelectorAll("button")];
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

test("hidden until shown, then the account, the external ID, and what the role needs", () => {
  expect(block.el.hidden).toBe(true);
  block.show(TRUST);
  expect(block.el.hidden).toBe(false);
  expect(text(".row:nth-of-type(1) span")).toBe("uno's AWS account");
  expect(text(".row:nth-of-type(1) .copyable")).toBe("111122223333");
  expect(text(".row:nth-of-type(2) span")).toBe("Your external ID");
  expect(text(".row:nth-of-type(2) .copyable")).toBe(TRUST.externalId);
  expect(text(".how")).toBe(
    "Give these to whoever manages the bucket. The role they make trusts uno's account with this external ID and may list the bucket and read objects under the prefix. Then paste the role's ARN.",
  );
  expect(text(".needs")).toBe(
    "It allows s3:ListBucket on the bucket, and s3:GetObject and s3:GetObjectVersion under the prefix.",
  );
  block.hide();
  expect(block.el.hidden).toBe(true);
});

test("a principal that is not an ARN is shown whole", () => {
  block.show({ ...TRUST, principal: "uno-engine" });
  expect(text(".row:nth-of-type(1) .copyable")).toBe("uno-engine");
});

test("each Copy button copies the value beside it and says so for a moment", async () => {
  vi.useFakeTimers();
  try {
    block.show(TRUST);
    const [account, externalId] = buttons();
    expect(buttons().map((b) => b.textContent)).toEqual(["Copy", "Copy"]);
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "copy uno's AWS account",
      "copy Your external ID",
    ]);

    account!.click();
    externalId!.click();
    await settle();
    expect(copied).toEqual(["111122223333", TRUST.externalId]);
    expect(buttons().map((b) => b.textContent)).toEqual(["Copied", "Copied"]);

    vi.advanceTimersByTime(1500);
    expect(buttons().map((b) => b.textContent)).toEqual(["Copy", "Copy"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a copy the browser refuses leaves the button as it was", async () => {
  refuse = true;
  block.show(TRUST);
  buttons()[0]!.click();
  await settle();
  expect(copied).toEqual([]);
  expect(buttons()[0]!.textContent).toBe("Copy");
});

test("relabel rewrites the fixed text in the new language, and the values stay", () => {
  block.show(TRUST);
  void setLocale("pt-BR", { reload: false });
  block.relabel();
  expect(text(".row:nth-of-type(1) span")).toBe("Conta AWS do uno");
  expect(buttons()[0]!.textContent).toBe("Copiar");
  expect(buttons()[1]!.getAttribute("aria-label")).toBe("copiar Seu ID externo");
  expect(text(".row:nth-of-type(2) .copyable")).toBe(TRUST.externalId);
});
