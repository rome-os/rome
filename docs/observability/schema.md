# Observability Schema

Agent-facing cheatsheet for Rome's observability stack. Use it
to write ClickHouse SQL queries by hand. There is no query-layer CLI
wrapper — agents reach the ClickHouse HTTP endpoint directly, with URLs
discovered from environment variables.

For the pipeline shape and invariants (why telemetry looks this way), see
[`../architecture/observability.md`](../architecture/observability.md).

## Endpoints

Two unrelated env groups: one that points the *collector* at a ClickHouse
target (used at boot, mounted into the collector container), and one that
points *queries* at a ClickHouse target (used by agents, scripts, and ad-hoc
SQL). They can be — and in prod almost always are — the same target.

### Collector → ClickHouse (boot)

Read by `infra/observability/otel-collector-config.yaml` via `${env:VAR}`
substitution. **Set in `.env.collector` — never in the shared `.env`.**
The Rome service uses `env_file: .env` and would otherwise pick up these
secrets too. The separate file is what enforces the credential boundary.

`.env.collector` location:

- Prod: sibling of `docker-compose.yml`.
- Dev: worktree root (referenced from `infra/observability/compose.yml` as `../../.env.collector`).

Both files are covered by `.gitignore`'s `.env.*` rule.

| Variable              | Notes                                              |
|-----------------------|----------------------------------------------------|
| `CLICKHOUSE_ENDPOINT` | e.g. `https://<host>.clickhouse.cloud:8443`        |
| `CLICKHOUSE_USERNAME` | default: `default`                                 |
| `CLICKHOUSE_PASSWORD` | secret                                             |
| `CLICKHOUSE_DATABASE` | default: `default`                                 |

Missing or unreachable values fail-close: the collector container
crash-loops at boot. See [`../architecture/observability.md`](../architecture/observability.md#invariants).

### Query target (ad-hoc SQL)

`scripts/dev-up.sh` writes `.obs/env` at the worktree root on every
`pnpm dev:all`. The file is shell-exportable:

```
export $(cat .obs/env | xargs)
# PANTHEON_SLUG, ROME_URL, OBS_UI_URL, ROME_OBS_QUERY_URL,
# ROME_OBS_AUTH_TOKEN (empty in dev) are now set.
```

| Variable              | Dev value                                  | Prod source                  |
|-----------------------|--------------------------------------------|------------------------------|
| `PANTHEON_SLUG`       | unset → telemetry id `unknown` (shared)    | Rome-Cloud-injected            |
| `ROME_URL`            | `http://<slug>.rome.localhost:3000`        | tenant DNS                   |
| `OBS_UI_URL`          | `http://obs.rome.localhost:3000`           | central stack UI URL         |
| `ROME_OBS_QUERY_URL`  | `http://clickhouse.rome.localhost:3000`    | central stack query URL      |
| `ROME_OBS_AUTH_TOKEN` | empty                                      | Rome-Cloud-injected            |

In dev, `ROME_OBS_QUERY_URL` points at the local HyperDX bundle (still
running for offline use). The backend does not write there by default —
its OTLP goes through the central collector defined above. To query the
data Rome actually emitted, point queries at `CLICKHOUSE_ENDPOINT` with
`CLICKHOUSE_USERNAME`:`CLICKHOUSE_PASSWORD` and filter on
`ResourceAttributes['service.instance.id'] = $PANTHEON_SLUG` (`unknown` in dev —
PANTHEON_SLUG is unset, so all worktrees share it and the filter cannot isolate one).

`deployment.environment` is derived from `NODE_ENV`, not a separate var.
`<slug>` is the worktree basename (DNS-label-sanitized) — see
`scripts/worktree-slug.sh`.

## Stack operations (dev)

```
docker compose -f compose.dev.yml stop                       # stop the worktree's Rome
docker compose -f compose.dev.yml down -v                    # wipe worktree volumes (not telemetry)
docker compose -f compose.dev.yml restart <service>          # bounce one Rome service
docker compose -f compose.dev.yml logs -f <service>          # tail logs
docker compose -f infra/observability/compose.yml logs -f    # tail the obs singleton
./r pnpm test                                                # run a command inside rome
```

## Identity (on every span, log, metric)

| Attribute                | Dev value            | Prod value           |
|--------------------------|----------------------|----------------------|
| `service.name`           | `rome`               | `rome`               |
| `service.instance.id`    | `unknown` (no slug)  | tenant slug          |
| `deployment.environment` | `development`        | `production`         |

**Scoping rule**: programmatic queries MUST filter by `service.instance.id`
to isolate to one instance's telemetry. The helper in `@rome-os/app-runtime`
injects this filter automatically so the coding agent cannot accidentally
read another instance's data.

## Spans

Every span carries the identity attributes above, plus:

| Attribute              | Type   | When present                           |
|------------------------|--------|----------------------------------------|
| `session.id`           | string | When in a Rome session                 |
| `rome.app.name`        | string | When span runs inside an app           |
| `rome.session.branch`  | string | Dev only — worktree git branch         |

v1 span names:

| Name                     | Emitted by                                |
|--------------------------|-------------------------------------------|
| `model.call`             | `AnthropicProvider` — one per model call  |
| `agent:{name}`           | `AgentRunner` — one per agent turn        |
| `summon:{child}`         | Subagent-spawn action                     |
| `action:{name}`          | Action registry (already present)         |
| `channel:{name}.handle`  | Channel adapters, per inbound message     |
| `hook:{name}`            | Hook registry, per hook fire              |
| `sdk:{method}`           | `@rome-os/app-runtime` SDK entrypoints       |

Common `model.call` attributes:

| Attribute              | Type   | Example                   |
|------------------------|--------|---------------------------|
| `model.id`             | string | `claude-sonnet-5`         |
| `model.input_tokens`   | int    | `4321`                    |
| `model.output_tokens`  | int    | `128`                     |
| `model.cost_usd`       | float  | `0.0431`                  |
| `model.stop_reason`    | string | `end_turn`, `tool_use`    |

## Logs

`createLogger(component)` writes a JSON line to container stdout (so
`docker compose -f compose.dev.yml logs rome | jq` still works) and
mirrors the same event to OTLP. Each call lands in `otel_logs` with the
schema below:

| Field                  | Type       | Notes                                          |
|------------------------|------------|------------------------------------------------|
| `Timestamp`            | DateTime64 | Event time                                     |
| `SeverityText`         | string     | `debug`, `info`, `warn`, `error`               |
| `Body`                 | string     | Human-readable message                         |
| `LogAttributes`        | Map        | `component`, `session.id` when present, any data fields |
| `ResourceAttributes`   | Map        | Includes `service.instance.id`                 |
| `TraceId`, `SpanId`    | string     | Auto-attached when emitted inside a span       |

Core loggers stamp `LogAttributes['rome.log.source']` as `rome` for platform
code or `rome-apps` for app-owned code. App-owned records also carry
`LogAttributes['rome.app.id']`. Both sources run in the Rome process and retain
the resource-level `ServiceName = 'rome'`. `ScopeName` mirrors the log source so
raw ClickHouse queries can distinguish them without parsing component names.

`LOG_LEVEL` (default `info`) gates both stdout and OTLP — sub-threshold
calls are dropped before either sink sees them. Non-primitive `data`
fields are JSON-stringified when serialised to `LogAttributes`. `Error`
instances are flattened to their stack.

## Metrics

All metrics are prefixed `rome_`. Common series:

| Metric                          | Type      | Key attributes                     |
|---------------------------------|-----------|-------------------------------------|
| `rome_model_tokens_total`       | counter   | `model`, `kind`, `session.id`       |
| `rome_model_cost_usd_total`     | counter   | `model`, `session.id`               |
| `rome_action_duration_ms`       | histogram | `action`, `session.id`              |
| `rome_hook_duration_ms`         | histogram | `hook`, `session.id`                |
| `rome_session_duration_ms`      | histogram | `session.id`                        |

## ClickHouse tables

HyperDX v2 lays out OTEL signals in the `default` database with these
table shapes:

| Table                                  | Holds                        |
|----------------------------------------|------------------------------|
| `otel_logs`                            | Log records                  |
| `otel_traces`                          | Span records                 |
| `otel_metrics_sum`                     | Counter metric points        |
| `otel_metrics_gauge`                   | Gauge metric points          |
| `otel_metrics_histogram`               | Histogram metric points      |
| `otel_metrics_exponential_histogram`   | Exponential histograms       |
| `otel_metrics_summary`                 | Summary metric points        |

Every row has a `ResourceAttributes` Map(String,String) column holding the
identity attributes. Filter by
`ResourceAttributes['service.instance.id'] = '<slug>'` to scope to one
instance.

## Query Examples

Generic shape — POST SQL to the query endpoint.

Dev / prod against the central ClickStack target (where the collector
actually writes):

```
curl -fsS -u "$CLICKHOUSE_USERNAME:$CLICKHOUSE_PASSWORD" \
  -X POST --data "<SQL>" "$CLICKHOUSE_ENDPOINT"
```

Dev against the local HyperDX bundle (only meaningful if you have overridden
`OTEL_EXPORTER_OTLP_ENDPOINT` back to `rome-obs:4318`):

```
curl -fsS -u "default:" -X POST --data "<SQL>" "$ROME_OBS_QUERY_URL/"
```

Prod via the Rome-Cloud-fronted query endpoint (bearer-token auth):

```
curl -fsS -H "Authorization: Bearer $ROME_OBS_AUTH_TOKEN" \
  -X POST --data "<SQL>" "$ROME_OBS_QUERY_URL/"
```

A query helper in `@rome-os/app-runtime` (follow-up) will hide the auth-scheme
difference so callers write one SQL string that works in both.

### Session timeline

```sql
SELECT Timestamp, SpanName, Duration, SpanAttributes
FROM default.otel_traces
WHERE ResourceAttributes['service.instance.id'] = '$PANTHEON_SLUG'
  AND SpanAttributes['session.id'] = 'sess-abc'
ORDER BY Timestamp ASC
FORMAT JSONEachRow
```

### Subagent summon tree

```sql
SELECT TraceId, SpanId, ParentSpanId, SpanName,
       SpanAttributes['rome.app.name'] AS app
FROM default.otel_traces
WHERE ResourceAttributes['service.instance.id'] = '$PANTHEON_SLUG'
  AND SpanAttributes['session.id'] = 'sess-abc'
  AND (SpanName LIKE 'agent:%' OR SpanName LIKE 'summon:%')
ORDER BY Timestamp ASC
FORMAT JSONEachRow
```

Walk `ParentSpanId` client-side to rebuild the tree.

### Slow spans dominating a session

```sql
SELECT SpanName, Duration, SpanAttributes
FROM default.otel_traces
WHERE ResourceAttributes['service.instance.id'] = '$PANTHEON_SLUG'
  AND SpanAttributes['session.id'] = 'sess-abc'
ORDER BY Duration DESC
LIMIT 20
FORMAT JSONEachRow
```

### Recent errors across components

```sql
SELECT Timestamp, LogAttributes['component'] AS component, Body
FROM default.otel_logs
WHERE ResourceAttributes['service.instance.id'] = '$PANTHEON_SLUG'
  AND SeverityText = 'error'
  AND Timestamp > now() - INTERVAL 15 MINUTE
ORDER BY Timestamp DESC
LIMIT 100
FORMAT JSONEachRow
```

### Session cost

```sql
SELECT
  SpanAttributes['model.id'] AS model,
  sum(toFloat64OrZero(SpanAttributes['model.cost_usd'])) AS cost_usd,
  sum(toUInt64OrZero(SpanAttributes['model.input_tokens'])) AS input_tokens,
  sum(toUInt64OrZero(SpanAttributes['model.output_tokens'])) AS output_tokens
FROM default.otel_traces
WHERE ResourceAttributes['service.instance.id'] = '$PANTHEON_SLUG'
  AND SpanAttributes['session.id'] = 'sess-abc'
  AND SpanName = 'model.call'
GROUP BY model
FORMAT JSONEachRow
```

### Cross-instance platform view (prod)

Drop the `service.instance.id` filter to aggregate across all tenants:

```sql
SELECT
  ResourceAttributes['service.instance.id'] AS instance,
  count() AS error_count
FROM default.otel_logs
WHERE SeverityText = 'error'
  AND Timestamp > now() - INTERVAL 1 HOUR
GROUP BY instance
ORDER BY error_count DESC
FORMAT JSONEachRow
```

### Per-model latency p95 (from histogram buckets)

```sql
SELECT
  Attributes['model'] AS model,
  quantileBFloat16(0.95)(Value) AS p95_ms
FROM default.otel_metrics_histogram
WHERE ResourceAttributes['service.instance.id'] = '$PANTHEON_SLUG'
  AND MetricName = 'rome_model_duration_ms'
  AND TimeUnix > now() - INTERVAL 5 MINUTE
GROUP BY model
FORMAT JSONEachRow
```

## Human UI

HyperDX at `$OBS_UI_URL` (dev: `http://obs.rome.localhost:3000`). Same
tables, same attributes, same filters — the UI exposes a search form over
the SQL you would write here. Slice by `service.instance.id` to scope to one
worktree (dev) or tenant (prod).

Curated agent-trace dashboards are defined as code in
[`../../infra/observability/dashboards/`](../../infra/observability/dashboards/)
and applied with `pnpm obs:dashboards`.

Add new recipes to this file as they come up. Resist adding CLI
subcommands — raw SQL + this cheatsheet is the contract.
