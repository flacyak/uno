/**
 * @fileoverview The block a role connection shows: uno's account, the
 * external ID and the two policy documents to hand to whoever makes the role,
 * each with a Copy button. Tested on its own, with no form around it, the way
 * the web page and the desktop both mount it.
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, expect, test, vi } from "vite-plus/test";

import { permissionPolicy, trustPolicy } from "@library";
import { setLocale } from "@paraglide/runtime";
import { RoleBlock } from "@renderer/shell/role";
import { settle } from "./settle.ts";

const TRUST = {
  principal: "arn:aws:iam::111122223333:role/uno-engine",
  externalId: "uno-t-7f3c9a21e04b7f3c9a21e04b7f3c9a21",
};
const PLACE = { bucket: "acme-finance-lake", prefix: "exports/" };

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

test("hidden until shown, then the account, the external ID, and the two policies", () => {
  expect(block.el.hidden).toBe(true);
  block.show(TRUST, PLACE);
  expect(block.el.hidden).toBe(false);
  expect(text(".row:nth-of-type(1) span")).toBe("uno's AWS account");
  expect(text(".row:nth-of-type(1) .copyable")).toBe("111122223333");
  expect(text(".row:nth-of-type(2) span")).toBe("Your external ID");
  expect(text(".row:nth-of-type(2) .copyable")).toBe(TRUST.externalId);
  expect(text(".row:nth-of-type(3) span")).toBe("Trust policy");
  expect(text(".row:nth-of-type(3) .document")).toBe(trustPolicy(TRUST));
  expect(text(".row:nth-of-type(4) span")).toBe("Permission policy");
  expect(text(".row:nth-of-type(4) .document")).toBe(permissionPolicy(PLACE));
  expect(text(".how")).toBe(
    "Give these to whoever manages the bucket. The role they make has the trust policy and the permission policy, which follow the bucket and prefix as they are typed. Then paste the role's ARN.",
  );
  block.hide();
  expect(block.el.hidden).toBe(true);
});

test("the permission policy follows the bucket and prefix, and waits for a bucket", () => {
  block.show(TRUST, { bucket: "", prefix: "" });
  const row = block.el.querySelector<HTMLElement>(".row:nth-of-type(4)")!;
  expect(row.hidden).toBe(true);
  block.show(TRUST, { bucket: "open-data", prefix: "" });
  expect(row.hidden).toBe(false);
  expect(text(".row:nth-of-type(4) .document")).toContain('"Resource": "arn:aws:s3:::open-data/*"');
  block.show(TRUST, PLACE);
  expect(text(".row:nth-of-type(4) .document")).toContain('"exports/*"');
});

test("a principal that is not an ARN is shown whole", () => {
  block.show({ ...TRUST, principal: "uno-engine" }, PLACE);
  expect(text(".row:nth-of-type(1) .copyable")).toBe("uno-engine");
});

test("each Copy button copies the value beside it and says so for a moment", async () => {
  vi.useFakeTimers();
  try {
    block.show(TRUST, PLACE);
    const [account, externalId, trust, permission] = buttons();
    expect(buttons().map((b) => b.textContent)).toEqual(["Copy", "Copy", "Copy", "Copy"]);
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "copy uno's AWS account",
      "copy Your external ID",
      "copy Trust policy",
      "copy Permission policy",
    ]);

    account!.click();
    externalId!.click();
    trust!.click();
    permission!.click();
    await settle();
    expect(copied).toEqual([
      "111122223333",
      TRUST.externalId,
      trustPolicy(TRUST),
      permissionPolicy(PLACE),
    ]);
    expect(buttons().map((b) => b.textContent)).toEqual(["Copied", "Copied", "Copied", "Copied"]);

    vi.advanceTimersByTime(1500);
    expect(buttons().map((b) => b.textContent)).toEqual(["Copy", "Copy", "Copy", "Copy"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a copy the browser refuses leaves the button as it was", async () => {
  refuse = true;
  block.show(TRUST, PLACE);
  buttons()[0]!.click();
  await settle();
  expect(copied).toEqual([]);
  expect(buttons()[0]!.textContent).toBe("Copy");
});

test("relabel rewrites the fixed text in the new language, and the values stay", () => {
  block.show(TRUST, PLACE);
  void setLocale("pt-BR", { reload: false });
  block.relabel();
  expect(text(".row:nth-of-type(1) span")).toBe("Conta AWS do uno");
  expect(buttons()[0]!.textContent).toBe("Copiar");
  expect(buttons()[1]!.getAttribute("aria-label")).toBe("copiar Seu ID externo");
  expect(text(".row:nth-of-type(3) span")).toBe("Política de confiança");
  expect(text(".row:nth-of-type(4) .document")).toBe(permissionPolicy(PLACE));
  expect(text(".row:nth-of-type(2) .copyable")).toBe(TRUST.externalId);
});
