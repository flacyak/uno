# @uno/desktop

uno's desktop client: an Electron shell over [`@uno/grid`](../grid).

It holds no spreadsheet logic. Opening a file is `@uno/grid/ingest`, changing a
cell is `sheet.set`, saving is `writeDocument` — this package is the window, the
menu, the grid that draws a sheet, and the four file operations a web page
cannot do for itself.

## The shape of it

```
src/
  main/       the Electron main process: one window, the menu, four IPC handlers
  preload/    the only bridge to the renderer, four functions wide
  renderer/   the app: tab strip, virtualized grid, status bar
  shared/     the Host interface both Electron and a web build implement
```

The seam is `src/shared/host.ts`. Everything above it is a plain web page
running the pure core, which is what makes `internal/web` the same renderer with
a different four-method `host` behind it.

## Running it

```bash
vp install               # from internal/, the workspace root
vp run dev               # vite dev server + electron, reloading
vp run build             # out/main, out/preload, out/renderer
vp run smoke             # build, then drive the real app and assert
vp check                 # format, lint, type check
```

`vp run dev` prints the Electron pid. Stop it by that pid; there is usually
something else on the machine called electron.

The dev server's URL reaches Electron through `UNO_RENDERER_URL` at run time and
is never compiled in — a localhost address baked into a bundle is one that ships,
and the installed app then tries to reach a dev server that is not running.

## The grid

A 4,812-row export is about forty elements in the DOM. The scroller's inner
height is the whole sheet; the table inside holds only the rows that fit, moved
into place with one transform per frame. Every cell reads `sheet.display(row,
col)`, which is a cache read — recalculation happens when an edit lands, never
when a cell is drawn.

## Testing

`vp run smoke` builds the app, starts it on the real 4,812-row fixture, and asks
the live DOM what it shows: that the file opened, that the delimiter was sniffed,
that `units` is badged as numeric data in a costume, that scrolling to row 4,812
still leaves under 120 rows in the DOM, that typing into a cell records an edit.
It writes a screenshot to `out/smoke/window.png`.

It needs a display. On a headless machine, run it under Xvfb.

The assertions live in `src/main/smoke.ts`, which is test code inside the app —
a smell worth naming. It is there because a virtualiser, a preload bridge and an
IPC round trip cannot be checked anywhere but inside a real Electron, and the
alternative was a browser-automation dependency larger than the app it tests. It
is reached only when `UNO_SMOKE` is set, and nothing in the app calls it.
