# Real formulas

This note plans how uno's formulas grow from row arithmetic into the formula language a modern spreadsheet needs: functions, ranges, references to other rows and to other sources, and aggregates.
It is a plan.
No product code comes with it.
File references are to commit `983ac91b`.

## The gap

Today a formula is one expression bound to a whole column.
It is logged as text in the `.uno` edit log under `Op.Bind` and parsed again on every open.
Its tree has five node kinds: a number, a column name, the four binary operators, unary minus and written parentheses (`core/src/formula/ast.ts:56`).
Evaluation is vectorised over a slice of rows, row-local and stateless.
That is what lets the engine finish any unaligned slice of a file larger than memory, in any order (`core/src/sheet/pipeline.ts:4`).

People already meet these failures today:

- Every failed cell shows `#ERR`, and the reason is thrown away (`core/src/sheet/pipeline.ts:159`).
- A column that reads another computed column parses its formatted text again, so an upstream failure shows up as "not a number" naming the upstream column.
- A header such as `Order ID` or `Q3 (net)` cannot be referenced at all.
- A refusal reaches the form as English behind an `edit N:` prefix, even for people reading es or pt.
- A refused formula still switches the workspace to transform (`apps/desktop/src/renderer/shell/shell.ts:542`).
- `Op.Unbind` exists in core, but the app never sends it, so undo is the only way to take a formula off.
- The engine logs the text as typed while the in-memory Sheet logs the canonical text (`core/src/engine/view.ts:534`, `core/src/sheet/sheet.ts:170`).
- The `.uno` format gate reads only the op (`core/src/document/codec.ts:526`), so a richer grammar inside `bind` would open in an older build and fail mid-replay.

## Decisions

- One expression per column stays the model. A1 cell addresses and per-cell formulas stay out.
- The language takes Excel's vocabulary as a strict superset of today's text. Every text an older build accepted keeps its tree and its printed form, and every row it computes today keeps its number.
- A bare name is always a column, and a name touching `(` is always a function. The grammar has no keywords.
- Any header can be written in brackets, as `[Order ID]`. Another source's column is `tab[column]`, Excel's structured reference.
- Values are typed: number, text, logical, blank, error and date. They flow between bound columns as values, and no column parses another column's display text.
- A blank is 0 in arithmetic and `''` in text, as in Excel. Rows that fail today only because a cell is blank start computing, unless the blank is a divisor, which is `#DIV/0!` as in Excel.
- A cell showing `12.5%` reads as 12.5, as saved files compute with it today.
- A column reads another bound column at the 15 significant digits it shows.
- Five error codes replace `#ERR`: `#VALUE!`, `#DIV/0!`, `#NUM!`, `#N/A` and `#REF!`. Every failed cell has a reason the person reads in their own language.
- A range is a whole column, and it appears only where a function takes a column.
- Every formula stays a pure function of the slice it is handed plus a typed Context of facts defined by row numbers alone: per-block totals, block-start carries and key indexes.
- One derived pass per source fills those facts with fixed-size sequential reads and recomputes only the blocks an edit reaches.
- A cell waiting on a fact is pending. Pending state moves on a new revision counter, and the log's generation keeps its meaning.
- Cross-row means file order.
- A cross-source reference names the source by its id, and uno never reissues an id that any log or undo history names.
- A lookup's key index lives in memory, at most 1 GiB on desktop and 2 GiB on the hosted engine. Cells that read a target past that show `#REF!` until a spilled index exists.
- uno ships once a week, and a release that widens what a bind may hold raises the `.uno` format by one. The format a file declares follows what each bind uses: its tree, its written syntax, its call forms and its parameter shapes.
- The hosted gate will not start under a build that cannot read a workspace already saved, so a release that raised the format is fixed forward once anything is saved at it.
- No third-party formula engine enters the tree. HyperFormula is GPL-3.0-only and cell-addressed, and formulajs assumes whole ranges in memory.
- Delivery starts with errors that say why and a better editor on today's arithmetic. Row functions come next, then totals, then cross-row, then cross-source.

## What a person writes

| To get                                    | A person writes                                         | Note                                               |
| ----------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| A ratio, typed the Excel way              | `=revenue / units`                                      | One leading `=` is accepted and dropped.           |
| A header with spaces                      | `[Order ID]`                                            | `]]` stands for one `]`.                           |
| A condition                               | `IF(units > 0, revenue / units, 0)`                     |                                                    |
| Joined text                               | `region & " / " & rep`                                  |                                                    |
| Rounding                                  | `ROUND(revenue / units, 2)`                             |                                                    |
| A share of the column's total             | `revenue / SUM(revenue)`                                | One argument totals the column.                    |
| A clamp on the row                        | `MAX(0, profit)`                                        | Two or more arguments work on the row.             |
| A filtered total                          | `SUMIF(region, "West", revenue)`                        |                                                    |
| A weighted total                          | `SUM(price * units)`                                    | Any row expression. A blank counts as 0.           |
| The change since the previous row         | `revenue - PREV(revenue)`                               |                                                    |
| A running total                           | `RUNNING_SUM(revenue)`                                  |                                                    |
| A running balance                         | `PREV(balance, 1, 0) + paid_in - paid_out`              | A column may read its own earlier rows.            |
| A lookup into another tab                 | `XLOOKUP(customer_id, customers[id], customers[name])`  |                                                    |
| A total of another tab                    | `SUM(expenses[amount])`                                 |                                                    |
| A tab whose id is not a plain name        | `'google-ads'[clicks]`                                  | `''` stands for one quote mark.                    |

## The language

### Syntax

A call is `NAME(arg, arg)` with the bracket touching the name.
Arguments are separated by commas in every locale, and `ROW()` shows a call may take none.
Function names are ASCII letters, digits, full stops and underscores, starting with a letter, so `STDEV.S` is one name.
They match in any case and print in upper case, so `sum(amount)` is logged as `SUM(amount)`.
A known function name followed by a space and a bracket is refused with a hint, and `Q3 (net)` stays refused as it is today.

From loosest to tightest the operators are the comparisons `= <> < <= > >=`, then `&`, then `+ -`, then `* /`, then `^`.
Unary minus binds tightest, as it does today.
Every binary operator is left-associative, so `-2^2` is 4 and `2^3^2` is 64, both as in Excel.
`a < b < c` is refused with `AND(a < b, b < c)` as the hint, because Excel silently reads it as `(a < b) < c`.
`!=` and `==` are refused with `<>` and `=` as hints, and `price * 20%` is refused with `0.2` as the hint.
Number literals keep today's form.

`"text"` is a string literal, and `""` inside it is one quote mark.
A backslash is an ordinary character, so a pasted Windows path keeps its backslashes.

`TRUE()` and `FALSE()` are the logical constants, which Excel also accepts.
A bare `TRUE` that names no column is refused with `TRUE()` suggested, so a header named `TRUE` keeps working.
Column names match headers exactly, and a name that differs from a header only in case is refused with that header offered.

Every token the grammar adds was refused by the old parser in that position.
Three guards land before any parser or evaluator change, and every later PR keeps them green:

- A golden table of canonical text and shown results over the round-trip corpus and chained columns on `sales-q3.csv`.
- A reference interpreter written from today's rules, run against the evaluator on seeded random expressions and cells.
- The property `parse(formatValue(v)) === roundSignificant(v, SHOWN_DIGITS)` over finite doubles.

`Schema.record` logs a bind's canonical text after it parses, so the Sheet and the engine share one path.
Replay keeps a saved text as it was written.
The parser also records the syntax a text uses as written, so a logged `[revenue]` or leading `=` can never declare the format plain arithmetic needs.
The printer upper-cases function names, drops a leading `=`, puts one space around binary operators and a comma and space between arguments, keeps written parentheses and number text, and brackets only the names that need it.

Function names, `TRUE()`, `FALSE()`, the comma and the full stop as decimal mark are the same in every locale, because formula text moves between machines in the log.
Descriptions and parameter roles are localized messages.

### Values

A value is a number, text, a logical, blank, an error or a date.
A date is whole days since 1970-01-01 on the proleptic Gregorian calendar, shown as `YYYY-MM-DD`.
This keeps day counts out of number display and keeps Excel's fake 29 February 1900 out.
A stored cell is text, or blank when it is empty, holds only white space, or lies past the end of a short row.

Each node returns a `Vec` over its slice.
A `Vec` holds a `Uint8Array` of tags, a `Float64Array` for numbers, logicals and day counts, a text lane allocated only when the static type can be text, and a sparse lane of errors.
Buffers are reused per block, so evaluation still walks the tree once per block with one loop per operator.

A dependent column reads its upstream column's `Vec`.
A number crosses at the precision it shows, `roundSignificant(v, SHOWN_DIGITS)`.
`formatFloat` prints the shortest decimal that reads back, so this equals today's re-parse bit for bit, and every saved chain keeps its numbers.
`SHOWN_DIGITS` stays 15, the most decimal digits a double always keeps.
A cell too narrow for its number ends in an ellipsis, as every grid cell does today (`apps/desktop/src/renderer/grid/grid.css:97`).
An error crosses with its code and its reason, wrapped once in a note naming the upstream column, so the root cause survives a chain.

Where a number is wanted, text reads through `@num` parse exactly as today, decoration included, and a failure is `#VALUE!`.
A logical is 1 or 0 in arithmetic.
A stored cell that reads as an unambiguous date is a date wherever a date makes sense.
`order_date + 7` adds days, `ship_date - order_date` gives the days between, and `YEAR(order_date)` reads it.
A day-month shape that reads both ways is `#VALUE!` naming both readings.
A comparison takes its mode from static types:

- A number on either side compares numbers. A blank compares as 0, so `units = 0` is `TRUE` on a short row and `IF(units > 0, revenue / units, 0)` gives 0 there. Against a number, a cell that reads as no number makes `=` and every ordering `FALSE` and `<>` `TRUE`.
- A date on either side compares dates.
- Text on either side compares text, folded with Go's simple case folding (`equalFold`) and ordered by code point.
- Two stored cells compare as numbers when each reads as a number or is blank, with a blank as 0, and as text otherwise.
- A logical compares only with a logical. Mixed kinds are unequal under `=`, and ordering them is `#VALUE!`.

A blank is 0 in arithmetic, as in Excel, Sheets and Airtable.
A row that fails today only because a cell is blank computes unless the blank is a divisor, and every row that computes today keeps its number.
Dividing by a blank is `#DIV/0!`, and its reason, "units is blank", says why.
Where text is wanted a blank is `''`, where a condition is wanted it is `FALSE`, and `x = ""` is `TRUE` for a blank `x`.
A total over a column skips blanks and text that reads as no number, and counts what it skipped, so `AVERAGE(units)` divides by the rows that hold a number, as Excel's does.
A row expression inside a total gives 0 on a blank row and that 0 counts, so `SUM(price * units)` totals every row.
The golden table records each row that changes: every row that failed only on a blank, before and after.

A cell showing `12.5%` still reads as 12.5, which is what saved files compute with.
A column's value that is not finite after display rounding is `#NUM!`, so no cell shows `+Inf` or `NaN` again.
An intermediate overflow that recovers, as in `1 / (a * b)`, keeps today's number.

A bound column's kind comes from its formula's static result type: number gives num, date gives date, and text or logical gives text.
When the type is mixed, as in an `IF` with a number branch and a text branch, the kind falls back to inference over the sample with error and pending cells skipped.
Today one failing row in the first 200 turns a computed number column to text (`core/src/sheet/kind.ts:36`).

### Errors

A failed cell shows its code where it shows `#ERR` today, styled with `var(--flag)`.
`#NAME?` never reaches a cell, because unknown names are refused when the formula is bound.
Codes and function names are the same tokens in every locale, and the pseudo-locale smoke derives its exemptions from the registry and the code list.

Scanning operands left to right and depth first, the first error or pending operand decides a row, which keeps today's first-error-wins order.
`IF` takes each row from the branch chosen, so an untaken branch's error leaves the row alone.
`IFERROR`, `IFNA` and the `IS` functions look at errors instead of passing them on.
A total takes the error at the lowest row in file order, so its error does not depend on where blocks are cut.

`RowsPage` marks every computed cell that is not a plain value, so a computed `#DIV/0!` is told apart from source text that reads `#DIV/0!`.
The reason comes on demand through one `evaluate` request: as the hover title of a failed cell, in the status bar's cell line, and in the editor's preview.
Marks cost about one byte per row per marked column, while reasons on every page would carry up to 2,000 sentences per column into a hosted session that keeps every unacknowledged frame.

Formula refusals become `Refusal` values carrying `Said {t: 'formula', src, at, length, why}`.
`at` is a 1-based code point offset, as in today's "at character N".
`FormulaWhy` is a closed union: expected, unexpected, no-column with a suggestion, ambiguous-column, notation-column, cycle with its path, unknown-function with an instead hint, arity, space-before-bracket, chained-comparison, spelled-not-equal, double-equals, percent-literal, reach-too-far, mutual-recurrence, unknown-source, foreign-not-here, semicolon-separator, a1-reference and localized-name.
Pasted formulas get a hint: `;` points at `,`, a name shaped like `B2` that no header matches points at column names, and an es or pt name such as SUMA, SI or PROCX points at its English name.
`atEdit` wraps a refusal as `{t: 'at-edit', seq, why}`.
The English of every existing refusal stays exactly as it is, so every message test stays green.
The form shows the reason alone and underlines the span.
The transform language's parser keeps its plain errors.

### Functions

`FUNCTIONS` in `core/src/formula/functions.ts` is one const object declared with `satisfies Record<string, FunctionSpec>`.
A spec lists its forms per arity.
Each form names its parameters (a role, scalar or column, optional or repeating), a class (row, total, running, prev or lookup), a result type rule and its evaluator.
Each spec also carries `since`, the grammar level that first reads it.
`FunctionName` is `keyof typeof FUNCTIONS`, and lookup goes through a `Map` keyed by upper-case name, so prototype keys need no guard.
The renderer's `FUNCTION_HELP` is a `Record<FunctionName, Help>` of paraglide messages, so a function without help fails to compile.
A registry test holds every name to help, conformance rows and a `since` this build maps.

The first tier follows measured use.
The Enron and EUSES corpora's top fifteen functions cover about 70% of spreadsheets, and the Google Sheets corpus leads with SUM, `&`, AVERAGE, LEN, STDEV, COUNTA, MAX, LEFT and IFERROR.

| Family    | Functions                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Logic     | IF, IFERROR, IFNA, AND, OR, NOT, TRUE, FALSE, ISBLANK, ISNUMBER, ISTEXT, ISERROR, ISNA                       |
| Math      | `^`, POWER, SQRT, ABS, ROUND, ROUNDUP, ROUNDDOWN, INT, MOD                                                  |
| Text      | `&`, LEN, LEFT, RIGHT, MID, CONCAT, CONCATENATE, UPPER, LOWER, TRIM, EXACT, SUBSTITUTE, FIND, SEARCH, VALUE |
| Dates     | DATE, YEAR, MONTH, DAY, WEEKDAY, WEEKNUM, EDATE, EOMONTH, DATEVALUE, TODAY                                  |
| Row       | ROW, and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA over two or more values                                      |
| Totals    | SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, STDEV.S, STDEV.P, VAR.S, VAR.P, SUMIF, COUNTIF, AVERAGEIF |
| Cross-row | PREV, RUNNING_SUM, RUNNING_COUNT, RUNNING_MIN, RUNNING_MAX                                                  |
| Lookup    | XLOOKUP                                                                                                     |

STDEV and VAR are aliases of STDEV.S and VAR.S, so a pasted `=STDEV(x)` works.
VLOOKUP, HLOOKUP, LOOKUP, INDEX, MATCH, OFFSET, INDIRECT, SUMPRODUCT, SUBTOTAL and DAVERAGE are refused with a hint that shows the uno way to write them.
TEXT format strings, NOW, MEDIAN, HYPERLINK and regex functions wait.

Formula functions follow Excel under Excel's names, built on the `@go` primitives.
Positions count code points, and `MID` and `FIND` count from 1.
`UPPER` and `LOWER` use Go's simple case mapping, which keeps `ß` as Excel does.
`TRIM` removes U+0020 at both ends and collapses inner runs, as Excel's does.
`SUBSTITUTE` replaces literally.
The transform language keeps its lowercase steps and Go's meaning, `trim()` included.
The two languages share the `Scanner` and `@go` and nothing else, and they never meet in one text, because programs live under `apply` and formulas under `bind`.

## Over files larger than memory

### Ranges

A range in uno is a whole column.
It appears only where a parameter takes a column: the argument of a total, `XLOOKUP`'s key and return columns, the ranges of `SUMIF`, `COUNTIF` and `AVERAGEIF`, and the argument of a running function.
That argument may be any row expression, so `SUM(price * units)` does SUMPRODUCT's job and `SUM(IF(region = "EU", amount, 0))` filters.
With one argument SUM, AVERAGE, MIN, MAX, COUNT and COUNTA total the column.
With two or more they combine values on the row, so a pasted `MAX(0, profit)` clamps as it does in Excel.
A column is the only range a file larger than memory has, and the graph keeps one node per column, so memory never grows with cell count.

### The evaluation Context

Binding compiles each formula into a plan: its static result type, its typed edges, the facts it needs, its lag reach and its grammar level.
`finishRows(schema, first, sources, supplied, ctx)` stays pure and synchronous.
Its Context answers `first`, a clock, `summary(key)`, `prefix(key, block)`, `carry(col, block)` and `lookup(key)`.
Each answer is a final value or `Pending`, and each is defined by row numbers alone.
A value that depends only on its slice and on facts defined by row numbers comes out the same for every slice, which `View.rows`, find and the Sheet all rely on.
The Sheet answers the same Context eagerly in memory, which makes it the oracle the engine is tested against.
Every path that finishes rows takes the Context: `View.rows`, `View.columns`, find, `evaluate`, `Sheet.row`, the exported `finish` that `Sheet.settle` uses (`core/src/sheet/sheet.ts:218`), `Sheet.evaluateAt`, and the Sheets `readDocument` replays, whose foreign columns show `#REF!`.

Graph edges carry a kind: row, lag with its distance, column for a total or a lookup's columns, and foreign for another source's column.
`order()` keeps its post-order, and every check still runs before `bound.set`, so a refused bind changes nothing.
Every cycle is refused, except a column's lag edges to itself.
A bind re-plans every column downstream of its target before `bound.set`, through the graph's existing `downstreamOf`, so a rebind upstream never leaves a stale type, comparison mode or reach below it.

### Totals

Every total is a monoid with `empty`, `add(value, row)`, `combine` and `finish`, kept as one partial per index block.
SUM and AVERAGE keep Shewchuk expansions, the method behind Python's `math.fsum`, which combine without rounding and round once at the end.
MIN, MAX and the counts are exact already.
Each partial keeps its first error with its row and a count of skipped text.
Exact sums matter here: index blocks end at 1,024 rows or 1 MB while the Sheet cuts at 1,024 rows (`core/src/engine/rows.ts:28`).
Only an exact sum gives the Sheet and the engine the same bits for every block cut, edit order and incremental update.
Block partials sit in a segment tree, so a total, a prefix before any block, and the recombine after an edit each cost O(log blocks).
That is held to a budget at a million blocks, the scale of the 400 GB ledgers the hosted fleet is built for (`apps/www/server/src/fleet.ts:4`).

Each View owns one derived loop, modelled on the recogniser's `surveyColumns` (`core/src/engine/view.ts:616`).
It starts after open answers, waits for readable blocks, and sweeps dirty runs with fixed `chunkBytes` reads from a block's start, the way `indexPass` reads.
It reads on a read-ahead stream of its own, because `readAhead` keeps one sequential stream (`core/src/store/ahead.ts:21`), and the survey, find and band reads would otherwise take its prefetched chunks.
It cannot take the index pass's bytes as they stand: that pass drops each chunk once it has found the row starts in it (`core/src/engine/pass.ts:29`), and it starts before open replays the log (`core/src/engine/view.ts:258`, `:318`), so it does not yet know which totals the binds need.
Fixed reads matter because `readAhead` only serves a prefetched chunk to a read of the same length (`core/src/store/ahead.ts:105`).
A block that straddles two reads carries into the next, and each block's row count is checked as `Pages.decode` checks it.
Runs shorter than one read take single blocks.
The loop yields every `SLICE_MS`, posts at most every `PROGRESS_MS`, stops in `shut()`, and keeps its state across generations.
Totals that read other totals run in strata, each after the one before is final.
A failed read, a file changed on disk or a store error turns the items that needed it into `#REF!` carrying the failure's reason, as the survey's error push does (`core/src/engine/view.ts:601`), and the next change or relink retries.

A cell that needs an unfinished fact is pending and shows no value, in the existing pending style.
`generation` keeps its meaning: the log changed.
A second per-source counter, `revision`, rises whenever a fact changes state, and `replaced` records the revision at which a final value last changed.
A page says which facts its pending cells wait on.
A Band refetches when its generation is behind, when its page is older than `replaced`, or when a fact its pending cells wait on turns final.
So a sweep that finishes block after block does not reship every pending band on every push.
Raising `generation` for derived changes would drop recogniser offers and restart a survey that reads stored values only.
The status bar names the work, as "computing SUM(amount) · 43%".
A provisional total appears only in the pinned column summary, never in a cell, where find, kind inference and dependents would read it and then see it change.

An edit marks blocks dirty from its kind and the typed edges between the edited column and each fact.
A set or note at row r dirties the block holding r through a row edge, the blocks through r plus the reach through a lag edge, and every later block through a running or carry edge.
Dirtying through a carry stops once the carries converge.
An apply, bind or unbind dirties every block of the totals it reaches.
Undo and redo apply the rule to the edit taken back or put back.
Every monoid recomputes its dirty blocks from rows, which serves MIN and MAX without an inverse.
Each block carries a dirty epoch, and a fold writes its partial only if the epoch has not moved since it began, so a fold started under an older schema never clears a newer dirty mark.
When the edited block is the only dirty work, `Changed` waits for it.
That block is already cached by the read of `was` in `record` (`core/src/engine/view.ts:534`), so a cell edit costs one cached block and an in-memory recombine, and computed cells do not flash pending on every keystroke.

STDEV and VAR keep exact sums of x and of x², each square split exactly with TwoProduct, and finish in expansion arithmetic, all in the same single pass.
MEDIAN, percentiles and distinct counts have no bounded partial that combines exactly, so they wait for a design of their own.

### Rows that read earlier rows

Cross-row means file order.
Row r is the source's r-th data record, parts keep their fixed order, and append adds rows at the end, so no row is renumbered.

- `PREV(expr, [n], [default])` reads n rows back, the shape of SQL's `LAG`. n is an integer literal from 1 to `REACH_ROWS_AT_MOST`, and the default is blank, so `revenue - PREV(revenue)` on the first row is that row's revenue.
- `RUNNING_SUM`, `RUNNING_COUNT`, `RUNNING_MIN` and `RUNNING_MAX` fold rows 1 through the current one.
- `ROW()` is the 1-based file row.

`REACH_ROWS_AT_MOST` is a language constant, independent of tuning, so a formula means the same under every tuning.

One helper builds every slice from `first - lead` and drops the lead rows.
`View.rows`, `View.columns`, find's `shownIn`, `evaluate` and `Sheet.row` all go through it (`core/src/engine/view.ts:359`, `:378`, `:741`, `core/src/sheet/sheet.ts:106`).
`lead` is the lag reach composed along the graph, so `c = PREV(b)` over `b = PREV(a)` leads by two.
When a column needs a prefix or a carry, `lead` also reaches back to the start of `first`'s block.
A row-local `PREV` reads its lead rows directly and is never pending.
A running function takes its carry-in from the exclusive prefix of the same block partials SUM keeps, then folds inside the slice with the exact accumulator.
The lead rows sit in blocks the page read decodes anyway, so a prefix costs CPU and at most one more block read.
`Sheet.settle` clears its finished rows when the edited column feeds a lag, running or total read, because today it refinishes only the edited row (`core/src/sheet/sheet.ts:209`).

A column may read itself only through `PREV` with n of at least 1, as a running balance or a fill-down does.
The graph stores that read as a lag self-edge, which the cycle check and the post-order skip.
Inside a block the column evaluates row by row from a carry.
The derived store keeps its last n values at each block end and fills them in file order.
After an edit it recomputes forward until a block's carry-out equals the old one, and rows past the frontier are pending.
A `PREV` loop across two columns is refused as mutual recurrence, and every other cycle stays refused with its path.

### Other sources

A foreign column is a source id and a header, written `tab[column]`.
The id is bare when it is identifier-shaped and in single quotes otherwise, with `''` for a quote mark.
The header inside follows the bracket rule.
A foreign column is legal only where a parameter takes a column, because rows of two sources line up only by accident.
`orders[amount] + 1` is refused with a span.
Completion and the tab tooltip show the id beside the file name, since a relink changes the name and keeps the id.

`sourceId` treats as taken every id that any source's log or undone stack names in a bind, beside the ids in use (`core/src/document/document.ts:410`).
Undo moves an edit out of the log onto the undone stack (`core/src/engine/view.ts:496`), so the log alone would let a redo point at a new file with an old id.
Every unbind follows a bind in the same log, so an unbind's `was` adds nothing, and it is checked only as a guard.
Removing a source that a current or undone binding reads is refused with the readers named, modelled on the only-source refusal.
No retired-id list is persisted, because an older build drops unknown manifest keys when it saves (`core/src/document/codec.ts:766`).

`XLOOKUP(key, keys, values, [if_not_found])` matches exactly and takes the first match in the target's file order.
A duplicate key resolves to its earliest row, and append never changes an existing match.
Keys match as case-folded shown text with no trimming, so `007` and `7` stay apart.
A miss gives `if_not_found`, or `#N/A` with a reason naming the key.
Match and search modes are refused.
`SUMIF`, `COUNTIF` and `AVERAGEIF` whose criterion reads the row become per-key rollups over the same index.

The target's derived store builds a key index once the target's index is complete and its log applied.
It is a `Map` from folded key to first row, plus a dense `Vec` per return column, so a reader's band reads no target rows.
A new tuning field, `lookupBytes`, caps each index at 1 GiB on desktop and 2 GiB on the hosted engine, whose instance type has to leave room for it.
The example type in `apps/www/server/src/settings.ts:36`, c7g.large, holds 4 GiB, so a full index there leaves half the memory for everything else.
The hosted value is written `2 * (1 << 30)`, since `2 << 30` overflows JavaScript's 32-bit shift.
A target over the cap makes the reading cells `#REF!` with a reason, so replay never fails because data grew.
Cells are pending until the index exists.
An edit to a key or value cell patches the index for the row's old and new key, keeping first-match order, so a set in a dimension table costs one row and no rebuild.

Each source still replays on its own and concurrently, checking foreign references for syntax only.
It resolves them at evaluation through a `Foreign` interface the Workspace hands each View, so open stays one `Promise.all` (`core/src/engine/workspace.ts:356`).
One workspace graph holds every source's local and foreign edges.
A new bind is checked live against it: the source exists, the header exists, and no cycle closes, including one a purely local bind closes through another source.
A source still opening answers `Pending`, never missing, so reader columns do not flash `#REF!` during open.
A foreign column's static type is a stored cell whatever the target's formula, so a reader's plan is the same at bind and after a syntax-only replay.
Undo rebuilds a Schema from the log and redo records into the existing one, and neither consults the workspace (`core/src/engine/view.ts:495`, `:504`).
So the same checks run after both, and once more when every source has opened.
A column that fails them shows `#REF!` with a reason.
When a cycle closes, the column whose edit comes later in the trail shows it, so a reopen matches the session.

After an edit, undo, redo, relink or append of source A, inside the same serial queue step, the Workspace dirties every reader's facts over A.
It raises each reader's `revision` and `replaced` and pushes the derived message.
Relink and append replace A's whole View (`core/src/engine/workspace.ts:260`, `:322`), so subscriptions move to the new View and A's facts start pending.
A target fact turning final raises its readers' revision the same way.
Readers' generations and recognisers stay as they are.
When a fact turning final changes a column's kind, the derived push carries the new column info.
An Absent target, or one no longer in the workspace, makes the reading cells `#REF!` naming it, and the reader opens and recovers on relink.

## Persistence

`@formula` exports a `Level` union, and each bind's level comes from its plan.
The plan counts the tree's node kinds and operators, the syntax its text uses as written, each call's arity form and parameter shapes (a column, a foreign column, a criterion that reads the row), whether it reads its own column, and whether it totals a total.
`since` sits on each form and parameter shape, so a PR that lifts a refusal without a new node kind takes a level too.
The Schema records each bind's level as it folds it.
`@document` maps `Level` to a format version through a `Record<Level, number>`.
`versionFor` takes the highest level any bind recorded, and `formatFor` returns the larger of what the sources need and what the log needs (`core/src/document/codec.ts:513`).
uno ships once a week from a `v*` tag, the trigger in `.github/workflows/release.yml:16`.
That workflow packages the Electron app for Linux, macOS and Windows and publishes one GitHub release, so each tag is a build people install.
Every PR that widens what a bind may hold adds a level.
The first such PR after a tag raises `FORMAT_VERSION` by one, and the rest of that week's map their levels to the same number.
A check in `test.yml` fails a PR that leaves `FORMAT_VERSION` more than one above its value at the latest tag, so a release raises the format at most once.
It reads the latest tag that holds `core/src/document/document.ts`, since `v0.0.1` keeps format 3 at an older path, `internal/grid/src/document/document.ts`, so the first Electron release sets its baseline.
Between tags, two builds of main can share a format number with different grammars, so only released builds promise the newer-uno message, and the hosted fleet deploys tagged releases only.
Each hosted save records the format its file declares, which `formatFor` computes from what its binds use.
Before it listens, the gate checks that no save is above the format its build reads, beside its page and migration checks (`apps/www/server/src/deploy.ts:14`).
Saves reopen in the engine on the workspace's instance, which boots from the fleet image (`apps/www/server/src/settings.ts:33`), so each deploy moves the gate and the image to the same tagged release, and the gate's format stands for the image's.
So a rollback past a format raise fails at deploy instead of in front of a person.
A release that raised the format rolls back freely until something is saved at it, and is fixed forward after.
A bracketed name that is not identifier-shaped is a level too, and plain arithmetic keeps needing format 3.
An older build then says "saved by a newer uno" where it would fail mid-replay.

The log holds only canonical text, and nothing computed is persisted.
Totals, carries and key indexes are rebuilt on open.
No log-line, state or manifest key is added, because older builds drop unknown keys when they save.
`format6.test.ts` stays byte-identical.
`.unof` stays at library format 1, because the library has no app caller yet.
When it gains one, `stamp` gains a lowest-needed-version parameter, since connections share it.

## On the wire and on screen

`RowsPage` gains `revision` and `marks`: for each computed column holding a cell that is not a plain value, a `Uint8Array` of named `CellMark` values (value, pending, one per code).
One read-only `evaluate` request takes `{t: 'column', col}` or `{t: 'text', col, text}` over up to `PREVIEW_ROWS_AT_MOST` rows.
The text form names its target column, so a preview runs the same cycle and self-read checks a bind would.
It answers each cell's shown text, mark and reason, or the refusal as data.
It runs outside the workspace queue, like rows and find.
A preview reads only facts that already exist, so typing never starts a sweep and S3 egress never follows a person's keystrokes.
`summarize` pins one column per source, and one unnumbered `derived` push carries generation, revision, replaced, progress and the pinned summary.
`Session` coalesces unacknowledged progress, offer and derived frames per source and kind, because it keeps and replays every unacknowledged frame (`core/src/engine/session.ts:182`).
Coalescing is a default for engine-side replies, so the hosted engine, which builds its own `Session` (`apps/www/server/src/engine.ts:136`), needs no new argument.
The shell sends the page's local date with the open request and the View pins `TODAY` to it, so the desktop and a hosted engine in another time zone show the same day.

`FormulaForm` grows where it is, the one formula entry both apps share:

- An underline under the input at the refusal span.
- A debounced preview of the selected row's result through `evaluate`.
- Completion of columns (bracketed when needed), functions with one-line help, and sources.
- Signature help for the call the caret is in.
- Remove formula, which sends `Op.Unbind` as one undoable edit.

`FormulaAsks` gains `preview(col, expr, row)` and `remove(col)` beside `insert` and `closed`.
A token reader in `@formula` tells the editor what sits at the caret.
A persistent formula bar waits for a design of its own.

A right-click on a column header offers Insert or Edit formula, Remove formula and Summarize column, and a click on the fx badge opens the form on that column.
Enter, F2 or `=` on a bound column opens the form where the grid says the column is computed today.
That routing runs before the locked check, in both the default and the vim-style key handling, and `=` on a stored column stays a literal character.
Bind and Remove still switch to transform before the engine call, because the engine refuses edits in view mode (`core/src/engine/view.ts:522`), and they switch back when the engine refuses.
The status bar's cell line shows a failed cell's reason, the work in progress, and the pinned summary.

`apps/www` builds the desktop `Shell` and runs core's `serve` through `link:` dependencies, so every change reaches the hosted app in the same uno PR.
The hosted job in `test.yml` builds, checks and tests `apps/www` at its recorded commit on every uno PR, with no browser smoke.
Three things need a uno-hosted PR of their own: the gate's format check, the hosted engine's `lookupBytes`, and each milestone's browser smoke check.
`propagate.yml`'s automatic bump PR carries each one into uno once uno's checks pass.

## Testing and budgets

Each function family brings a hand-written conformance table whose rows cite Microsoft's documentation or OpenFormula.
Where uno's answer differs, as with percent as decoration, a blank of white space, a folded `=` or code-point `LEN`, the table records uno's answer and the help says so.
No third-party engine enters the repository, dev dependencies included.

The Sheet-versus-engine test under `TINY` tuning gains a column per feature, with pages starting on, one row either side of, and between block boundaries.
A property checks that random unaligned `rows(first, count)` equal single-row reads.
An incremental-equals-full test applies seeded sets and compares totals bit for bit.

Today `ahead.test.ts` budgets the index pass's fetches, and no budget covers any other pass or the size of what crosses the socket.
New budgets, each a named constant in its test:

| Budget                                                         | Bound                                    |
| -------------------------------------------------------------- | ---------------------------------------- |
| A sweep after indexing, with `readAhead` serving its reads     | at most 1.1 times the object             |
| Indexing plus a sweep on open                                  | at most 2.1 times the object             |
| A set beside SUM                                               | at most one block read                   |
| Four summaries                                                 | at most 1 heap byte per row              |
| Marks on a page                                                | a named bound per marked column          |
| A band jump beside PREV, RUNNING_SUM, a balance or XLOOKUP     | today's 6 requests and 310,000 bytes     |
| A band jump beside XLOOKUP                                     | no bytes of the target                   |
| A find beside `units / SUM(units)`                             | within 1.5 times a plain find            |
| Open, also of a `.uno` with a bound total                      | today's 4 requests and 8.6 MB            |
| A sweep beside the survey and band jumps on a remote object    | named request and byte bounds            |
| Refetches while one sweep runs                                 | a named count per band                   |
| A prefix query and a recombine at a million blocks             | a named time bound                       |
| A set beside XLOOKUP or a rollup                               | one row of index work, no target sweep   |

Every visible flow gets an Electron smoke check with a shot, in light and dark, grounded in `sales-q3.csv`.
Its short rows 38, 1202, 2501 and 4812 lack both units and revenue, so `revenue / units` shows `#DIV/0!` there with the reason that units is blank, and `units * 2` shows 0.
A `#VALUE!` needs a units cell set to text first, since every other units and revenue cell in the fixture reads as a number.
The sidebar film is shot again twice: once for completion and preview, and once for `ROUND(revenue / units, 2)`.
Smoke checks of pending cells hold the sweep through a test store that gates reads, because `sales-q3.csv` finishes inside one 8 MB read before a frame paints.
The pseudo-locale smoke gains steps that open the form, cause a refusal, open completion and signature help, select a failed cell and show the pinned summary.
It exempts formula text by selector, because exempting IF, AND, DATE or VALUE as global words would hide real hard-coded English, and it stops skipping the table body where reasons show.

## Delivery

Six milestones, each shippable, in this order.
Every PR stays under about 100 lines, and every PR that adds visible text lists all five locales.
A grammar PR lands only once the in-memory Sheet and the engine both compute it, with pending already on the wire and styled.
Machinery before it lands dark, behind store-level tests.
Bug fixes start from a reproduction in the real app or the engine.
The plan is 116 PRs and about 8,500 lines.

### A. Errors that say why

A failed cell shows `#VALUE!`, `#DIV/0!` or `#NUM!` in the flag colour.
Hovering or selecting it says why, in the person's language, naming the root cause through chained columns.
A refused formula is translated and underlined where reading stopped, and a refusal no longer flips the mode.
A blank counts as 0, so a row that failed only on a blank computes, unless the blank is a divisor.
Every number shown today stays bit-identical, and a cell that shows `+Inf` or `NaN` today shows `#NUM!`.
No new syntax is involved.

| PR  | Title                                                                                      | Lines | After    |
| --- | ------------------------------------------------------------------------------------------ | ----- | -------- |
| A1  | test(formula): pin today's results in a golden table, exporting SHOWN_DIGITS               | 90    |          |
| A2  | test(formula): a reference interpreter checks the evaluator on random old-grammar text     | 90    |          |
| A3  | fix(sheet): a bind is logged in its canonical text, in the Sheet and the engine alike      | 30    |          |
| A4  | fix(shell): a refused formula leaves the mode as it was                                    | 25    |          |
| A5  | refactor(formula): typed value vectors                                                     | 70    |          |
| A6  | refactor(formula): number and column nodes return their own Vec                            | 60    | A1 A2 A5 |
| A7  | refactor(formula): operators combine operand Vecs, and the shared errors array goes        | 70    | A6       |
| A8  | feat(formula): a blank cell reads as 0 in arithmetic, as in Excel                          | 45    | A7       |
| A9  | feat(said): why a computed cell failed, in five locales                                    | 80    |          |
| A10 | feat(sheet): computed cells show #VALUE!, #DIV/0! or #NUM!                                 | 90    | A7 A9    |
| A11 | feat(sheet): a column that reads a computed column keeps its value and its root cause      | 75    | A10      |
| A12 | feat(sheet): a bound column's kind comes from its formula                                  | 50    | A7       |
| A13 | feat(engine): pages mark the computed cells that failed                                    | 85    | A10      |
| A14 | feat(engine): evaluate says why a cell failed                                              | 95    | A10      |
| A15 | feat(grid): failed cells read as errors                                                    | 50    | A13      |
| A16 | feat(status): hovering or selecting a failed cell says why                                 | 75    | A14 A15  |
| A17 | feat(said): an edit's refusal carries its number as data                                   | 55    |          |
| A18 | feat(said): parse refusals carry their span, in five locales                               | 90    | A17      |
| A19 | feat(said): bind refusals name the column, the cycle or the notation as data               | 90    | A18      |
| A20 | feat(form): the form shows the reason and underlines where reading stopped                 | 75    | A18 A19  |
| A21 | test(smoke): the pseudo-locale smoke binds a formula and reads a refusal and a failed cell | 70    | A16 A20  |

### B. Any header, and an editor that helps

Headers like `Order ID` become usable as `[Order ID]`, and a pasted `=revenue / units` works.
The form previews the selected row's result while typing and completes column names.
The column header and the fx badge open the form, and Remove formula takes a formula off.
All of it works on today's arithmetic.
Before the first format raise, a check holds each release to one raise, and the hosted gate refuses to start below a format a workspace was saved at.

| PR  | Title                                                                                | Lines | After     |
| --- | ------------------------------------------------------------------------------------ | ----- | --------- |
| B1  | ci(document): a release raises the format at most once                               | 40    |           |
| B2  | feat(hosted): the gate refuses to start below a saved format, in uno-hosted          | 75    |           |
| B3  | feat(document): a workspace declares the highest format its sources or binds need    | 55    | B1 B2     |
| B4  | feat(formula): any header in [brackets]                                              | 85    | B3 A3 A19 |
| B5  | feat(formula): a formula may start with =                                            | 45    | B3 A3 A18 |
| B6  | feat(engine): evaluate previews an unbound expression for its target column          | 90    | A14 A19   |
| B7  | feat(form): the form shows the selected row's result as you type                     | 90    | B6 A20    |
| B8  | feat(formula): a token reader the editor shares                                      | 55    | B4        |
| B9  | feat(form): the form completes column names                                          | 95    | B7 B8     |
| B10 | feat(grid): the column header opens the formula form                                 | 80    | A4        |
| B11 | feat(grid): Enter, F2 or = on a computed column opens its formula, in both key modes | 50    | B10       |
| B12 | feat(form): Remove formula takes a column's formula off                              | 70    | B10       |
| B13 | docs(preview): the sidebar film types through completion and pauses on the preview   | 40    | B9 B10    |
| B14 | test(hosted): the hosted smoke reads a reason and a preview, in uno-hosted           | 60    | A16 B7    |

### C. Excel functions on a row

IF, IFERROR, comparisons, quoted text with `&`, ROUND, LEFT, TRIM, dates and the rest of the most used Excel functions work under Excel's names.
Completion and signature help come with them, in the desktop and hosted apps.
Files that use them declare a newer format, so an older build refuses them as newer.

| PR  | Title                                                                                    | Lines | After       |
| --- | ---------------------------------------------------------------------------------------- | ----- | ----------- |
| C1  | refactor(formula): values carry text, blank and logical cells                            | 85    | A11 A12     |
| C2  | feat(formula): text in double quotes, joined with &                                      | 90    | C1 B3       |
| C3  | feat(said): the refusals a richer grammar needs, with hints for pasted formulas          | 85    | A18         |
| C4  | feat(formula): comparisons parse, print and take their mode from static types            | 80    | C2 C3       |
| C5  | refactor(sheet): a bind re-plans every column downstream of it                           | 50    | C4          |
| C6  | feat(formula): comparisons give TRUE or FALSE                                            | 70    | C5          |
| C7  | feat(formula): calls parse, print and point at the uno way                               | 70    | C3 A3       |
| C8  | feat(formula): a function registry, starting with TRUE() and FALSE()                     | 95    | C7 C1 B3    |
| C9  | feat(form): every function has help, held by a registry test                             | 85    | C8          |
| C10 | feat(said): why a logic or math function failed, in five locales                         | 60    | A9          |
| C11 | feat(formula): IF, AND, OR and NOT                                                       | 85    | C6 C9       |
| C12 | feat(formula): IFERROR, ISERROR, ISBLANK, ISNUMBER and ISTEXT                            | 80    | C9          |
| C13 | feat(formula): ^, POWER, SQRT and ABS                                                    | 85    | C9 C10      |
| C14 | feat(formula): ROUND, ROUNDUP, ROUNDDOWN, INT and MOD as Excel computes them             | 85    | C9 C10      |
| C15 | feat(said): why a text or date function failed, in five locales                          | 60    | A9          |
| C16 | feat(formula): LEN, LEFT, RIGHT, MID, CONCAT and CONCATENATE count characters            | 90    | C2 C9 C15   |
| C17 | feat(formula): UPPER, LOWER, TRIM and EXACT                                              | 75    | C2 C9       |
| C18 | feat(formula): SUBSTITUTE, FIND, SEARCH and VALUE                                        | 95    | C2 C9 C15   |
| C19 | refactor(sheet): date shapes return the date they read                                   | 70    |             |
| C20 | feat(formula): a date value, and stored cells that read as dates                         | 85    | C19 C6      |
| C21 | feat(formula): DATE, YEAR, MONTH and DAY                                                 | 70    | C20 C9 C15  |
| C22 | feat(formula): WEEKDAY, WEEKNUM, EDATE, EOMONTH and DATEVALUE                            | 90    | C21         |
| C23 | refactor(sheet): every finishing path takes a Context, and ROW() reads it                | 90    | C9          |
| C24 | feat(engine): TODAY reads the page's date, pinned when the source opens                  | 60    | C21 C23     |
| C25 | feat(formula): SUM, AVERAGE, MIN, MAX, COUNT and COUNTA of two or more values on the row | 75    | C9          |
| C26 | feat(form): the form completes functions                                                 | 60    | B9 C9       |
| C27 | feat(form): signature help for the call the caret is in                                  | 85    | C26         |
| C28 | docs(preview): the film types ROUND(revenue / units, 2) through completion               | 30    | C14 C27 B13 |
| C29 | test(hosted): the hosted smoke types IF and ROUND through completion, in uno-hosted      | 50    | C28         |

### D. Totals over whole columns

A pinned column summary fills in live in the status bar as a large file is read.
`revenue / SUM(revenue)`, `COUNTIF(region, "West")` and `SUMIF(region, "West", revenue)` work over files larger than memory.
Waiting cells show as pending and fill in, and the status bar names the work.

| PR  | Title                                                                                            | Lines | After           |
| --- | ------------------------------------------------------------------------------------------------ | ----- | --------------- |
| D1  | feat(num): exact sums that come out the same in any order                                        | 80    |                 |
| D2  | feat(formula): the total monoids                                                                 | 95    | D1 C1           |
| D3  | feat(engine): a sweep reads blocks in fixed chunk-sized reads, on a read-ahead stream of its own | 80    |                 |
| D4  | test(efficiency): a sweep beside the survey and band jumps on a remote object                    | 60    | D3              |
| D5  | feat(engine): a derived store keeps block partials in a segment tree                             | 90    | D2              |
| D6  | feat(engine): the derived pass fills the store, and a failed read turns its items to #REF!       | 95    | D3 D5           |
| D7  | refactor(formula): dependency edges carry a kind                                                 | 80    | C8              |
| D8  | feat(engine): an edit dirties the blocks its typed edges reach                                   | 90    | D6 D7           |
| D9  | feat(protocol): summarize, and the derived push                                                  | 95    | D6              |
| D10 | feat(engine): a session keeps only the newest push of each kind                                  | 60    |                 |
| D11 | feat(status): Summarize column shows a pinned column's totals                                    | 90    | D9 D10 B10      |
| D12 | feat(engine): a cell waiting on a fact is pending, and its page names the fact                   | 90    | D9 A13          |
| D13 | feat(client): a band refetches only when a fact its pending cells wait on turns final            | 60    | D12             |
| D14 | feat(grid): pending cells look pending, and the status bar names the work                        | 85    | D12             |
| D15 | refactor(sheet): the Sheet and the engine answer a plan's totals                                 | 90    | D8 D12          |
| D16 | feat(said): why a total failed, in five locales                                                  | 50    | A9              |
| D17 | feat(formula): SUM, COUNT and COUNTA of one column total it                                      | 80    | D13 D14 D15 C25 |
| D18 | feat(formula): AVERAGE, MIN, MAX and COUNTBLANK of one column                                    | 60    | D16 D17         |
| D19 | feat(engine): find stops at the first pending row                                                | 30    | D12             |
| D20 | test(efficiency): budgets for totals, refetches and an open with a bound total                   | 95    | D17             |
| D21 | feat(engine): totals over columns that read totals                                               | 70    | D17             |
| D22 | feat(formula): STDEV.S, STDEV.P, VAR.S and VAR.P in one pass, with STDEV and VAR                 | 90    | D17             |
| D23 | feat(formula): COUNTIF with a fixed criterion                                                    | 95    | D17 C18         |
| D24 | feat(formula): SUMIF and AVERAGEIF with a fixed criterion                                        | 60    | D23             |
| D25 | test(hosted): the hosted smoke holds a sweep and sees pending cells fill in, in uno-hosted       | 55    | D11 D17         |

### E. Rows that read earlier rows

`revenue - PREV(revenue)`, `RUNNING_SUM(revenue)` and a running balance work on any file size.
They show the same numbers wherever the person scrolls or jumps.
Editing one cell updates a running total by reading one block.

| PR  | Title                                                                                            | Lines | After    |
| --- | ------------------------------------------------------------------------------------------------ | ----- | -------- |
| E1  | refactor(sheet): every finishing path reads lead-in rows                                         | 90    | C23      |
| E2  | feat(said): refusals and reasons for reading other rows, in five locales                         | 55    | A18      |
| E3  | feat(formula): lag edges compose their reach along the graph                                     | 85    | E1 D7 C5 |
| E4  | feat(formula): PREV(expr, n, default) reads earlier rows                                         | 80    | E2 E3    |
| E5  | test(efficiency): a band jump beside PREV stays in budget                                        | 40    | E4       |
| E6  | feat(formula): RUNNING_SUM and RUNNING_COUNT                                                     | 100   | E1 D17   |
| E7  | feat(formula): RUNNING_MIN and RUNNING_MAX                                                       | 50    | E6       |
| E8  | refactor(formula): the graph keeps a column's lag edges to itself, and refuses mutual recurrence | 60    | E4       |
| E9  | feat(engine): carry checkpoints for columns that read themselves                                 | 95    | D8 E8    |
| E10 | feat(formula): a column may read its own earlier rows                                            | 80    | E9       |
| E11 | test(efficiency): band jumps beside running columns, and totals over them after edits            | 80    | E7 E10   |
| E12 | test(hosted): the hosted smoke reads a running total, in uno-hosted                              | 45    | E6       |

### F. Lookups and totals across sources

`XLOOKUP(customer_id, customers[id], customers[name])`, `SUM(expenses[amount])` and `SUMIF(orders[customer], id, orders[total])` work across tabs.
Values follow edits, undo and relinks of the other tab.
A tab with no file shows `#REF!` in the one column that needs it, and a tab that formulas read cannot be removed.

| PR  | Title                                                                                                   | Lines | After       |
| --- | ------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| F1  | feat(engine): a key index in the derived store, patched in place on an edit                             | 95    | D6 D12      |
| F2  | feat(said): why a lookup missed or could not run, in five locales                                       | 50    | A9          |
| F3  | feat(formula): XLOOKUP within a source                                                                  | 95    | F1 F2 D7 C9 |
| F4  | feat(formula): IFNA and ISNA                                                                            | 45    | F3          |
| F5  | feat(said): what a workspace says about other sources, in five locales                                  | 70    | A18 A9      |
| F6  | feat(formula): tab[column] parses, prints and keeps its id taken, undone edits included                 | 90    | F5 B4       |
| F7  | feat(workspace): a Foreign interface resolves another source's columns, pending while it opens          | 80    | F6          |
| F8  | feat(workspace): one workspace graph refuses cycles across sources, after undo, redo and open too       | 90    | F7          |
| F9  | feat(workspace): a change upstream marks its readers' facts stale in the same step                      | 90    | F8          |
| F10 | feat(formula): totals over another source's column                                                      | 80    | F9 D17      |
| F11 | feat(formula): XLOOKUP into another source                                                              | 70    | F3 F10      |
| F12 | feat(formula): SUMIF, COUNTIF and AVERAGEIF with a row value become rollups                             | 95    | F11 D24     |
| F13 | test(efficiency): a set beside XLOOKUP and a rollup settles in budget                                   | 50    | F12         |
| F14 | feat(form): completion offers sources and their columns                                                 | 65    | F6 C26      |
| F15 | test(hosted): the hosted engine sets its lookupBytes, and its smoke looks up across tabs, in uno-hosted | 60    | F11         |

## Risks

- A6, A7 and C1 rewrite the hottest loop in core. `find.test.ts` holds a bound column to 1.5 times a plain find, and each of those PRs has to hold it before anything builds on the `Vec`.
- The format rises once per weekly release that widens the grammar. An older build then refuses a whole workspace because one column uses one newer function, which is correct but blunt.
- Opening a bucket file with totals reads it twice, once to index and once to sweep, every time an engine indexes it. That doubles requests and egress until a pass that shares the index's reads exists.
- Cells that read a total stay pending until a full sweep ends, which takes minutes on a multi-GB bucket file. The status bar's progress line is what keeps that from looking broken.
- Exact accumulators cost several plain adds per value. The sweep should stay bound by decoding, and the totals budget measures throughput so a file of short numeric rows that moves the bottleneck shows up.
- An edit near the top of a 10 GB file under a running balance recomputes carries to the end unless they converge, with a pending suffix meanwhile.
- Lookup indexes live in memory under `lookupBytes`, 1 GiB on desktop and 2 GiB hosted, so a dimension table with tens of millions of keys shows `#REF!` until a spilled index exists.
- Undo stays per source. Undoing an edit in customers changes values shown in orders, with no entry in orders' history.
- Percent as decoration, a blank of white space and code-point `LEN` differ from Excel. The help and the conformance tables say so wherever uno's answer differs.
- Under `=`, two cells holding `007` and `7` are equal because both read as numbers, while XLOOKUP keeps them apart. The help for both says why.
- The arity rule makes `SUM(a)` a column total and `SUM(a, b)` a row sum. It matches how Excel is used and will still surprise someone, so signature help shows both forms.
- Canonical text at record time flattens typed spacing, so any tool that diffs logs sees new edits change shape.
- About fifty function summaries and parameter roles in five locales need a reviewer who reads es, pt-BR and pt-PT. `messages.test.ts` checks keys, inputs and plural forms, and no test checks translation quality.
- Pasted Excel formulas with A1 references, `[@x]`, VLOOKUP, semicolon separators or es and pt function names fail on the first try. The hints turn each failure into one fix, and the first impression still stings.
- A column whose static type is mixed falls back to inference and can change kind as its sample changes.
- A `PREV` whose lead crosses into the previous block reads one more block on a band jump. E5 measures it against today's band budget before running totals build on the same helper.
- A hosted release that raised the format can only be fixed forward once something is saved at it, because the gate will not start under a build that cannot read those saves. Hosted saves live in Postgres and reopen in the engine on the fleet image, so the check holds only while every deploy moves the gate and the image together.
- Blank as 0 changes what saved formulas show. Rows that showed `#ERR` on a blank show numbers, or `#DIV/0!` where the blank is a divisor, and the same file still shows `#ERR` there in an older build.
- Reading stored cells as dates by shape means a column of ISO dates and one stray text cell compute on every row but that one, which shows `#VALUE!`. That is the intended per-cell behaviour, and the help says so.
- A reviewer proposed refusing a digit, comma, digit with no space as a pasted decimal comma. That would refuse `MAX(0,5)`, which English Excel users type, so the live preview and signature help catch a decimal comma instead.

## Questions for the owner

The owner settled five questions: a blank is 0, `12.5%` reads as 12.5, a column reads another at the 15 digits it shows, uno ships once a week, and a key index holds at most 1 GiB on desktop and 2 GiB hosted.
One question stays open, and the answer on digits raised a second.

1. Opening a bucket file with totals reads it twice, once to index and once to sweep, because the index pass keeps no bytes and starts before the binds are known.
   That happens on every open that indexes the file, so on every reopen of a saved workspace with a total.
   The object is the tenant's own, read through a role in their account that trusts uno's principal and their external ID (`apps/www/server/src/engine.ts:219`), so the second read doubles the GET requests on their bill, doubles transfer when the bucket sits outside the fleet's region, and doubles the wait before totals fill in.
   A shared pass removes it: the index pass hands each chunk to the derived store through a queue of a few chunks, chunks that arrive before the log replays wait there, and the sweep reads for itself only what the queue dropped.
   That is about three more PRs in D, and indexing never waits on the totals.
   A total bound after the file is indexed still reads the file once more, since no pass is left to share.
   `apps/www` takes every core change in the same uno PR, so totals reach both apps together.
   The plan recommends landing the shared pass in D before D17, which makes the plan about 119 PRs.
   Should D17 land with the second read and the shared pass after instead?
2. A cell narrower than its number already ends in an ellipsis.
   Should the ellipsis also mark a number that rounding to 15 digits cut, so `1 / 3` shows `0.333333333333333…`?
   A double alone cannot say whether it holds more digits or float error.
   Marking when rounding moved it by more than two units in its last place never marks `0.1 + 0.2`, but it misses 69 of the 218 repeating fractions with a denominator under 30, so `1 / 9` would end in an ellipsis and `8 / 9` would not.
   An exact mark needs every number to carry its value as a fraction through `+`, `-`, `*`, `/` and `ROUND`, falling back to the double past 2^53.
   That adds a lane and a GCD per operation to the hottest loop, in about four PRs held to the find budget.
   The plan recommends the column's ellipsis alone.
   Should rounding get an exact mark instead?
