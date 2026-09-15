// A window a script drives, and the person at the desktop cannot.
//
// The smoke test and the preview run on a desktop someone is using as often as
// they run on CI, and that person goes on working while they do. A key they type,
// a click or a scroll over the window, and a switch to another window all reach
// the page the way the script's own input does. Any of them can move the
// selection between two checks. A switch away blurs an open cell editor, and the
// editor commits on blur. Ctrl+O opens a file dialog the run then waits on until
// it times out. The check that fails says nothing about who was at the keyboard.
//
// So the window ignores the window system. DevTools has a switch for each half:
// one drops input on its way to the page, and one tells the page it has the focus
// whatever the window manager says. Both hold across a reload, and both work the
// same under Wayland and X11. setEnabled(false) was tried first and does nothing
// on Wayland.
//
// What still reaches the page is what main sends it: scripts, the menu's
// messages, and sendInputEvent inside `through`. The menu bar is drawn by the
// window rather than the page, so a click on it still lands.

import type { BrowserWindow } from "electron";

/**
 * drive shuts the person at the desktop out of the window. It can be called
 * before the page loads, and holds for every page the window shows.
 */
export async function drive(win: BrowserWindow): Promise<void> {
  const devtools = win.webContents.debugger;
  devtools.attach("1.3");
  await devtools.sendCommand("Input.setIgnoreInputEvents", { ignore: true });
  await devtools.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
}

/**
 * through lets what `send` sends with sendInputEvent reach the page, the way a
 * person's input would in a window nobody drives.
 *
 * DevTools applies the switch as it is sent, so the ignore is lifted and put back
 * in one synchronous stretch, and nothing the window system delivers can land in
 * between. That is also why `send` has to send synchronously.
 *
 * A wheel event gets through, but the scroll it causes does not. Chromium sends
 * the scroll after the page has answered the wheel, and by then the ignore is
 * back. Scroll with a script instead, as preview.ts does.
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
