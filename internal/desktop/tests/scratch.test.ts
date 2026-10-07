// @vitest-environment happy-dom
import { beforeAll, expect, test } from "vite-plus/test";
import type { Shell } from "../src/renderer/shell/shell.ts";
import { bootShell } from "./smoke/dom-harness.ts";
import { domPage } from "./smoke/dom-page.ts";

const page = domPage();
let shell: Shell;
let keydowns = 0;
const hidden = (): boolean => document.querySelector("#app")!.classList.contains("no-sidebar");

beforeAll(async () => {
  const add = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === "keydown") keydowns++;
    return (add as (...a: unknown[]) => void)(type, ...rest);
  }) as typeof window.addEventListener;
  shell = await bootShell();
}, 20_000);

test("toggle before any switch", async () => {
  const was = hidden();
  await page.press("b", { ctrlKey: true });
  expect(hidden(), "toggled once before switch").toBe(!was);
});

test("toggle after one switch", async () => {
  const before = keydowns;
  shell.language.choose("es");
  await page.settle(2);
  expect(keydowns, "keydown listeners added by a switch").toBe(before);
  const now = hidden();
  await page.press("b", { ctrlKey: true });
  expect(hidden(), "toggled once after switch").toBe(!now);
});

test("toggle after three quick switches", async () => {
  shell.language.choose("en-US");
  shell.language.choose("es");
  shell.language.choose("pt-BR");
  await page.settle(2);
  const now = hidden();
  await page.press("b", { ctrlKey: true });
  expect(hidden(), "toggled once after three").toBe(!now);
});

test("slash opens the prompt", async () => {
  await page.press("Escape");
  await page.press("/");
  await page.settle(1);
  expect(document.querySelector("#status-cmd")!.hasAttribute("hidden"), "cmd hidden after /").toBe(false);
});
