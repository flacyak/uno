# uno

Easy spreadsheet handler

![uno opening a workspace whose export was renamed, browsing its folder from the sources panel, peeking at files, pointing the workspace at the renamed export so its edits replay, adding a second export as a tab, then opening settings from the bottom left and trying the Tokyo Night, Catppuccin Frappé and Sakura themes in light and dark before returning to Paper Ember](docs/preview.gif)

Open a data file, fix what does not parse, and save it as a `.uno` that keeps
the original bytes alongside the log of every edit. On the desktop, nothing
leaves the machine.

There is a hosted version too: the same renderer in a browser, over an engine
on a server, which signs in to a bucket with a role in your account rather than
with any key of its own. It is a repository of its own, the submodule at
`apps/www/` here. What it needs of uno is public in this
repository: the engine's messages as WebSocket frames, the engine saying how it
signs in, and the renderer, the `Host` interface and the page's markup that
[`apps/desktop`](apps/desktop) exports.

## Developing

Every command runs from the repo root. `vp run` with no task lists them.

```bash
vp install        # install the workspace
vp run dev        # the desktop app, reloading
vp run build      # @uno/core, then the desktop app
vp run check      # format, lint, type check
vp run test       # every package's suite
vp run smoke      # build, then drive the real desktop app and assert
vp run preview    # film docs/preview.gif: the browse story
                  # `vp run preview sidebar` films docs/sidebar.gif
                  # `vp run preview chart` films docs/chart.gif
```

Three tiers of the tests, sized to what a change can break, each one command:

```bash
scripts/gate.sh 0 [base]   # every edit: check and the related tests, in the packages that changed
scripts/gate.sh 1 [base]   # once per PR: check, related tests, build, the smoke groups the diff touches
scripts/gate.sh 2          # the stack's top and before handing back: check, the whole suite, the whole smoke
```

`base` is the branch below the change, `origin/main` by default.
Run a gate as a command of its own, never chained after another.
The smoke's groups and what each file touches are in `apps/desktop/smoke-groups.json`; `vp run smoke -- --affected <base>` picks them, and `UNO_SMOKE_ONLY=charts,chart-pie vp run smoke` names them.
`core/scripts/timings.ts` runs the full gate and writes where its time went.
