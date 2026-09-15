# @uno/desktop

uno's desktop client: an Electron shell over [`@uno/grid`](../grid).

It holds no spreadsheet logic. Opening a file is `@uno/grid/engine`, changing a
cell is `sheet.set`, saving is `writeDocument`. This package is the window, the
menu, the grid that draws rows, and the file operations a web page cannot do
for itself.

## The shape of it

```
src/
  main/       the Electron main process: one window, the menu, dialogs, engines
  preload/    the only bridge to the renderer
  engine/     the utility process that owns one open file
  renderer/   the app: tab strip, virtualized grid, status bar
  shared/     the Host interface both Electron and a web build implement
```

The seam is `src/shared/host.ts`. Everything above it is a plain web page
running the pure core, which is what makes `internal/web` the same renderer with
a different `host` behind it.

## Opening a file

A file opens in view. Main starts a utility process for it and hands the
renderer one end of a MessagePort. The engine reads the file by path, a chunk at
a time, and sends rows straight to the renderer, so neither main nor the
renderer ever holds the file. The status bar shows `≈` rows and how far the
index has got until it reaches the end.

Ctrl+E switches to transform, which unlocks editing and turns the recogniser
on, and back again. It loads nothing. The engine keeps the edit log and applies it to each row as it
reads the row, so an edit reaches the screen as soon as the next band does,
anywhere in the file. After three fixes in one column, a banner offers the rest,
and its count grows while the engine surveys the file. Apply is one edit, and
Ctrl+Z takes it back.

Saving still embeds the source in the `.uno`, so a source over 256 MB is refused
by name until the format can point at the file instead. A `.uno` opens through
the engine too, with its log replayed.

Opening a file closes the one open now. Over unsaved edits, Ctrl+O says so
first, and a second Ctrl+O while that is still on screen opens anyway, as `:e!`
does.

## Keys

How the grid reads keys is an input strategy, picked from Edit → Input and kept
between launches. There are two, and Default is the one a new install gets.

**Default** is a spreadsheet's keys. The arrows, Tab, PgUp, PgDn, Home and End
move. Enter, F2 or a double click open the editor on the value, and typing over
a cell replaces it. In the editor Enter keeps the typing and Esc throws it away.
Ctrl+C copies what the cell stores, Ctrl+Z takes back the last edit and selects
the cell it changed, and Ctrl+R records it again, until the next edit.

**Vim-style** reads keys the way vim does. View is a normal mode that cannot
write, transform is one that can, and the cell editor is insert mode. `i` moves
one level in and Esc one level back out.

`i` in view switches to transform and stops there. In transform, `i`, `a`, `s`
and Enter open the editor with the caret at the start, at the end, on nothing
and on the whole value. `a` in view does both at once. Esc in the editor keeps
what was typed, as Enter does. Letters are commands, so typing over a cell
starts with `s`. `u` takes back the last edit, as Ctrl+Z does, and selects the
cell it changed. Ctrl+r records it again, until the next edit, and no longer
reloads the window.

Moving is the same in both modes and writes nothing: `h` `j` `k` `l`, `w` and
`b` through cells in reading order, `0` `^` `$` across the row, `gg` and `G` to
the first and last row, `H` `M` `L` to the top, middle and bottom row on screen,
Ctrl+d, u, f and b by half and whole pages. Each takes a count, which waits in
the status bar until the motion arrives, and `{n}G` goes to row n. `zt` `zz`
`zb` scroll the selected row to the top, middle or bottom and leave it selected.
`m{a-z}` marks a cell for as long as the workspace is open, `'{a-z}` goes back
to it, and `''` returns to where the last jump left from.

Changing is transform's. `x` clears a cell and `p` sets it to what `yy` copied.
`yy` works in view too, since copying changes nothing, and copies what the cell
stores to the system clipboard as well. Each change is one set in the log, so a
count before one is dropped: `3x` would record a set per cell.

`.` makes the last insert, `x` or `p` again on the selected cell. An insert
opened with `a` that only added to the end repeats as that text appended, one
opened with `i` that only added to the start repeats as a prepend, and anything
else repeats as the whole value. It is what makes three fixes cheap: on a column
where 12 should read 12.00, `a` `.00` Esc `j` `.` `j` `.` fixes three cells and
brings the recogniser's offer for the rest. `ga` is Apply on that banner, from
any cell, and `gx` is Not now.

`:` opens a command line in the status bar, in either mode. `:w` saves as Ctrl+S
does, `:sav` is Save As, `:e` opens a file but refuses over unsaved edits unless
it is `:e!`, and `:{n}` goes to row n. There is no `:q`; closing is the window's
job.

`]f` and `[f` go to the next and previous cell in the column that does not parse
as its badge says, which is the work uno is for: `]f` `.` `]f` `.` `]f` `.` `ga`.
The band holds a few screens of rows, so the engine reads the file for them and
they reach any row. While a file is still indexing they search what has been
indexed and say how much that was. `/` and `?` search down and up the column
for text a cell shows, the same way, and `n` and `N` search again in the same
direction or the other. While a file is still indexing, `G` stops at the last row the engine
can read and says how far it has got. The arrows, Tab, PgUp, PgDn, Home and End
work as before.

The keys are read by an input strategy in `src/renderer/input/`, and what they
mean is carried out through `src/renderer/keys.ts`. Neither touches the DOM, and
both are tested without a window. The whole plan is `resource/vim-motions.html`.

## Running it

```bash
vp install               # from internal/, the workspace root
vp run dev               # vite dev server + electron, reloading
vp run build             # out/main, out/preload, out/renderer
vp run smoke             # build, then drive the real app and assert
vp test                  # the keys, without a window
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
into place with one transform per frame. Every cell reads `display(row, col)`
from a sheet or a band, and both are array reads. Recalculation happens when an
edit lands, never when a cell is drawn.

Past 15 million pixels of rows, about 517,000, the scroller's height is capped
and the scrollbar maps onto the rows by proportion. The wheel and the keys still
move by rows, so a step is one row at row 50,000,000.

## Testing

`vp run smoke` builds the app, starts it on the real 4,812-row fixture, and asks
the live DOM what it shows: that the file opened, that the delimiter was sniffed,
that `units` is badged as numeric data in a costume, that scrolling to row 4,812
still leaves under 120 rows in the DOM, that a key that writes changes nothing
in view, that after Ctrl+E typing into a cell records an edit, that three fixes
bring the banner's offer, that Apply rewrites the column as one edit, that
Ctrl+Z takes it back, and that `i`, `a`, `s` and Esc move between view,
transform and insert with Esc keeping what was typed. It writes a screenshot to
`out/smoke/window.png`.

It needs a display. On a headless machine, run it under Xvfb. Started from a
tool that is itself an Electron app, unset `ELECTRON_RUN_AS_NODE` first, or
Electron starts as plain Node and main finds no `app`.

The assertions live in `src/main/smoke.ts`, which is test code inside the app —
a smell worth naming. It is there because a virtualiser, a preload bridge and an
IPC round trip cannot be checked anywhere but inside a real Electron, and the
alternative was a browser-automation dependency larger than the app it tests. It
is reached only when `UNO_SMOKE` is set, and nothing in the app calls it.
