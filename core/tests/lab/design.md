# How uno uses this machine

This note designs the settings a person uses to choose how much of their machine uno takes, and the plumbing that carries each choice from the menu to every engine.
It is research.
No product code comes with it.

## Decisions

- One level, Light, Balanced or Full, sets both the scan workers and the page cache.
- Ease off on battery is a toggle, on by default.
- Keep indexes between opens is a toggle, on by default, with a Clear item that shows how much is kept.
- Background indexing comes in stack C, after the rest has landed, and only finishes a closed workspace's index while plugged in.
- Bucket bytes on this disk gets no setting yet.
- Preparing recent workspaces while idle is dropped.
- Main owns the choice.
  It stores levels in `<userData>/resources.json`, reads the machine's facts, plans limits for each engine, and sends them over the engine's `parentPort`.
- Live changes reach core through `Serving.tune`, which only the platform holds.
  The client protocol gains no request kind.
- The worker pool lives in `apps/desktop/src/engine/`.
  Core gets a `Pool` seam and pure tasks, and never imports `worker_threads`.

## What a person sees

The settings menu gains one section after Language.

```
THIS MACHINE
[ Light | Balanced | Full ]
Up to 5 of 16 cores · about 512 MB for rows
Ease off on battery                       ✓
Keep indexes between opens                ✓
Clear kept indexes                   3.1 MB
```

The segment is the `segment()` the Appearance and Keys sections already use, with `data-uses` on each button.
The note is the plan for the open workspace as main computed it from this machine's facts, so it says what uno will do here.
On battery with easing on, a second note says "On battery, using less".
The two toggles are `menuitemcheckbox` items with the same check mark the radios use.
Clear shows the bytes kept as its meta text, and "nothing kept" once the folder is empty.
After a clear the status bar says "cleared 3.1 MB of kept indexes".

I chose one level over separate core and memory controls on purpose.
Nobody can answer "how many scan workers" or "how many MB of decoded blocks".
People can answer "how hard should uno push this machine".
Storing a level has a second payoff.
A user data folder restored onto another machine plans again from that machine's facts, where stored numbers would be wrong.

## The options

### Use of this machine: cores for indexing and memory for rows

What it does.
It sets how many worker threads an engine's index pass scans on, and how many source bytes its page cache keeps decoded across every source of the workspace.

Choices are `light`, `balanced` and `full`.
The default is `balanced`.

Main plans from two facts, `C = os.availableParallelism()` and `M = os.totalmem()`.
Every number below is a named constant in `shared/resources.ts`.

| level    | scan workers (machine wide)                      | page cache, source bytes (machine wide) |
| -------- | ------------------------------------------------ | --------------------------------------- |
| light    | 0, the engine thread scans as today              | 32 MB, today's `TUNING.cacheBytes`      |
| balanced | `min(BALANCED_MOST = 4, floor(C / 4))`           | `clamp(M / 256, 32 MB, 128 MB)`         |
| full     | `min(FULL_MOST = 8, max(0, C - KEPT_CORES = 2))` | `clamp(M / 64, 32 MB, 512 MB)`          |

| machine           | light     | balanced   | full       |
| ----------------- | --------- | ---------- | ---------- |
| 2 cores, 4 GB     | 0 · 32 MB | 0 · 32 MB  | 0 · 64 MB  |
| 4 cores, 8 GB     | 0 · 32 MB | 1 · 32 MB  | 2 · 128 MB |
| 8 cores, 16 GB    | 0 · 32 MB | 2 · 64 MB  | 6 · 256 MB |
| 16 threads, 32 GB | 0 · 32 MB | 4 · 128 MB | 8 · 512 MB |
| 64 cores, 256 GB  | 0 · 32 MB | 4 · 128 MB | 8 · 512 MB |

The caps 4 and 8 are placeholders.
The curve from `core/tests/lab/parallel` read cold from the 2.5 GB fixture on the NVMe decides them.
The note counts cores as workers plus one, because the engine thread still reads, stitches and cuts blocks.
The note shows memory as cache bytes times `HEAP_PER_CACHED_BYTE`, which commit A7 measures.
The mock above assumes 4.

Memory stays modest on purpose.
For a disk source the OS page cache already holds the bytes, and a block miss costs a read and a decode.
PR #65 puts a 2,000 row page deep in the file at 3.3 ms.
The decoded cache mostly pays off for bucket sources, where a miss is a ranged GET.
A big live heap also makes the engine's major collections longer, and that shows up as late `rows` replies.
So Full stops at 512 MB of source.

Today every view gets its own `tuning.cacheBytes`, so a workspace with six sources may hold six times the budget.
Commit A2 gives each workspace one `PageBudget` that all its `Pages` share, least recently used block out first.

Stored as `uses` in `resources.json`.
It reaches an engine in the start message at fork and in a tune message after.
It applies live.
The pool changes width at the next chunk, and a smaller cache evicts at once.

### Ease off on battery

What it does.
While the machine runs on battery, every engine gets Light's workers.
Memory stays as planned, since holding bytes costs no power.
Background indexing stops.

Choices are on and off.
The default is on.

Main reads `powerMonitor.isOnBatteryPower()`.
Electron 44's types emit `on-ac` on macOS and Windows and `on-battery` on macOS only, and Linux gets neither event.
So main polls every `POWER_POLL_MS = 30_000` while any engine runs, and listens to the events where they exist.

Stored as `easeOnBattery`.
It applies live through a tune message to each engine when the power source changes.

It throttles no further than Light on purpose.
The person is waiting on a foreground index, and Light is exactly today's speed.

### Keep indexes between opens, and clear them

This builds on the kept-index stack (`t3/kept-index`, 959ac89..7dfff09), which has to land first, moved from `internal/grid` to `core/`.

What it does.
On, main passes `--indexes=<userData>/indexes` at fork, and `diskIndexes` keeps each source's index there, held to `INDEXES_BUDGET` (256 MB).
Off, main leaves the flag out and every open indexes from the first row.
Clear removes every kept index.

The default is on.
I left out a budget choice.
An index is 16 bytes per block, about 780 KB for the 2.5 GB, 50 million row fixture, so 256 MB holds hundreds of large files.

Stored as `keepIndexes`.
On and off apply at the next open, because the folder is an argv flag at fork.
A workspace open while the person turns it off keeps writing its own index until it closes.
Clear applies at once.
A workspace open during a clear writes its own index again within `KEEP_EVERY_MS` (2 s), and the item's hover text says so.

`store/node.ts` gains `indexesHeld(dir)` and `clearIndexes(dir)` beside `diskIndexes`, so one module knows the folder's names (`EXT`, `KEY`).
`clearIndexes` removes only names that match the key pattern and their scratch files.
Main imports both from `@store/node`, the way `main/files.ts` already imports `nodeStore`.

### Background indexing, stack C

PR #65 names engines that keep indexing in the background as next work.
With kept indexes, the cheapest useful form is to let a closed workspace's engine finish its unfinished sources, write their indexes, and exit.

The toggle reads "Index in the background when plugged in".
The default is on, because it only finishes work the person started.

Core gains `Serving.finish()`, which lets every pass run to the end, keeps each index, and closes.
On port close the engine entry calls `finish` when its last limits allow background work, and `close` otherwise.
It posts `{ t: "background" }` to main, which re-plans it with `BACKGROUND_LIMITS` (one worker, the floor cache) and counts it apart from workspace engines.
It finishes disk sources only, since finishing a bucket source downloads the rest of the object with nobody watching.
It stops on battery while easing, on `suspend`, when the window closes on macOS (main kills every engine then), and at quit.

Stored as `background`.
It applies at the next close.

### Bucket bytes on this disk, no setting yet

A local copy of bucket ranges would save egress for find and for transform mode, both of which read a whole object again.
It also copies bucket data onto a laptop's disk, which some organisations forbid, and it needs a size choice and a new `ByteSource` cache seam.
The kept index already removes the scan on reopen, which is the most common repeat read.
I would revisit it with numbers from `tests/efficiency/find.test.ts` over the stand-in bucket.
If it comes, it is off by default, has a size cap, keys blocks by ETag or VersionId, and sits behind a `BlockStore` seam beside `IndexStore` with its disk half in `store/node.ts`.

### Preparing recent workspaces while idle, dropped

Kept indexes already make the second open of an unchanged file whole at once, and a first open answers at the sample rows.
The gain left is a recent file rewritten since its last open.
Getting it needs main to act as an engine client over the recents list, which lives in the renderer's localStorage.
It also needs idle detection and a policy for remote sources, which would download whole objects and could run a profile's `credential_process` unattended.
That is a lot of machinery for a small gain.
Telemetry showing people reopening large rewritten files would be the reason to revisit.

### Fixed decisions that are not settings

- No process or thread priority in v1.
  `os.setPriority` changes one thread on Linux and the whole process on macOS and Windows, so a lowered worker would drag down the thread answering rows on two of three platforms.
- The plan never touches `blockRows` or `blockBytes`.
  `indexKey` hashes both, and changing them would orphan every kept index.
- Bucket read-ahead stays at `AHEAD` (4) and is set at fork.
  The pooled pass keeps `width + 1` chunks in flight on its own.
- The engine entry clamps the page cache to `ROWS_HEAP_SHARE` of its own V8 `heap_size_limit`, divided by `HEAP_PER_CACHED_BYTE`.

## Plumbing

### Types and where they live

Core holds what core uses and nothing about machines.

```ts
// core/src/engine/rows.ts
/** The part of Tuning a host may change while the engine runs. */
export type LiveTuning = Pick<Tuning, 'cacheBytes'>;
/** One byte budget shared by every Pages of a workspace. */
export class PageBudget {
  /* resize(bytes) evicts at once */
}

// core/src/engine/serve.ts
export interface Seams {
  tuning?: Tuning;
  connecting?: Connecting;
  telemetry?: Telemetry;
  indexes?: IndexStore;
  pool?: Pool;
}
export interface Serving {
  close(): Promise<void>;
  /** A smaller page budget evicts at once. */
  tune(t: LiveTuning): void;
}
export function serve(
  port: Port<Request, Reply>,
  sources: Sources,
  seams?: Seams,
): Serving;

// core/src/engine/tasks.ts
/** Work a pool runs off the engine's thread, as pure functions over plain data. */
export const TASKS = { scan: scanChunk } as const; // scanChunk from the parallel experiment
export type Tasks = typeof TASKS;
export type TaskName = keyof Tasks;
export interface Pool {
  /** Tasks run at once now. The pass reads it before each read. */
  readonly width: number;
  run<K extends TaskName>(
    task: K,
    input: Parameters<Tasks[K]>[0],
  ): Promise<ReturnType<Tasks[K]>>;
}
/** Runs each task on this thread. For tests, and for a platform without threads. */
export function inlinePool(): Pool;
```

The desktop holds the choice, the facts and the plan, in one module every process can import.

```ts
// apps/desktop/src/shared/resources.ts
export const USES = ['light', 'balanced', 'full'] as const;
export type Uses = (typeof USES)[number];

/** What a person chose. Levels and switches, never numbers. */
export interface Resources {
  uses: Uses;
  easeOnBattery: boolean;
  keepIndexes: boolean;
  background: boolean; // stack C
}
export const DEFAULT_RESOURCES: Resources;

/** What main reads about this machine. */
export interface Machine {
  cores: number; // os.availableParallelism()
  memory: number; // os.totalmem()
  onBattery: boolean; // powerMonitor.isOnBatteryPower()
}

/** What an engine is for. The renderer says it when it asks for one. */
export type Purpose = 'workspace' | 'browse';

/** What one engine may use. Crosses from main to the engine. */
export interface EngineLimits {
  /** Worker threads the index pass scans on. 0 scans on the engine's thread. */
  scanWorkers: number;
  /** Source bytes the page cache keeps decoded, across the workspace. */
  cacheBytes: number;
}

/** Main to engine, over parentPort. The start message carries the port. */
export type EngineMessage =
  { t: 'start'; limits: EngineLimits } | { t: 'tune'; limits: EngineLimits };

/** What the settings menu shows. Plain data, so it crosses contextBridge whole. */
export interface ResourcesView {
  chosen: Resources;
  machine: Machine;
  limits: EngineLimits; // for the open workspace, after easing
  easing: boolean;
  kept: number; // bytes of kept indexes
}

/** Reads anything into a Resources, field by field, defaults where a field is wrong. */
export function parseResources(raw: unknown): Resources;
/** Limits for one of `workspaces` workspace engines. */
export function plan(
  chosen: Resources,
  machine: Machine,
  workspaces: number,
): EngineLimits;
export const BROWSE_LIMITS: EngineLimits; // 0 workers, the floor cache
export function engineMessageOf(raw: unknown): EngineMessage | undefined;
```

`parseResources` never throws.
A file from a newer uno with a level this one lacks reads that field as its default and keeps the rest.
`engineMessageOf` refuses anything but whole numbers at or above each floor, so `NaN`, `Infinity` and negatives never reach core.
Core's `tune` checks again with the same `counted` guard `serve` uses for requests.

### From the menu to the engine

1. At launch main reads `<userData>/resources.json` through `parseResources`.
   A missing or broken file reads as the defaults.
2. The renderer asks for an engine with `host.connect('workspace')` from `load`, or `host.connect('browse')` from `browser()` for the spare.
   Preload sends `engine:connect` with the id and the purpose.
3. Main forks with the same argv as today, plus `--indexes=` when `keepIndexes` is on.
   It posts `{ t: 'start', limits }` with the port, where limits come from `plan(chosen, machine, workspaces)` for a workspace engine and `BROWSE_LIMITS` for a browse engine.
   It then re-plans the other workspace engines and posts `tune` to any whose limits changed.
4. The engine entry listens with `parentPort.on('message')` in place of `once`.
   On `start` it clamps the cache to its heap, builds `threadPool(WORKER, scanWorkers)`, and calls `serve` with the pool.
   On `tune` it resizes the pool and calls `serving.tune`.
5. The menu reads `host.resources()` (`resources:get`) when it opens, and paints the last view it had until the answer lands.
   Settings asks once at construction too, so the first open has a view.
6. Choosing a level calls `host.setResources(next)` (`resources:set`).
   Main parses it, writes the file through `writeAtomic`, re-plans every engine, posts `tune`, and returns the new view for the menu to repaint.
7. A power change re-plans every engine and posts `tune`.
8. An engine's `exit` drops it from main's registry and re-plans the rest.

Main's `engines` set becomes `Map<UtilityProcess, { purpose, limits }>` in a new `main/resources.ts`, and keeps the last limits it sent each engine.
The smoke run reads that record.

The choice lives in main rather than the renderer's localStorage, which is where theme, keys and language live.
Language is a renderer preference that main also needs, so the renderer owns it and reports it.
This one runs the other way.
Main forks the engines, reads the facts, watches the power and clears the folder, and the renderer only shows it.
One owner means no mirror to keep in step after a reload, and stack C can plan without a window.

### Why tune is not a request kind

`Request` is what a client may send an engine, and a hosted engine takes it from a browser tab.
A `tune` request would let any tab size a server's threads and memory.
`Serving` only exists in the hands of the platform that called `serve`, which is the right owner for resources.
The `mode` request stays the model for what a client may change.

### How core stays pure

`tests/store/ways.ts` files `worker_threads` and `cluster` under "a socket", and no module under `src/` may take that way.
So a pool anywhere in core fails `opens.test.ts` by its text, even a quoted module name in a comment, and fails `reaches.test.ts` when it loads.
That holds for `store/node.ts` too.

The seam keeps threads on the platform's side.
Core defines `Pool` and the pure tasks it runs.
The desktop's `engine/pool.ts` is the only file that imports `node:worker_threads`.
`engine/worker.ts` is a ten line shim that looks the task up in `TASKS`, runs it and posts the result.
`core/tests/lab/parallel/speculate.ts` already imports nothing so it can run in any worker, which is what a task needs.
Block cutting stays in `RowIndex.begin` on the engine thread, fed record starts in file order, so a pooled scan writes the same index a serial one does, and either can resume the other's kept index.

Commit A6 makes the rule say what it means.
It moves `worker_threads` and `cluster` from "a socket" to a new way, "a thread", that also matches `new Worker(` and `SharedWorker` in the text guard, with no allowed place.
It adds a plant for it in `opens.test.ts`.
It runs one open in `reach/everything.ts` through `inlinePool`, because code inside a worker thread runs outside `run.ts`'s hooks, which are per thread.
The README's purity paragraph gains a sentence that the platform supplies threads.

## Tests and smoke checks

Core.

- `tests/engine/budget.test.ts` checks that two sources share one budget, that the least recently used block goes first across sources, that a smaller `tune` evicts at once but never the block a read waits on, and that a larger one evicts nothing.
- `tests/engine/tasks.test.ts` checks that `inlinePool` runs each task and rejects with the task's error.
- `tests/engine/pool.test.ts` is a property test in the style of `tests/ingest/scan.test.ts`.
  Over the efficiency generator's CSV, with quoted commas, quoted newlines, CRLF and multibyte characters, at `TINY` and at `TUNING`, the pass through `inlinePool` and through a fake pool that answers out of order builds the same `RowIndex` as the serial pass.
  A width change mid-pass changes nothing either.
  An index kept by a serial pass, restored and resumed through the pool, ends equal to a fresh serial one.
- `tests/store/opens.test.ts` and `reach/everything.ts` change as commit A6 describes.
- `tests/efficiency/pages.test.ts` measures heap bytes per cached source byte, with a budget, the way `index.test.ts` measures heap per row, and holds `HEAP_PER_CACHED_BYTE` above it.
- `tests/store/indexes.test.ts` checks that `indexesHeld` counts only kept indexes and that `clearIndexes` leaves other files alone.

Desktop unit tests.

- `tests/resources.test.ts` feeds `parseResources` null, strings, arrays, wrong types, unknown levels, extra fields and an older shape.
  It plans over the machine table above and checks invariants over random machines.
  Light equals today, with 0 workers and 32 MB.
  Workers never exceed `max(0, cores - KEPT_CORES)`.
  The sum over workspace engines stays within the machine's plan.
  The cache never drops below the floor.
  Easing gives Light's workers.
  Light, Balanced and Full never decrease.
- `tests/engine-message.test.ts` checks that `engineMessageOf` takes start and tune and refuses junk, negatives, fractions, `NaN` and `Infinity`.
- `tests/pool.test.ts` runs `threadPool` with real workers under Node, using `--experimental-transform-types` and `--import paths.js` in the worker's `execArgv`.
  It covers results that land out of order, a resize while busy, and workers that exit after `POOL_IDLE_MS`.
- `tests/settings.test.ts` gains the section in the opening test, the level chosen and marked, the note, the toggles, and Clear's meta before and after.
  The pseudo-locale test that lists section titles gains "This machine".
- `tests/smoke/dom-harness.ts` gives its `Host` the three new methods over a fixed `Machine`, so the headless DOM run boots the real shell with the section.
- `tests/messages.test.ts` needs no change.
  It already fails a language that misses a key or a plural form.

Smoke checks, in a new `main/smoke/machine.ts` and in `main/smoke/settings.ts`.

- The section opens on Balanced, with a note naming the cores main planned for the run.
  The smoke runs in main, so it computes the expected text with the same `plan`.
- Choosing Full re-tunes the open workspace's engine, which shows in main's record of sent limits.
- With Full, the fixture indexes to the same row count and the same first and last rows as with Light.
  This is the check that proves `worker_threads` inside an Electron utility process, and the worker bundle, work end to end.
- After an open, Clear shows a size, and after a click it shows "nothing kept".
- The menu still opens upward inside the window, and a keyboard walk to the last item brings it into view.
- One probe logs the engine's `heap_size_limit` to settle the open question below.

## Five languages

New keys, with English, Spanish and Portuguese.
en-GB matches en-US for all of them, since none uses a spelling that differs.
pt-BR and pt-PT match unless noted.
The pseudo-locale writes itself from en-US.

| key                     | en-US                                                    | es                                                          | pt-BR / pt-PT                                                  |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `settings_machine`      | This machine                                             | Este equipo                                                 | Este computador                                                |
| `uses_light`            | Light                                                    | Ligero                                                      | Leve                                                           |
| `uses_balanced`         | Balanced                                                 | Equilibrado                                                 | Equilibrado                                                    |
| `uses_full`             | Full                                                     | Máximo                                                      | Máximo                                                         |
| `machine_plan`          | Up to {cores} of {total} cores · about {memory} for rows | Hasta {cores} de {total} núcleos · unos {memory} para filas | Até {cores} de {total} núcleos · cerca de {memory} para linhas |
| `machine_easing`        | On battery, using less                                   | Con batería, usa menos                                      | Na bateria, usa menos                                          |
| `machine_battery`       | Ease off on battery                                      | Usar menos con batería                                      | Usar menos na bateria                                          |
| `machine_keep_indexes`  | Keep indexes between opens                               | Guardar índices entre aperturas                             | Guardar índices entre aberturas                                |
| `machine_clear_indexes` | Clear kept indexes                                       | Borrar índices guardados                                    | Apagar índices guardados                                       |
| `machine_nothing_kept`  | nothing kept                                             | nada guardado                                               | nada guardado                                                  |
| `indexes_cleared`       | cleared {size} of kept indexes                           | borrados {size} de índices guardados                        | apagados {size} de índices guardados                           |
| `machine_background`    | Index in the background when plugged in                  | Indexar en segundo plano con corriente                      | Indexar em segundo plano na tomada / ligado à corrente         |

`machine_plan` has plural variants on `total`, because a one core machine reads "of 1 core", and es and pt have `one`, `many` and `other`.
`{cores}` and `{total}` go through `num()`, and `{memory}` and `{size}` go through `bytes()`, so es and pt get comma decimals.

## Commit stack

The kept-index stack lands first.
Stack A is core and stays pure.
Stack B is the desktop and needs A.
Stack C is background indexing and needs both.

| #   | title                                                                       | files                                                                                                                                                                                                                             | lines |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A1  | refactor: serve takes its seams in one object                               | `core/src/engine/serve.ts`, `core/tests/engine/harness.ts`, the seven other core test call sites of `serve`, `apps/desktop/src/engine/index.ts`, `apps/desktop/tests/bucket-engine.ts`, `apps/desktop/tests/smoke/dom-harness.ts` | 85    |
| A2  | feat: a workspace's sources share one page budget                           | `core/src/engine/rows.ts`, `workspace.ts`, `view.ts`, `core/tests/engine/budget.test.ts`                                                                                                                                          | 90    |
| A3  | feat: Serving.tune changes the page budget while the engine runs            | `serve.ts`, `workspace.ts`, `rows.ts`, `budget.test.ts`                                                                                                                                                                           | 50    |
| A4  | feat: a Pool seam and the pure tasks it runs                                | `core/src/engine/tasks.ts`, `core/src/engine/index.ts`, `core/tests/engine/tasks.test.ts`                                                                                                                                         | 70    |
| A5  | feat: the index pass scans through the pool it is given                     | `pass.ts`, `view.ts`, `workspace.ts`, `core/tests/engine/pool.test.ts`                                                                                                                                                            | 100   |
| A6  | test: a thread is its own way out of the core                               | `core/tests/store/ways.ts`, `opens.test.ts`, `reach/everything.ts`, `core/README.md`                                                                                                                                              | 45    |
| A7  | test(efficiency): the heap a cached block costs per source byte             | `core/tests/efficiency/pages.test.ts`, `rows.ts`, `core/README.md`                                                                                                                                                                | 70    |
| A8  | feat: the indexes folder says what it holds and can be emptied              | `core/src/store/node.ts`, `core/tests/store/indexes.test.ts`                                                                                                                                                                      | 60    |
| B1  | feat(desktop): the resources a person chooses, read from anything           | `apps/desktop/src/shared/resources.ts`, `apps/desktop/tests/resources.test.ts`                                                                                                                                                    | 80    |
| B2  | feat(desktop): an engine's limits, planned from the choice and the machine  | `shared/resources.ts`, `tests/resources.test.ts`                                                                                                                                                                                  | 95    |
| B3  | feat(desktop): the renderer says what an engine is for                      | `shared/host.ts`, `preload/index.ts`, `renderer/host.ts`, `shell/shell.ts`, `main/index.ts`, `tests/smoke/dom-harness.ts`                                                                                                         | 40    |
| B4  | feat(desktop): main keeps the choice under user data and shows it           | `main/resources.ts`, `main/index.ts`, `shared/host.ts`, `preload/index.ts`, `renderer/host.ts`, `tests/smoke/dom-harness.ts`                                                                                                      | 95    |
| B5  | feat(desktop): an engine starts with its limits and is tuned as they change | `shared/resources.ts`, `main/resources.ts`, `main/index.ts`, `engine/index.ts`, `tests/engine-message.test.ts`                                                                                                                    | 95    |
| B6  | feat(desktop): the engine scans on worker threads                           | `engine/pool.ts`, `engine/worker.ts`, `engine/index.ts`, `scripts/bundle.js`, `tests/pool.test.ts`                                                                                                                                | 100   |
| B7  | feat(desktop): words for this machine, in five languages                    | `messages/en-US.json`, `en-GB.json`, `es.json`, `pt-BR.json`, `pt-PT.json`                                                                                                                                                        | 60    |
| B8  | feat(desktop): settings say how much of this machine uno uses               | `shell/machine.ts`, `shell/settings.ts`, `settings.css`, `shell/shell.ts`, `tests/settings.test.ts`                                                                                                                               | 100   |
| B9  | feat(desktop): engines ease off on battery                                  | `main/resources.ts`, `shell/machine.ts`, `tests/resources.test.ts`, `tests/settings.test.ts`                                                                                                                                      | 70    |
| B10 | feat(desktop): kept indexes can be turned off and cleared from settings     | `main/resources.ts`, `main/index.ts`, `shared/host.ts`, `preload/index.ts`, `renderer/host.ts`, `shell/machine.ts`, `shell/shell.ts`, `tests/settings.test.ts`                                                                    | 95    |
| B11 | test(smoke): what settings choose for this machine reaches the engine       | `main/smoke/machine.ts`, `main/smoke/index.ts`, `main/smoke/settings.ts`                                                                                                                                                          | 90    |
| C1  | feat: Serving.finish runs every pass to its end, then closes                | `serve.ts`, `workspace.ts`, `view.ts`, `core/tests/engine/finish.test.ts`                                                                                                                                                         | 80    |
| C2  | feat(desktop): a closed workspace finishes its index while plugged in       | `engine/index.ts`, `main/resources.ts`, `shared/resources.ts`, `shell/machine.ts`, `messages/*.json`, tests                                                                                                                       | 100   |
| C3  | test(smoke): a workspace closed part way is whole when it opens again       | `main/smoke/machine.ts`                                                                                                                                                                                                           | 50    |

B8 is the tightest.
If it runs over, the section's segment and note go first and the toggles join B9 and B10.

## Pitfalls

- Several engines run at once.
  There is the workspace engine, the spare until a workspace opens, the old workspace's engine for up to `CLOSE_MS` (10 s) while it writes its indexes, and any opens superseded by a quicker one.
  If each sized itself from `os.totalmem()` the caps would add up.
  The plan divides the machine's budget by the live workspace engines and re-plans on every fork and exit.
  Browse engines get `BROWSE_LIMITS`, because a spare only lists, peeks and signs in.
- Workers multiply by engines in the same way, and the same split covers them.
  The pool spawns workers on first use and lets them exit after `POOL_IDLE_MS`, so an engine with nothing to index holds no threads.
  Each worker isolate still costs a few MB of resident memory.
- The Electron utility process has a V8 heap limit, and decoded rows cost several times their source bytes.
  A cache that outgrows the heap crashes the engine and takes the workspace with it.
  The engine entry clamps the cache to its own `heap_size_limit`.
  `utilityProcess.fork` takes `execArgv`, so `--max-old-space-size` can rise at fork, never live.
  If Electron builds V8 with pointer compression in one shared cage, all isolates in the process, workers included, share about 4 GB.
- Off-heap memory counts too.
  Chunks in flight, `(width + AHEAD) × chunkBytes`, are ArrayBuffers outside the JS heap and inside resident memory, 96 MB at 8 workers.
  Under Electron's V8 sandbox they also live inside the sandbox's reservation.
- `indexKey` hashes `blockRows` and `blockBytes`.
  A level that changed either would orphan every kept index, and the folder would fill with dead ones until pruned.
- A chunk handed to a worker can only be transferred when its view owns the whole ArrayBuffer, from offset 0 to the end.
  A pooled Node `Buffer` is marked untransferable and throws `DataCloneError`, so the pool copies anything else.
  A transferred buffer is detached for the sender, so nothing that holds chunks, `readAhead` or `Pages`, may hand one over.
- Code inside a worker thread runs outside `reach/run.ts`'s hooks.
  Tasks must stay pure functions, and the run-time guard should run them through `inlinePool`.
- On Linux there are no power events, and `isOnBatteryPower()` may read false on some systems, which turns easing off there.
  The smoke run on a laptop should say which.
  Thermal state is macOS only, so it is left out.
- `os.freemem()` moves all the time, and on Linux it leaves out reclaimable cache, so this machine shows 1 GB free with 20 GB available.
  The plan uses `totalmem` only.
  The renderer's `navigator.deviceMemory` caps at 8 for privacy, so the renderer never plans.
- The smoke run uses its own `--user-data-dir`, so `resources.json` and the indexes folder belong to the run.
  A check that clears indexes only sees its own.
- On Windows `userData` sits under `AppData\Roaming`, so up to 256 MB of indexes would roam with a domain profile.
- One more section makes the menu taller than the 660 px it gets in a 720 px window, and it scrolls.
  The section is kept to a segment, a note and three items, and the smoke walk checks the last item scrolls into view.
- Plurals and units need care.
  "of 1 core" needs variants, and memory must go through `bytes()` for es and pt decimals.
- The worker is its own CommonJS bundle in `scripts/bundle.js`, resolved from `__dirname`.
  Once the app is packaged into `app.asar`, a `Worker` may fail to load a script inside the archive, so the worker bundle may need `asarUnpack`.
  The app has no packaging yet.
- PR #65's "index 96 MB on disk" writes its file under `tmpdir()`, which is tmpfs on this machine, so it reads from RAM.
  The worker caps have to come from cold reads, `dd iflag=nocache` on the NVMe fixture, or Full will plan workers a real disk cannot feed.
- Telemetry should carry the level as an attribute of the index measurement, which has three values, so field numbers can be read against it.
  It must never carry core counts or memory, which help fingerprint a machine.
- Closing the window on macOS kills every engine, and quitting kills every utility process, so stack C's background work ends there.

## Open questions

- Does the parallel scan pay?
  The cores half of the level is worth shipping only if `core/tests/lab/parallel` shows a clear win on the 2.5 GB fixture read cold.
  Without it, the level sets memory alone.
- What is Electron 44's `heap_size_limit` in a utility process, and do worker isolates share its cage?
  The smoke probe answers it, and the answer decides whether main passes `--max-old-space-size`.
- Should `HEAP_PER_CACHED_BYTE` be one measured constant, or should `Pages` estimate each block's heap from its cells, which follows narrow numeric files better?
- Is a main-owned `resources.json` an acceptable break from keeping every preference in localStorage?
- Should kept indexes on Windows move to Local AppData?
- Should background indexing default to on while plugged in, or wait until people ask for it?
- Should A1, the options object for `serve`, land inside the kept-index stack, which adds a sixth positional parameter?
