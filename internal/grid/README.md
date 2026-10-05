# @uno/grid

uno's core, in TypeScript: sheets, formulas, the transform language and the
`.uno` container. It allows the Electron desktop and the web app can share
one codebase.

## What is in here

| module     | what it owns                                             |
| ---------- | -------------------------------------------------------- |
| `num`      | what a cell is worth                                     |
| `notation` | markdown in, symbols out                                 |
| `formula`  | parse, evaluate, the column dependency graph             |
| `program`  | the transform language a proposal names and a log stores |
| `sheet`    | the edit log, folded into a schema and applied per row   |
| `ingest`   | bytes to rows: a CSV reader, a record scanner, a sniff   |
| `engine`   | open a file without loading it: index, pages, passes     |
| `pattern`  | the recogniser: watch edits, propose the rest            |
| `document` | the `.uno` codec, `Uint8Array` in and out                |
| `library`  | the `.unof` codecs, formulas and connections, as strings |
| `store`    | the `FileStore` and `ByteSource` seams                   |

Everything above `store` is pure. This lets it share the same code across
platforms. This property should continue. `store/node` and `store/disklister`
are the only files that import `node:fs`, and `store/node` is the only one that
runs a program, a profile's `credential_process`. `store/s3` and `store/sts`
are the only ones that reach a network. Two tests hold each of them to that,
from one list in `tests/store/ways.ts`. `tests/store/opens.test.ts` reads the
source, so it catches a way out however a module is written, `import()` and
`require()` included, even in code no test runs. `tests/store/reaches.test.ts`
runs the core as the desktop engine does, under plain Node with every file
read, socket, program and request watched, so it catches a module whose name
is put together at run time. Each plants a violation to prove it is caught.
`store/node` is its own entry, so a browser build never pulls it in.

## The engine

`engine` is what opens a file too large to hold. A worker runs `serve` with a
port and a way to open a `SourceRef`. It reads the header, then indexes the
file in 8 MB chunks, noting where every block of 1,024 rows starts. The client
holds an `Engine` and a `Band`: 2,000 rows around the viewport, answered
synchronously, with rows that have not arrived reported as pending.

The engine also owns the edit log. `sheet` folds the log into a `Schema`, and
`finish` applies it to a row when the row is read, so an edit is one line and a
new generation number rather than a rewrite. A `Sheet` is the same schema over
rows held in memory, which is how the tests in `tests/sheet` pin the rules a
file the engine never loads follows. The recogniser's `Survey` counts over one
block of rows at a time, so its offer can grow while the engine reads.

Indexing is the first pass. Validation, deduplication, splitting and format
conversion are meant to be the next ones, each a loop over a `PassContext`
running in a worker of its own. `resource/composition.html` has the plan.

## Files with no header row

A reader is told whether a file's first record names its columns: `openFormat`,
`peekFormat` and `read` each take a `HeaderMode`, `"first"` unless said.
With `"none"` every record is a row, the first included, and the columns are
`column_1`, `column_2` and on, from `columnNames`.
What a source was read as shows in its label, which ends `· no header row`.

Only several files read as one carry the choice today, as `header` on the
ref and in the `.uno`. One file opened on its own is read with a header.
`tests/headerless` is the suite for it, from the format up through the join,
the engine and a save opened again.

## Efficiency

`tests/efficiency` measures what a person waits on, as counts that come out
the same on every run: requests sent, bytes asked for, directory entries read.
The engine is the real one, reading the stand-in bucket through the real S3
provider. Every ranged read is held until the test lets it through, so the
order of reads is the scenario's and not a race.

| file             | what it measures                                              |
| ---------------- | ------------------------------------------------------------- |
| `ahead.test.ts`  | bytes fetched to index an object, alone and beside a reader   |
| `band.test.ts`   | requests and bytes for one jump of the grid's 2,000 row band  |
| `open.test.ts`   | requests and bytes an open waits on before it shows rows      |
| `lister.test.ts` | directory entries read again for each page of a 20,000 folder |

Each file holds its numbers to a budget, which is what they are today, so a
change that costs more fails.
A change that costs less should lower the budget with it.
Each also writes its numbers to `out/efficiency/<file>.json` as a list of
`{ name, unit, value }`, smaller is better, for a tracker to plot over time.

```bash
vp test tests/efficiency                       # the four files alone
node scripts/efficiency.ts                     # their numbers as a table
```

`scripts/efficiency.ts` also sets the numbers beside a base's with `--base`,
and sends them to a collector where `OTEL_EXPORTER_OTLP_ENDPOINT` names one.
The `efficiency` workflow does both on every pull request.
`observability/README.md` at the root of the repository has the rest.

## Telemetry

`serve` takes a `Telemetry`, a function it calls with how long each request
took to answer and each source took to index. The engine measures and sends
nothing: `engine/telemetry.ts` is pure, like the rest of the core. Its `Meter`
adds measurements up and writes them as an OTLP metrics request, and the
platform sends that, as the desktop does from `src/engine/telemetry.ts`.
A measurement names what was done and where the bytes were, and nothing about
whose they are.

## Development

```bash
vp install   # dependencies
vp check     # format, lint, type check
vp test      # the ported Go suite
vp pack      # build dist/, with declarations
```
