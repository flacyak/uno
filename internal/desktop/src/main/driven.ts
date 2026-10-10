// Makes a window ignore the person at the desktop so a script can drive it.
//
// Two DevTools switches are used: one drops input events before they reach
// the page, and one tells the page it has the focus whatever the window
// manager says. Both hold across a reload, and both work under Wayland and
// X11.
//
// What still reaches the page is what main sends it: scripts, the menu's
// messages, and sendInputEvent inside `through`. Menu accelerators are
// handled by the main process, so those still land.

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
 * ignore is back. Scroll with a script, as preview.ts does.
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
