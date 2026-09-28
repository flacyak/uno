# Observability

uno reports two kinds of numbers to Grafana.

- **Efficiency metrics** come from CI.
  `internal/grid/tests/efficiency` counts what a change costs in requests, bytes and directory entries read.
  The `efficiency` workflow sends them on every pull request and every push to main.
- **Engine metrics** come from a running uno.
  The engine measures how long each request took to answer, how long each source took to index, and what it asked S3 for.

Both are sent as OpenTelemetry metrics over OTLP/HTTP, which Grafana Cloud and the local stack here both accept.
`dashboards/uno.json` plots both.

## What is sent, and when

Nothing is sent unless `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is set.
Those are the variables every OpenTelemetry tool reads, so a build on a machine nobody set up sends nothing.
The metrics-only variables, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `_HEADERS` and `_PROTOCOL`, stand over the general ones where both are set, and the metrics address is used whole, with no path put after it.
Metrics go as OTLP over HTTP, so a protocol setting other than `http/json` or `http/protobuf` is refused by name.

A measurement says what was done and how long it took.
It carries the kind of request, whether the bytes were on a disk or in a bucket, and the count and size of requests to S3.
It carries no file name, path, bucket or key, and tests in both packages hold it to that.

| Metric in Grafana                        | What it is                                               | Labels                      |
| ---------------------------------------- | -------------------------------------------------------- | --------------------------- |
| `uno_efficiency`                         | one efficiency test's number, as measured in CI          | `metric`, `unit`, `branch`  |
| `uno_engine_request_milliseconds_bucket` | time from a request arriving to its answer being posted  | `request`, `outcome`        |
| `uno_engine_index_milliseconds_bucket`   | time from a source being opened to its last row counted  | `place`                     |
| `uno_engine_indexed_bytes_total`         | bytes of the sources that finished indexing              | `place`                     |
| `uno_s3_requests_total`                  | requests the engine made to S3                           | `method`, `outcome`         |
| `uno_s3_received_bytes_total`            | bytes S3 answered with                                   |                             |

## Grafana on this machine

```bash
docker compose -f observability/docker-compose.yml up
```

Grafana is at http://localhost:3000 and the dashboard is named `uno`.
The container keeps nothing when it stops.

Send the efficiency metrics to it:

```bash
cd internal/grid
vp test tests/efficiency
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node scripts/efficiency.ts
```

Run the desktop app against it:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 vp run start
```

The engine sends its totals every ten seconds and once more as a workspace closes.

## Grafana Cloud, for history

CI needs a Grafana that outlives one run, and the free tier of Grafana Cloud is enough.

1. In the Grafana Cloud portal, open your stack and choose **OpenTelemetry**, then **Configure**.
2. Generate an API token there.
   The page shows two values: `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`.
3. In the GitHub repository, add them as Actions secrets named `GRAFANA_OTLP_ENDPOINT` and `GRAFANA_OTLP_HEADERS`.
4. In Grafana, import `dashboards/uno.json` and pick the stack's Prometheus data source.

From then on the `efficiency` workflow sends every run.
Main is one line per metric, and each pull request is a branch of its own beside it.
A pull request from a fork is not handed secrets, so it is measured and reported in the pull request and sends nothing.

## What a pull request shows

The workflow measures the pull request and the branch it is going into on the same runner.
It writes a table of each metric beside what it was into the job summary, and keeps one comment on the pull request up to date with it.
The counts are exact, so any difference is something the change did.
A change that breaks a budget in `internal/grid/tests/efficiency` fails the job, and the table still says by how much.
