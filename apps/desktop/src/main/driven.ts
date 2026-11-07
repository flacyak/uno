/**
 * @fileoverview Makes a window ignore the person at the desktop so a script can
 * drive it.
 *
 * Two DevTools switches are used: one drops input events before they reach
 * the page, and one tells the page it has the focus whatever the window
 * manager says. Both hold across a reload, and both work under Wayland and
 * X11.
 *
 * What still reaches the page is what main sends it: scripts, the menu's
 * messages, sendInputEvent inside `through`, and DevTools input inside
 * `throughAsync`. Menu accelerators are handled by the main process, so those
 * still land, and `pick` clicks an application menu item by the keys it shows.
 */

import { Menu } from "electron";
import type { BrowserWindow } from "electron";

/**
 * drive makes the window ignore all input from the window system and report
 * itself as focused. It can be called before the page loads, and holds for
 * every page the window shows.
 */
export async function drive(win: BrowserWindow): Promise<void> {
  const devtools = win.webContents.debugger;
  devtools.attach("1.3");
  await devtools.sendCommand("Input.setIgnoreInputEvents", { ignore: true });
  await devtools.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
}

/**
 * through lifts the input ignore, runs `send`, and puts the ignore back.
 * `send` must call sendInputEvent synchronously: the ignore is lifted and
 * restored in one synchronous stretch, so the only events that land are the
 * ones `send` sends.
 *
 * A wheel event gets through, and the scroll it causes is dropped: Chromium
 * sends the scroll after the page has answered the wheel, and by then the
 * ignore is back. Scroll with a script, as preview.ts does, or turn the wheel
 * inside `throughAsync`, as the smoke does.
 */
export function through(win: BrowserWindow, send: () => void): void {
  const devtools = win.webContents.debugger;
  void devtools.sendCommand("Input.setIgnoreInputEvents", { ignore: false });
  try {
    send();
  } finally {
    void devtools.sendCommand("Input.setIgnoreInputEvents", { ignore: true });
  }
}

/**
 * throughAsync is `through` for sends that have to be awaited. DevTools delivers
 * a touch after it answers, later than `through` puts the ignore back, so the
 * ignore stays lifted until `send` settles. A person's input can land in that
 * time, so keep `send` to a few round trips.
 */
export async function throughAsync(win: BrowserWindow, send: () => Promise<void>): Promise<void> {
  const devtools = win.webContents.debugger;
  await devtools.sendCommand("Input.setIgnoreInputEvents", { ignore: false });
  try {
    await send();
  } finally {
    await devtools.sendCommand("Input.setIgnoreInputEvents", { ignore: true });
  }
}

/**
 * pick clicks the application menu's item that shows `keys`, as a person picks
 * it. The menu has to leave the keys to the page, which reads them itself.
 */
export function pick(keys: string): void {
  const items = Menu.getApplicationMenu()?.items.flatMap((menu) => menu.submenu?.items ?? []);
  const item = items?.find((at) => at.accelerator === keys);
  if (item === undefined || item.registerAccelerator) {
    throw new Error(`no menu item leaves ${keys} to the page`);
  }
  item.click();
}
