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

Measured after step 16, against the baseline:

| area                   | lines  | was    |
| ---------------------- | ------ | ------ |
| internal/grid/src      | 16905  | 16971  |
| internal/desktop/src   | 13445  | 13697  |
| all three with scripts | +2045 -2391 over 65 files |

A lesson from the deltas: a helper's doc comment costs lines. Keep a helper's comment to one line unless the why needs more.

## Candidates remaining

From the survey, not yet done, highest value first.

- desktop renderer: text-field key guard shared by six handlers (~15, medium risk: the six differ in composing and preventDefault); frameOnce for the two next-frame redraws (~5); Theming and Language listener lists (~3).
- desktop main/index.ts: menu item and radio helpers (~12). No unit test; the smoke run covers it.
- desktop smoke/vim-style.ts: the connection form filled three times across meets, sources and connections; the typed command repeated four times.
- grid: telemetry kind table (~10, medium risk); sheet/kind.ts isDate as a table (~6); connection parseAuth profile and role as one rule (~12).
- grid codec: field-table codec for sources (~25, medium risk: JSON key order must match the Go structs).
- tests (28k lines) were left alone so far. Shared fixtures and helpers there are the next large pool, if a test's meaning is kept.
