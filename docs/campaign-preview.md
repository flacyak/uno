# The campaign film, and the work behind it

The next `docs/preview.gif` tells the story the Row Zero campaign tells, in uno's own facts: an export imported from S3 with the clock running, a row total computed by a spreadsheet function, a pivot table over the rows, and a chart of the pivot.
Two of the four exist today in some form and two do not, so this is the list of work that gets all four to feature complete, cut into tasks a low-context agent can take one at a time.

Every task names the files to read first, the files it may change, how it is proved, and what it waits on.
Commits stay under 100 lines where the design allows, and a task that cannot is marked as a stack.
Every package is checked and tested the same way, from its own folder: `vp run check` and `vp run test`.

## The film, beat by beat

The story is scripted in `internal/desktop/src/main/preview.ts` as absolute beats and staged by `internal/desktop/scripts/preview.js`, the way the `opening` story is staged against the stand-in bucket with latency.

1. The sources panel opens on the right with Ctrl+Shift+B, the bucket's connection is chosen, and an export is added from it.
2. While it indexes, a timer at the bottom right of the status bar counts up; when the index completes it settles on the time and the row count.
3. A column is bound to a function over the row, `SUM(q1, q2, q3, q4)`, from the right-click formula form, and every row's total fills in.
4. A pivot is asked for over the sheet, region by sum of total, and opens as a tab of its own.
5. A chart of the pivot is shown in the sheet's place.
6. The take ends on the chart, and the loop returns to the panel.

## What exists today

- **Import from S3.** The sources panel browses a connected bucket and adds an export, and the `opening` story films exactly that with a slow stand-in. Nothing in the film needs new code here.
- **Timing.** The engine measures how long a source takes to index, for telemetry only, and reports `Progress` as it indexes. The status bar paints the file line, the mode, the selected cell and the switches, and has no clock.
- **Formulas.** A formula binds a column and is evaluated per row, with column references, numbers, `+ - * /`, unary minus and brackets. There are no functions. `SUM` does not parse. The text form is stored in the `.uno`, gated by `FORMULA_VERSION`.
- **Pivot tables.** Nothing. The engine answers `rows` over one source and has no grouping.
- **Charts.** Nothing. The renderer draws a DOM grid, and the page's policy allows no script or image from anywhere but itself, so a chart has to be drawn by uno's own code.

## Workstream A: the import timer

### A1. The engine says when a source began and how long it took

Read first: `internal/grid/src/engine/protocol.ts` (`Progress`, `Opened`), `internal/grid/src/engine/view.ts` and `pass.ts` where progress is emitted, `telemetry.ts` where the index duration is already measured.

Add `elapsedMs` to `Progress`: milliseconds since the open began, final once `complete` is true.
Emit it on every progress reply and on `opened`.
Keep the clock in the engine, so the number in the status bar is the engine's and matches what telemetry reports.

Prove it: an engine test opens the fixture and sees `elapsedMs` grow across progress replies and stop once complete.

Size: one commit. Waits on: nothing.

### A2. The tab keeps the time its source took

Read first: `internal/desktop/src/renderer/workspace.ts` (`Tab`, `progress`), `internal/desktop/src/shared/` for what crosses to the renderer.

A tab records `elapsedMs` from each progress reply and keeps the final one once complete.
A source reopened from a `.uno` keeps the time its reopen took.

Prove it: `internal/desktop/tests/opens.test.ts` or a new `timing.test.ts` sees the tab's time settle.

Size: one commit. Waits on: A1.

### A3. The clock in the status bar

Read first: `internal/desktop/index.html` (the `win-status` row), `internal/desktop/src/renderer/shell/status.ts` (`paint`), `status.css`, `internal/desktop/messages/en-US.json` for how words are added.

A new `#status-timing` element sits at the right end of the status bar, before the selected cell.
While the active tab's source is indexing it counts up in tenths of a second, repainted on each progress reply.
Once complete it reads as the settled time and the row count, `2.4 s · 1,204,000 rows`, and stays for that tab.
It is empty when no source is open.
Every message is added to all six locale files, since `tests/messages.test.ts` refuses a translation that leaves one out.

Prove it: a renderer test paints a tab mid-index and after, and checks the text; the page test opens the fixture and sees the clock settle.

Size: one commit. Waits on: A2.

### A4. The hosted page carries nothing new

The web host imports the desktop's renderer as it is, so the clock appears hosted without a change.
Verify by running `vp run test` in `internal/www/web` after A3 lands, and fix the body-splice test if the status bar's markup changed an id it checks.

Size: none, or a one-line test fix. Waits on: A3.

## Workstream B: functions in formulas

### B1. The grammar takes a function call

Read first: `internal/grid/src/formula/ast.ts`, `parse.ts`, `eval.ts`, `graph.ts`, and `internal/grid/tests/formula/`.

Add a `Call` node, `NAME(arg, arg, …)`, with the name read as an identifier followed by `(`.
Names are case-insensitive and stored upper-case in the text form, as Excel writes them.
`text()` writes a call back out so it round-trips through the `.uno`.
The graph collects the column references inside the arguments.

Prove it: parse and print round trips, a missing bracket and an empty argument list are refused with the parser's usual error.

Size: one commit. Waits on: nothing.

### B2. The first functions

Read first: B1's `Call` node, `eval.ts`.

Implement `SUM`, `AVERAGE`, `MIN`, `MAX`, `ROUND`, `ABS` over numbers, with Excel's arity for each.
An unknown name is a new `UnknownFunctionError`, worded like `UnknownColumnError`.
A blank cell inside `SUM` counts as nothing, as it does in Excel, rather than failing the row.

Prove it: evaluation tests per function, including a blank cell and a text cell.

Size: one commit. Waits on: B1.

### B3. The container version says functions are inside

Read first: `internal/grid/src/document/document.ts` (`FORMULA_VERSION`, currently 3, and where a file's versions are read on open).

Bump `FORMULA_VERSION` and write a `.uno` whose formulas use calls at the new version, so an older uno refuses it with a sentence about the version rather than failing to parse a formula.

Prove it: a document test writes a bound call and reads it back; one at the new version is refused by a reader pinned to the old.

Size: one commit. Waits on: B1.

### B4. The formula form knows the functions

Read first: `internal/desktop/src/renderer/shell/formula.ts`, `tests/formula.test.ts`, `shell/menu.ts` for the right-click entry.

The form's hint lists the functions, and a typed name is completed with its bracket on Tab.
A new menu entry, **Row total**, opens the form with `SUM(` over every numeric column of the sheet already written, so the film's beat is one click and Enter.

Prove it: the form test opens from the entry and sees the prefilled expression; the sidebar story's formula beat still passes.

Size: one commit. Waits on: B2.

### B5. Functions in the web page

Nothing to write: formulas evaluate in the engine. Run `internal/www` tests after B4.

## Workstream C: pivot tables

A pivot is a derived source: rows computed from another source's finished rows, shown as a tab, unwritable, and recomputed when its base changes.
It is persisted in the `.uno` as its definition, so reopening the file recomputes it rather than storing its rows.

### C1. The pivot computation, pure

Read first: `internal/grid/src/sheet/pipeline.ts` (`finishRows`, `valueAt`), `internal/grid/src/num/` for number parsing, `internal/grid/src/sheet/kind.ts`.

A new package `internal/grid/src/pivot/`: given finished rows and a definition `{ by: col[], values: { col, agg }[] }` with `agg` in `sum | count | avg | min | max`, return the grouped rows with a header.
Groups are ordered by first appearance, then by key, deterministically.
Numbers are parsed the way the grid parses them; a value that is not a number is counted but adds nothing.

Prove it: unit tests over small tables, including two group columns and an empty input.

Size: one commit, two if the aggregates are split out. Waits on: nothing.

### C2. The protocol has a pivot

Read first: `internal/grid/src/engine/protocol.ts`, `wire.ts` for how messages become frames.

Add `{ t: "pivot"; id; source; pivot: PivotDef }` and the reply `{ t: "pivoted"; id; opened: Opened }`, where the opened source carries `derived: { from: string; pivot: PivotDef }`.
Add `derived` to `Opened` so a client knows which tabs are pivots.

Prove it: the wire test round-trips the new messages.

Size: one commit. Waits on: C1 for the type.

### C3. The engine computes and serves a pivot

Read first: `internal/grid/src/engine/workspace.ts`, `view.ts`, `rows.ts`.

A `Derived` beside `View`: it reads every row of its base through the base's schema, runs the pivot, and answers `rows` from memory.
Every column is `Supplied`, so an edit is refused with the usual sentence.
When the base's generation changes, the derived rows are recomputed before the next `rows` answer, and a `changed` reply tells the client.
Removing the base removes its pivots.

Prove it: an engine test opens the fixture, asks for a pivot, reads its rows, edits the base and sees the pivot change.

Size: a stack of two commits, the class and then the recompute. Waits on: C2.

### C4. A pivot is saved and reopened

Read first: `internal/grid/src/document/document.ts`, the manifest and `sourceEntry`.

The manifest lists a pivot as a source entry carrying its definition and base, under a new `PIVOT_VERSION`.
Opening a `.uno` recomputes each pivot after its base has opened.
A pivot whose base is absent is absent too, and comes back with it on `relink`.

Prove it: save with a pivot, reopen, the pivot's rows match; a `.uno` from before the version has none and reads as before.

Size: one commit. Waits on: C3.

### C5. The pivot form and tab

Read first: `internal/desktop/src/renderer/shell/shell.ts` (how a tab opens), `shell/menu.ts`, `shell/formula.ts` as the model for a small form, `shell/sidebar.ts` for how tabs are listed.

A **Pivot…** entry in the right-click menu and a `:pivot` command open a form: group by column, value column, aggregate.
Enter asks the engine and opens the answer as a tab named `region by total`, listed in the sidebar under its base with a mark that says it is derived.
A pivot tab shows no cell editor and the status bar's mode reads as view only.
Messages are added to all six locale files.

Prove it: a new `tests/pivot.test.ts` opens the form, asks, and sees the tab and its rows.

Size: a stack of two commits, the form and then the tab. Waits on: C3, C4.

### C6. Hosted carries the pivot

Nothing to write: the gate pipes frames it does not read. Run `internal/www` tests after C5.

## Workstream D: charts

A chart is drawn by uno from a derived source's rows, as inline SVG in the renderer's own colours.
No library and no network: the page's policy forbids both, and the desktop's does too.

### D1. Rows to SVG, pure

Read first: `internal/desktop/src/renderer/base.css` for the tokens, `internal/desktop/src/renderer/grid/` for how rows are typed on the way in.

A new `internal/desktop/src/renderer/chart/` module: given a header and rows, a key column and a value column, return a bar chart as an SVG string, and a line chart for a key that reads as dates.
Bars are labelled with their key, the axis is ticked at round numbers, and colours come from the tokens so the themes apply.
Up to a bounded number of bars; past it the rest are summed into `other`.

Prove it: snapshot-free tests that count bars, read labels and check the axis ticks for a few inputs.

Size: one commit per chart kind. Waits on: nothing.

### D2. The chart in the sheet's place

Read first: `shell/shell.ts` (`loadGrid`, how the empty state and the grid swap), `index.html` for the `win-sheet` column.

A `:chart` command and a **Chart** entry on a pivot tab's menu toggle the sheet column between the grid and the chart.
The chart repaints when the pivot's rows change, and the status bar reads `chart` in the mode word.
Escape or the command again returns to the grid.

Prove it: a renderer test toggles and sees the SVG in the document, then the grid again.

Size: one commit. Waits on: D1, C5.

### D3. The chart choice is kept

Read first: C4's manifest entry.

The pivot's manifest entry records whether it was last shown as a chart and which columns, so a reopened `.uno` comes back as it was left.

Prove it: save, reopen, the chart is up.

Size: one commit. Waits on: C4, D2.

## Workstream E: the film itself

### E1. A fixture worth filming

Read first: `internal/desktop/scripts/preview.js` (`stageOpening`), `internal/grid/tests/store/standin.ts`.

The campaign story stages the stand-in bucket with one export generated at stage time: a few hundred thousand rows of `region, rep, product, q1, q2, q3, q4`, so the timer has something to count and the pivot has something to group.
Latency is set so the import takes a few seconds on screen.
Nothing large is committed; the rows are written to a temp folder when the story starts.

Prove it: the script stages, and the bucket lists the one key.

Size: one commit. Waits on: nothing.

### E2. The campaign story's beats

Read first: `internal/desktop/src/main/preview.ts` (`OPENING`, `SIDEBAR`, and how a story drives keys and clicks), `scripts/preview.js` (`STORIES`, `AGAINST_BUCKET`).

A `campaign` story with beats for the panel, the connection, the add, a hold while the timer counts and settles, the row-total entry, the pivot form, the chart, and the end.
It replaces `browse` as the README's `docs/preview.gif`, and `browse` keeps its place as a story that can still be filmed.

Prove it: `vp run preview campaign` writes the GIF with at least the minimum distinct frames, and the manifest's beats land where the timeline says.

Size: one commit. Waits on: A3, B4, C5, D2, E1.

### E3. The README and the front page

Read first: `README.md` (the GIF's alt text), `internal/www/web/landing.html` (the hero image's alt text).

The alt texts tell the new story.
The front page imports `docs/preview.gif` already, so it shows the new film on its next build.

Size: one commit here, one in `uno-hosted`. Waits on: E2.

### E4. The story stays filmable

Read first: `internal/desktop/tests/smoke.test.ts`.

A smoke check walks the campaign path without the camera: add from the bucket, bind the total, pivot, chart.
It is what keeps the film honest when any of the four features changes.

Size: one commit. Waits on: E2.

## Order and parallelism

Four agents can start at once: A1, B1, C1 and D1 share no files.
A and B are short chains and land first.
C is the long chain and the one with design weight; C1 and C2 can be reviewed before C3 is begun.
D1 can be finished before C exists, since it takes rows and nothing else.
E1 can be written at any time; E2 is last.

## Decisions taken here, to be overturned by the owner if wrong

- The timer is the engine's clock, not the renderer's, so the status bar and telemetry agree.
- A function binds a column and runs on every row, as uno's formulas do; there is no per-cell formula, so a row total is the total column, which is what the film shows.
- A pivot is recomputed, never stored, so a `.uno` stays the bytes and the log.
- A chart is SVG drawn by uno, with no library, because both pages load from nowhere else.
