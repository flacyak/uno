// The main process: one window, the application menu, the file dialogs, and
// the engine processes that read files for the renderer.
//
// The data lives elsewhere. An engine reads a file in a utility process and
// sends rows straight to the renderer over a message port. Everything else
// about the data lives in the renderer.

import {
  BrowserWindow,
  Menu,
  MessageChannelMain,
  app,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
} from "electron";
import type { MenuItemConstructorOptions, UtilityProcess, WebContents } from "electron";
import { join, resolve } from "node:path";

import { m } from "../paraglide/messages.js";
import { isLocale, setLocale } from "../paraglide/runtime.js";
import { sourceAt, unoPath, writeAtomic, writeConnection } from "./files.ts";

/**
 * This file is bundled to CommonJS, so `__dirname` is defined. Paths are
 * resolved from it.
 */
declare const __dirname: string;
const here = __dirname;

/** The window size. The design documents in resource/ are drawn at it. */
const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 720;

/**
 * The Vite dev server URL, read from the environment at run time. When it is
 * unset the renderer is loaded from a file beside this one.
 */
const devServer = process.env["UNO_RENDERER_URL"];

/**
 * The current window, or undefined when there is none.
 *
 * On macOS the app outlives its window and `activate` creates a new one. The
 * menu and IPC handlers are registered once and reach the window through this
 * variable, so they always address the window that exists now.
 */
let current: BrowserWindow | undefined;

/**
 * The running engines, one utility process per open workspace.
 *
 * An engine exits by itself when its port closes, which is what closing a
 * workspace does. The handles are kept so engines still running when the
 * window closes can be killed.
 */
const engines = new Set<UtilityProcess>();

/** The window an IPC event came from, or undefined. */
function windowOf(event: { sender: WebContents }): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

/** The window a dialog opens over: the one that sent the event. Throws if none. */
function over(event: { sender: WebContents }): BrowserWindow {
  const win = windowOf(event);
  if (win === undefined) throw new Error("a dialog was asked by a page in no window");
  return win;
}

/**
 * The file paths on the command line, made absolute.
 *
 * Arguments starting with a dash are Electron switches and are dropped. In
 * development argv also carries the "." that told Electron which app to run.
 * Paths are resolved against the working directory here, because a workspace
 * stores absolute paths to its sources.
 */
function filesFromArgv(): string[] {
  const args = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
  return args.filter((a) => !a.startsWith("-") && a !== ".").map((a) => resolve(a));
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 400,
    show: false,
    // Frameless. The page draws its own close button and provides its own
    // drag regions.
    frame: false,
    backgroundColor: "#EFF2F3",
    title: "uno",
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      // The renderer gets only what preload exposes.
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge and ipcRenderer, which a sandboxed
      // preload has.
      sandbox: true,
    },
  });

  current = win;
  win.on("closed", () => {
    if (current === win) current = undefined;
    for (const child of engines) child.kill();
  });
  // The menu exists for its accelerators. Its bar stays hidden. See menuFor.
  win.setMenuBarVisibility(false);

  // Show the window once it has rendered, so its first frame has content.
  win.once("ready-to-show", () => win.show());

  if (devServer !== undefined && devServer !== "") {
    void win.loadURL(devServer);
  } else {
    void win.loadFile(join(here, "../renderer/index.html"));
  }

  // Files named on the command line are sent to the renderer once the page
  // has loaded. One file opens on its own; several are added together as one
  // workspace, in order.
  const argued = filesFromArgv();
  if (argued.length > 0) {
    win.webContents.once("did-finish-load", () => {
      if (argued.length === 1) win.webContents.send("menu:open-path", argued[0]);
      else win.webContents.send("menu:add-paths", argued);
    });
  }

  // Links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

/**
 * menuFor builds the application menu. It exists for its accelerators
 * (Ctrl+O, Ctrl+S and so on); the menu bar is hidden, except on macOS where
 * the system shows it at the top of the screen.
 *
 * Each item sends a message to the renderer, which acts on it. The renderer
 * knows whether a workspace is open, whether it has unsaved edits, and which
 * cell is selected.
 *
 * Every item is labelled from the messages, including items with a role, so
 * the menu is in one language.
 *
 * `input` is the current key mode, used to check the matching radio item.
 */
function menuFor(input: string): Menu {
  const send = (channel: string) => () => current?.webContents.send(channel);
  const pick = (name: string) => () => current?.webContents.send("menu:input", name);
  // The last File item: Close Window on macOS, Quit or Exit elsewhere.
  const leave: MenuItemConstructorOptions =
    process.platform === "darwin"
      ? { role: "close", label: m.native_close_window() }
      : { role: "quit", label: process.platform === "win32" ? m.native_exit() : m.native_quit() };

  return Menu.buildFromTemplate([
    {
      label: m.native_file(),
      submenu: [
        { label: m.native_open(), accelerator: "CmdOrCtrl+O", click: send("menu:open") },
        // Adds another export to the open workspace.
        {
          label: m.native_add_source(),
          accelerator: "CmdOrCtrl+Shift+O",
          click: send("menu:add"),
        },
        { type: "separator" },
        { label: m.native_save(), accelerator: "CmdOrCtrl+S", click: send("menu:save") },
        {
          label: m.native_save_as(),
          accelerator: "CmdOrCtrl+Shift+S",
          click: send("menu:save-as"),
        },
        { type: "separator" },
        leave,
      ],
    },
    {
      label: m.native_edit(),
      submenu: [
        { role: "undo", label: m.native_undo() },
        { role: "redo", label: m.native_redo() },
        { type: "separator" },
        { role: "cut", label: m.native_cut() },
        { role: "copy", label: m.native_copy() },
        { role: "paste", label: m.native_paste() },
        { type: "separator" },
        // The key mode. The renderer stores the choice and reports it through
        // input:chosen, which checks the matching item.
        {
          label: m.native_input(),
          submenu: [
            {
              id: "input:default",
              label: m.input_default(),
              type: "radio",
              checked: input === "default",
              click: pick("default"),
            },
            {
              id: "input:vim-style",
              label: m.input_vim_style(),
              type: "radio",
              checked: input === "vim-style",
              click: pick("vim-style"),
            },
          ],
        },
      ],
    },
    {
      label: m.native_view(),
      submenu: [
        // The renderer binds this key itself. The accelerator is shown as a
        // label only, so the key is handled once.
        {
          label: m.native_view_transform(),
          accelerator: "CmdOrCtrl+E",
          registerAccelerator: false,
          click: send("menu:mode"),
        },
        // Same: the renderer binds this key itself.
        {
          label: m.sources_title(),
          accelerator: "CmdOrCtrl+Shift+B",
          registerAccelerator: false,
          click: send("menu:sources"),
        },
        { type: "separator" },
        // A plain item, reached by click only. The reload role would bind
        // Ctrl+R, which is redo in the grid, and a reload loses the open
        // workspace.
        { label: m.native_reload(), click: () => current?.webContents.reload() },
        { role: "toggleDevTools", label: m.native_toggle_devtools() },
        { type: "separator" },
        { role: "resetZoom", label: m.native_actual_size() },
        { role: "zoomIn", label: m.native_zoom_in() },
        { role: "zoomOut", label: m.native_zoom_out() },
        { type: "separator" },
        { role: "togglefullscreen", label: m.native_toggle_full_screen() },
      ],
    },
  ]);
}

/**
 * buildMenu sets the application menu, and rebuilds it when the renderer
 * reports a new language or key mode. Menu labels are fixed at build time.
 *
 * Messages are only accepted from the current window.
 */
function buildMenu(): void {
  /** The key mode the renderer last reported, for the radio item to check. */
  let input = "";
  const set = (): void => Menu.setApplicationMenu(menuFor(input));
  set();

  ipcMain.on("input:chosen", (event, name: string) => {
    if (windowOf(event) !== current) return;
    input = name;
    set();
  });

  // The renderer stores the chosen language and reports it here, so the menu
  // and dialogs can use it.
  ipcMain.on("language:chosen", (event, locale: string) => {
    if (windowOf(event) !== current || !isLocale(locale)) return;
    void setLocale(locale, { reload: false });
    set();
  });

  // The page's close button. The renderer has already confirmed any unsaved
  // edits before sending this.
  ipcMain.on("window:close", (event) => {
    windowOf(event)?.close();
  });
}

/**
 * registerFileHandlers registers the file IPC handlers: choose a file, start
 * an engine, write bytes.
 */
function registerFileHandlers(): void {
  /**
   * The folder of .unof connection files under the app's user data. Read
   * each time it is needed, so a run with its own --user-data-dir keeps its
   * connections there.
   */
  const connectionsDir = (): string => join(app.getPath("userData"), "connections");

  ipcMain.on("engine:connect", (event, id: number) => {
    // The connections folder is passed as an argument, since only this process
    // knows the user data path.
    const child = utilityProcess.fork(
      join(here, "../engine/index.cjs"),
      [`--connections=${connectionsDir()}`, `--version=${app.getVersion()}`],
      { serviceName: "uno engine" },
    );
    engines.add(child);
    child.once("exit", () => engines.delete(child));

    const { port1, port2 } = new MessageChannelMain();
    child.postMessage(null, [port1]);
    event.sender.postMessage("engine:port", id, [port2]);
  });

  ipcMain.handle("file:open", async (event) => {
    const picked = await dialog.showOpenDialog(over(event), {
      title: m.dialog_open(),
      properties: ["openFile"],
      filters: [
        { name: m.filter_spreadsheets_and_workspaces(), extensions: ["uno", "csv", "tsv"] },
        { name: m.filter_all_files(), extensions: ["*"] },
      ],
    });
    // Cancelling returns undefined.
    if (picked.canceled || picked.filePaths[0] === undefined) return undefined;
    return sourceAt(picked.filePaths[0]);
  });

  // Picks one or more files to add to the open workspace.
  ipcMain.handle("file:add", async (event) => {
    const picked = await dialog.showOpenDialog(over(event), {
      title: m.dialog_add_source(),
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: m.filter_spreadsheets(), extensions: ["csv", "tsv"] },
        { name: m.filter_all_files(), extensions: ["*"] },
      ],
    });
    if (picked.canceled) return [];
    return picked.filePaths.map(sourceAt);
  });

  // Picks the save path only. The renderer then writes through file:save,
  // because a workspace's source paths are relative to its own folder and
  // are laid out once that folder is known.
  ipcMain.handle("file:pick-save", async (event, suggestedName: string) => {
    const picked = await dialog.showSaveDialog(over(event), {
      title: m.dialog_save_as(),
      defaultPath: suggestedName,
      filters: [{ name: m.filter_workspace(), extensions: ["uno"] }],
    });
    if (picked.canceled || picked.filePath === undefined) return undefined;
    return unoPath(picked.filePath);
  });

  ipcMain.handle("file:save", async (_event, path: string, bytes: Uint8Array) => {
    await writeAtomic(path, bytes);
  });

  // Saves a connection from the panel. The renderer tells the engines to
  // re-read the folder afterwards.
  ipcMain.handle("connections:save", async (_event, id: string, text: string) => {
    await writeConnection(connectionsDir(), id, text);
  });
}

void app.whenReady().then(async () => {
  const win = createWindow();
  buildMenu();
  registerFileHandlers();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // The smoke test (UNO_SMOKE) and the preview (UNO_PREVIEW) run inside the
  // app. Both drive the window, so input from the desktop is shut out before
  // the window is shown. See src/main/driven.ts.
  const smoke = process.env["UNO_SMOKE"] !== undefined;
  if (smoke || process.env["UNO_PREVIEW"] !== undefined) {
    const { drive } = await import("./driven.ts");
    const driven = drive(win);
    // Pin the window to one size so a tiling window manager floats it instead
    // of fitting it to a tile. The preview is filmed at this size and the
    // smoke run measures layout at it.
    win.setMinimumSize(WINDOW_WIDTH, WINDOW_HEIGHT);
    win.setMaximumSize(WINDOW_WIDTH, WINDOW_HEIGHT);
    const run = smoke
      ? (await import("./smoke/index.ts")).runSmoke
      : (await import("./preview.ts")).runPreview;
    const quit = (code: number): void => app.exit(code);

    // A driven window ignores all input, so the save dialog is replaced with
    // a path from the environment. See smoke/save.ts.
    const { savePathFor } = await import("./smoke/save.ts");
    ipcMain.removeHandler("file:pick-save");
    ipcMain.handle("file:pick-save", (_event, suggestedName: string) =>
      savePathFor(process.env, suggestedName),
    );

    // The same for the open dialog. See smoke/pick.ts.
    const { openPathFor } = await import("./smoke/pick.ts");
    ipcMain.removeHandler("file:open");
    ipcMain.handle("file:open", () => {
      const path = openPathFor(process.env);
      return path === undefined ? undefined : sourceAt(path);
    });

    win.webContents.once("did-finish-load", () => {
      void driven.then(
        () => run(win, quit),
        (err: unknown) => {
          console.error(`driven: ${(err as Error).message}`);
          quit(1);
        },
      );
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
