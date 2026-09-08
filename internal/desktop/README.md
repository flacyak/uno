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
  engine/     the utility process that owns one open workspace
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

Saving writes down where each source is rather than copying it in, so a
workspace of a 30 GB ledger and four 2 GB exports is a few kilobytes and saves
instantly. A source under the workspace's own folder is pointed at relative to
it, so the folder can be copied somewhere else whole. The 256 MB ceiling is what
is left over: bytes with no file behind them, which the container has to carry
or lose, and on the desktop there are none. A `.uno` opens through the engine
too, with its log replayed.

What a `.uno` gives up for this is travelling on its own. Sending somebody the
file without the data it points at gets them the tabs, the edits and the log,
and no rows.

## Sources in S3

The `+` at the end of the tab strip offers a file or an S3 URL. An S3 URL is
`s3://bucket/key` or the https address the console shows, and the object opens
as a view the same way a file on disk does: a HEAD for its size, then ranged
GETs as the index and the grid need them. Nothing is downloaded whole, and a
workspace saves the `s3://` URL rather than a copy.

The engine process reads the object, using whatever AWS credentials this
machine already has: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus
`AWS_SESSION_TOKEN`), or the `AWS_PROFILE` (or `default`) keys in
`~/.aws/credentials`. The region comes from `AWS_REGION` or the profile's config,
and a bucket somewhere else says so once and is followed. uno stores no keys,
and none reach the renderer. SSO profiles are refused with the
`aws configure export-credentials` command that gets around them.
`AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL` points it at MinIO or another
S3-compatible store.

Every range is asked for as the version of the object that was opened, so an
export rewritten in the bucket mid-read is an error that says so, never half
of one file and half of another.

Every file uno reads goes through a `FileHandler` from `@uno/grid/store`:
sources, `.uno` files, formulas in the library, and the `~/.aws` config. There
are three handlers. `localFiles` (in `store/node`) reads paths on disk,
`s3Files` (in `store/s3`) reads objects in a bucket, and `blobFiles` reads
dropped bytes that have no path. Each one only reads the refs it recognises.
The desktop engine lists `localFiles` and `s3Files`, so a Blob that reaches it is
refused by name. A test in each package fails if anything outside a handler
starts reading files on its own.

## When a source's file moves

A source whose file is not where the workspace left it still opens: it keeps its
id, its edits and its place in the log, and the tab wears a `!` that says what
went wrong. Clicking the `!` asks where the file is now, and the edits replay
over it. A file that has changed size since the save gets the same mark and its
rows anyway, because only the person looking at them can say whether it is still
the right file.

A file that cannot take the log -- one a quarter the size, whose last rows the
log names -- is refused, and the source is left as it was. A wrong pick costs
nothing.

## A workspace of several sources

A workspace holds as many sources as the work needs, each in a tab of its own.
File → Add Source (Ctrl+Shift+O) adds one or more beside the file already open, and so does the `+` at the end of the tab strip.
Dropping files on the window adds them too, and `uno ads.csv shop.csv bank.csv` opens all three as one workspace.
A `.uno` is a workspace of its own, so it opens rather than being added.

One engine serves every source in the workspace, and the log is one list in the order the edits were made, with each line naming the source it changed.
Each tab edits, undoes and redoes its own source, and View / Transform switches all of them together.
A tab's dot says its source has edits, or was added, since the last save.
The × on a tab takes its source and its edits out of the workspace, and asks once more first when there are edits to lose.
The last source has no ×.

Ctrl+PageDown and Ctrl+PageUp, or Ctrl+Tab and Ctrl+Shift+Tab, move between tabs, and each tab goes back to the cell it was left on.
A workspace of one carried source saves in the layout every earlier uno reads, a second source moves it to format 4, and pointing at a file moves it to format 5.

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

`gt` and `gT` go to the next and previous source's tab, `{n}gt` to the nth.

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
vp install               # from the repo root, the workspace root
vp run dev               # vite dev server + electron, reloading
vp run build             # out/main, out/preload, out/renderer
vp run smoke             # build, then drive the real app and assert
vp test                  # the keys, without a window
vp check                 # format, lint, type check
```

`vp run dev` prints the Electron pid. Stop it by that pid; there is usually
something else on the machine called electron.

The dev server's URL reaches Electron through `UNO_RENDERER_URL` at run time and
is never compiled in - a localhost address baked into a bundle is one that ships,
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

The window it drives ignores the desktop. Keys, clicks and the wheel from the
window system never reach the page, and the page keeps the focus when someone
switches to another window. Keep working while it runs. Two of the checks send
input down the window system's path, once dropped and once let through. The menu
bar is outside the page and still takes clicks. `vp run preview` runs in the same
mode, and `src/main/driven.ts` has the details.

It needs a display. On a headless machine, run it under Xvfb. Started from a
tool that is itself an Electron app, unset `ELECTRON_RUN_AS_NODE` first, or
Electron starts as plain Node and main finds no `app`.

The assertions live in `src/main/smoke/`, which is test code inside the app -
a smell worth naming. It is there because a virtualiser, a preload bridge and an
IPC round trip cannot be checked anywhere but inside a real Electron, and the
alternative was a browser-automation dependency larger than the app it tests. It
is reached only when `UNO_SMOKE` is set, and nothing in the app calls it.
