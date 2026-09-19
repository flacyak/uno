// The main process: one window, the menu, the file dialogs, and the engines
// that read files for the renderer.
//
// It holds no sheet, no document and no file's contents. An engine reads a file
// in a utility process and sends rows straight to the renderer, and everything
// else about the data lives in the renderer, because `@uno/grid` is pure and
// runs there unchanged -- which is what makes the web build the same renderer
// with a different `host`.

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
import type { UtilityProcess } from "electron";
import { join } from "node:path";

import { sourceAt, writeAtomic } from "./files.ts";

/**
 * This file is bundled to CommonJS, because a preload script has to be and the
 * two are built the same way. So `__dirname` is the one that exists here --
 * `import.meta.url` compiles to an empty object and every path off it resolves
 * to the wrong place, silently.
 */
declare const __dirname: string;
const here = __dirname;

/**
 * The size the Go build asks its window to be, kept the same so the design
 * documents in resource/ still describe what a person sees.
 */
const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 720;

/**
 * In development the renderer is served by Vite; in a packaged app it is a file
 * beside this one.
 *
 * The URL arrives in the environment at run time and is never compiled in. A
 * localhost address baked into a bundle is one that ships, and then the
 * installed app tries to reach a dev server that is not there.
 */
const devServer = process.env["UNO_RENDERER_URL"];

/**
 * The arguments that look like files to open.
 *
 * Electron's own switches are dropped rather than filtered by name: anything
 * beginning with a dash is not a path, and in development argv also carries the
 * "." that told Electron which app to run.
 */
function filesFromArgv(): string[] {
  const args = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
  return args.filter((a) => !a.startsWith("-") && a !== ".");
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: "#EFF2F3",
    title: "uno",
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      // The renderer is a web page and is treated as one: no Node, no remote
      // module, and nothing from the main process except what preload hands it.
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only needs contextBridge and ipcRenderer, both of which a
      // sandboxed preload has. Nothing here reads a file or spawns anything, so
      // there is no reason to hand the renderer's process a bigger one.
      sandbox: true,
    },
  });

  // Shown once it has something to draw, so the window does not flash empty.
  win.once("ready-to-show", () => win.show());

  if (devServer !== undefined && devServer !== "") {
    void win.loadURL(devServer);
  } else {
    void win.loadFile(join(here, "../renderer/index.html"));
  }

  // A file named on the command line -- `uno sales.csv`, or a double-click in
  // the file manager -- is handed to the renderer once it can receive it.
  // Several are one workspace, `uno ads.csv shop.csv bank.csv`, so they go
  // together and the renderer adds them in order.
  const argued = filesFromArgv();
  if (argued.length > 0) {
    win.webContents.once("did-finish-load", () => {
      if (argued.length === 1) win.webContents.send("menu:open-path", argued[0]);
      else win.webContents.send("menu:add-paths", argued);
    });
  }

  // A link in the app opens in the person's browser, not inside the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

/**
 * The menu exists for its accelerators as much as for its items: Ctrl+O and
 * Ctrl+S are how anyone actually opens and saves, and an accelerator has to
 * live on a menu item for Electron to bind it.
 *
 * Each one asks the renderer to act rather than acting itself. The renderer is
 * the only thing that knows whether there is an open workspace, whether it has
 * unsaved edits, and which cell is selected.
 */
function buildMenu(win: BrowserWindow): void {
  const send = (channel: string) => () => win.webContents.send(channel);
  const pick = (name: string) => () => win.webContents.send("menu:input", name);

  const menu = Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: send("menu:open") },
        // Another export into the workspace that is open, beside the files already in it.
        { label: "Add Source…", accelerator: "CmdOrCtrl+Shift+O", click: send("menu:add") },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: send("menu:save") },
        { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: send("menu:save-as") },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        // How the grid reads keys. The renderer keeps the choice, and checks the
        // item it read at start through input:chosen.
        {
          label: "Input",
          submenu: [
            { id: "input:default", label: "Default", type: "radio", click: pick("default") },
            { id: "input:vim-style", label: "Vim-style", type: "radio", click: pick("vim-style") },
          ],
        },
      ],
    },
    {
      label: "View",
      submenu: [
        // The renderer binds the key itself, so the accelerator is shown here
        // and not registered. Registering it too would toggle twice.
        {
          label: "View / Transform",
          accelerator: "CmdOrCtrl+E",
          registerAccelerator: false,
          click: send("menu:mode"),
        },
        { type: "separator" },
        // No accelerator. The reload role binds Ctrl+R, which is redo whichever
        // way the grid reads keys, and a reload loses the open workspace.
        { label: "Reload", click: () => win.webContents.reload() },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  ipcMain.on("input:chosen", (event, name: string) => {
    if (event.sender !== win.webContents) return;
    const item = menu.getMenuItemById(`input:${name}`);
    if (item !== null) item.checked = true;
  });
}

/**
 * The file operations, as IPC handlers.
 *
 * They are deliberately dumb: choose a file, start an engine, write bytes. No
 * parsing, no format knowledge, no idea what a .uno is. That is what keeps the
 * whole of uno's behaviour in one place the tests can reach without a window.
 */
function registerFileHandlers(win: BrowserWindow): void {
  /**
   * Engines, one per open workspace, each a utility process of its own.
   *
   * Not the renderer, because reading a file by path takes Node and the renderer
   * has none. Not this process, because an index scan over 30 GB would stall
   * every menu and dialog while it ran. Rows go from the engine to the renderer
   * over the port and never pass through here.
   *
   * An engine exits by itself when its port closes, which is what closing a
   * workspace does. These handles are kept so the ones still running when the
   * window goes are stopped by handle, never by name.
   */
  const engines = new Set<UtilityProcess>();

  ipcMain.on("engine:connect", (event, id: number) => {
    const child = utilityProcess.fork(join(here, "../engine/index.cjs"), [], {
      serviceName: "uno engine",
    });
    engines.add(child);
    child.once("exit", () => engines.delete(child));

    const { port1, port2 } = new MessageChannelMain();
    child.postMessage(null, [port1]);
    event.sender.postMessage("engine:port", id, [port2]);
  });

  win.on("closed", () => {
    for (const child of engines) child.kill();
  });

  ipcMain.handle("file:open", async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: "Open",
      properties: ["openFile"],
      filters: [
        { name: "Spreadsheets and workspaces", extensions: ["uno", "csv", "tsv"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    // Cancelling is not a failure and must not be reported as one.
    if (picked.canceled || picked.filePaths[0] === undefined) return undefined;
    return sourceAt(picked.filePaths[0]);
  });

  // Several at once, because a week's liquidity is built from several exports.
  ipcMain.handle("file:add", async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: "Add Source",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Spreadsheets", extensions: ["csv", "tsv"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (picked.canceled) return [];
    return picked.filePaths.map(sourceAt);
  });

  // Where to save, and nothing else. The renderer writes through file:save
  // afterwards, because a workspace points at sources relative to its own
  // folder and cannot be laid out until that folder is known.
  ipcMain.handle("file:pick-save", async (_event, suggestedName: string) => {
    const picked = await dialog.showSaveDialog(win, {
      title: "Save As",
      defaultPath: suggestedName,
      filters: [{ name: "uno workspace", extensions: ["uno"] }],
    });
    if (picked.canceled || picked.filePath === undefined) return undefined;
    return picked.filePath;
  });

  ipcMain.handle("file:save", async (_event, path: string, bytes: Uint8Array) => {
    await writeAtomic(path, bytes);
  });
}

// One window. Its tabs are the sources of the workspace open in it, and they are
// a renderer concern: the engine behind them is one process for all of them.
void app.whenReady().then(async () => {
  const win = createWindow();
  buildMenu(win);
  registerFileHandlers(win);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // The two branches in this file that know what a test is. See src/main/smoke/index.ts
  // for why they have to live inside the app rather than outside it; preview.ts
  // is the same argument for the same reason, one story instead of assertions.
  // Either one drives the window, so the person at the desktop is shut out of it
  // before it is shown. See src/main/driven.ts.
  const smoke = process.env["UNO_SMOKE"] !== undefined;
  if (smoke || process.env["UNO_PREVIEW"] !== undefined) {
    const { drive } = await import("./driven.ts");
    const driven = drive(win);
    const run = smoke
      ? (await import("./smoke/index.ts")).runSmoke
      : (await import("./preview.ts")).runPreview;
    const quit = (code: number): void => app.exit(code);

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
