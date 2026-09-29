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

A lesson from the deltas: a helper's doc comment costs lines. Keep a helper's comment to one line unless the why needs more.

## Candidates remaining

From the survey, not yet done, highest value first.

- desktop main smoke scripts: `arrives` poller pasted into 30 checks, "wait for N edits" nine times in smoke/vim-style.ts, command typing, openPanel, foot buttons, the connection form filled three times, the panel `lines()` snippet in three files. About 110 lines. Only the real Electron smoke run covers it: `vp run smoke`.
- desktop main/preview.ts: press with modifiers, fix() repeats type(), presses(n), `at` and menu:input built once, story table, waitIn. About 65 lines. Checked by `node scripts/preview.js <story>`.
- desktop scripts/smoke.js and preview.js: one driven launcher in launch.js, rewrite(), withEngine, bucketConnection, freshDir. About 70 lines.
- desktop renderer: workspace relink/append merge (~8), virtualiser frameOnce and fitPool (~14), sources filtered() and pages() (~10), settings radio/segment (~15), popup base for menu and formula (~12), text-field key guard (~15, medium risk).
- grid: telemetry kind table (~10, medium risk), node.ts envKeys, profile error prefixes, readText, hold(); multi.ts refuse(); store/index.ts readEach for loadLibrary and loadConnections (~30 together).
- grid codec: field-table codec for sources (~25, medium risk: JSON key order must match the Go structs).
