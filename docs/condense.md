# Condensing the code

This file is the running log of an effort to remove lines from `uno` without removing any function.
It exists so that a session picking the work up cold knows the intent, the method, what has been done and what remains.

## Intent

Reduce the line count of `internal/grid` and `internal/desktop` through software design.
Repeated shapes across modules are collapsed into generic, type-safe helpers, parameterised functions and shared abstractions.
Every step leaves `vp run check` and `vp run test` green and every app function intact.
Each step is one commit on branch `t3code/0b7e800c` that names what was collapsed and the line delta.

## Rules

- Function first. A line is removed only when the behaviour it carried is carried elsewhere.
- Abstractions, not compression. Folding two statements onto one line is not a saving.
- `any` is not used. Helpers are generic and typed.
- The house voice is kept: a comment says what and why, in plain sentences.
- Tests are not weakened. A test is changed only when the thing it names moved.

## Method

1. Baseline: install, `vp run check`, `vp run test`, note source line counts.
2. Survey each area for repeated shapes and rank by saving over risk.
3. Apply the highest ranked, one commit each, suites green between.
4. Record each step below with its measured delta.

## Baseline

Measured at commit d264b05, before any change.

| area                 | source lines |
| -------------------- | ------------ |
| internal/grid/src    | 16971        |
| internal/desktop/src | 13697        |

Setup a cold session needs: `vp install`, then `vp run --filter @uno/grid build` before the desktop's tests resolve `@uno/grid`.

## Steps taken

Each is one commit on the branch. Deltas are insertions and deletions over `src/`.

1. store: listers share PAGE, pageKey, byPageKey in list.ts; S3 status words are tables over `answered`; objectAt, sizeOf, refused shared by open and stat; encodeQuery; s3xml's text and when serve sts; go/bytes concat. +192 -195.
2. engine: serve's switch is a typed handler table (KINDS gone); client's requests go through `ask(kind, make)`; workspace replace and changing; labelOf; readable(); codec blamed and optional. +286 -325.
3. library/unof.ts envelope for formulas and connections; go/scanner.ts Scanner under both parsers, program step table; notation bail; schema atEdit. +128 -319.
4. said english table; graph postOrder; pattern pushTo; induce Set; steps uses go/regexp isMeta. +125 -165.
5. desktop said tables.
6. desktop key readers over shared motion tables in keys.ts; state, section, appearance and input words as tables.
7. desktop shell/util.ts `el` and `option`; every builder uses them. +139 -213.
8. desktop shell withTab, paintAll, shown, engineOn, saveTo. +50 -56.
9. desktop renderer workspace replace; sources filtered and pages; metrics fitPool.
10. desktop grid refused and noMarks.
11. desktop popups hang and clickAway; settings radio and segment; Scanner fields written out for strip-only TypeScript.
12. desktop smoke PRELUDE holds arrives, the panel line readers, foot buttons, openPanel, edited. Smoke run: 106 checks pass.
13. desktop main/preview.ts: one Clock, press with modifiers, presses, type in fix, story table, waitIn. Stories edit, browse, refresh, connecting roll.
14. grid node.ts envKeys, envRegion, readText, hold, fail, signed.
15. grid multi partLabel and refuse; store/index readEach.
16. desktop scripts: launch.js drive and rewrite; preview.js savedWorkspace, bucketConnection, freshDir. Smoke passes; edit and refresh stories roll.
17. grid sheet/kind.ts: the date shapes are a table.
18. grid library: each auth mode's block is read by one entry of a typed table.
19. desktop main/files.ts: writeAtomic delegates to the node store's write.
20. grid tests: harness everyRow and multiProviders.
21. desktop tests: Kept stand-in and until in one place each.
22. desktop tests: bucketEngine for the repoint and newer suites.
23. grid tests: the two-profile machine fixture, tests/store/profiles.ts.
24. grid said exports Sentences; the desktop's tables use it.
25. desktop smoke PRELUDE connects a bucket: connectForm, signInAs, saveConnection. Smoke run passes.
26. grid tests: keysOnly, the machine with the stand-in's keys and nothing else, for four suites.
27. desktop tests: the DOM shim's waits are bounded by the clock. happy-dom's frame is setImmediate, so a frame budget was no time at all under load, and three checks failed now and then. This was the flakiness seen in the run.
28. desktop shell: Handlers and dispatch in util; the grid's actions and the prompt's commands as tables; editing for edit, apply and history; the Ctrl chords as a map. Panel: a step map for the moving keys, a Map for the tab keys, a record for the doings, el for its fields. page.ts and shell.ts find elements through found. Smoke run passes.
29. grid s3Location: both https forms through one host pattern.
30. grid codec: omitempty writes a manifest source, with the key order kept where fileSource and partsSource build the records.
31. grid workspace: pointedAt and everyPart, each used once, written where they are used.
32. grid engine: Part is Held less id, name and state, with edits, as a type; keptOf and the save's held are each one spread.

Measured after step 32, against the baseline:

| area                      | lines | was   |
| ------------------------- | ----- | ----- |
| internal/grid/src         | 16813 | 16971 |
| internal/desktop/src      | 13388 | 13697 |
| internal/grid/tests       | 20639 |       |
| internal/desktop/tests    | 7671  |       |
| everything under internal | +2637 -3246 over 96 files, 35 commits |

Tried and reverted: a key and radio helper for the main process menu and an override helper for the driven run's IPC handlers.
tests/bridge.test.ts reads main/index.ts and counts the channel names written as literals beside `webContents.send` and `ipcMain.handle`, on purpose, so a helper that passes the channel through hides what that guard looks for.
The same holds for a generic IPC invoke in the preload.

A lesson from the deltas: a helper's doc comment costs lines. Keep a helper's comment to one line unless the why needs more.

## Candidates remaining

From the survey, not yet done, highest value first.

- desktop renderer: text-field key guard shared by six handlers (~15, medium risk: the six differ in composing and preventDefault, and the saving after the helper is a few lines); frameOnce for the two next-frame redraws (~5); Theming and Language listener lists (~3).
- desktop smoke/vim-style.ts: the connection form filled three times across meets, sources and connections; the typed command repeated four times.
- grid: telemetry's three switches over a kind as three small classes. Measured as line-neutral, so left as it is.
- grid codec: the hand-written CRC-32 could be read out of fflate's gzip trailer, about 20 lines. Left as it is: it would couple the save to gzip's wrapper, and no test checks the CRC, so a wrong one would pass every test and fail only in Go's archive/zip.
- desktop sources: the peek's `shown` and `looking` as one field, about 9 lines, with about 14 test assertions to reword.
- grid codec: field-table codec for sources (~25, medium risk: JSON key order must match the Go structs).
- grid tests: a memory FileHandler stand-in in agree, multi and multifiles (each records something different, so a shared one needs hooks); standinProviders(b) for the three `providers` closures; a `listening(server)` for the three stand-in servers.
- A scan for repeated windows (`python3` over the .ts files, four lines, two or more files) finds little left in src. The next pool is per-file repetition inside shell.ts, panel.ts and sources.ts, and the smoke checks' connection form and command typing.
