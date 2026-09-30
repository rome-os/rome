# IM API tracing

Set `ROME_IM_API_TRACE` to record API exchanges for fixture development. The default is `off`. Select `all` (or its alias `true`) or comma-separated platform names:

```dotenv
ROME_IM_API_TRACE=lark,feishu,discord
```

Supported names are `lark`, `feishu`, `discord`, `telegram`, and `wechat`. Unknown names fail configuration validation. `off` overrides other selections. Restart the process after changing the setting. Keep `LOG_LEVEL` at `info` or `debug` to retain these records.

For `pnpm dev:all`, set the variable in the worktree root `.env` and rerun `pnpm dev:all`. Compose must recreate the container to load changed environment values. A container restart alone does not reload its environment.

The core entrypoint initializes tracing for its own process. Independent scripts and subprocesses must call `configureImApiTrace(loadConfig().imApiTrace)` explicitly. Inheriting `ROME_IM_API_TRACE` alone does not activate tracing.

## Records and export

Records use the `im-api-trace` logger and follow the existing [observability pipeline](../architecture/observability.md). They reach JSON stdout and the configured OTLP log destination. The logger stores each structured record as the JSON string `data.event`.

Export records from the branch's container as JSON Lines:

```sh
docker compose -f compose.dev.yml -p "$(scripts/worktree-slug.sh)" logs --no-log-prefix rome 2>&1 |
  jq -Rc 'fromjson? | select(.component == "im-api-trace") | .data.event | fromjson' > im-api-trace.jsonl
```

Each event has `schemaVersion: 1`, `exchangeId`, `platform`, `boundary`, `phase`, `timestamp`, and `detail`. Responses and errors add `durationMs`. Match events by `exchangeId`, not adjacent log lines. Concurrent calls can interleave.

| Phase | Detail |
| --- | --- |
| `request` | HTTP method, URL, headers and body, or SDK method and arguments |
| `response` | HTTP status and headers where available, or the SDK response payload |
| `response-body` | Discord body observed when the SDK calls `json()` or `text()` |
| `error` | Error name and HTTP response status/body when exposed by the SDK |

Discord records each physical REST attempt, including 429 retries. Its undici response stream has no clone method. The recorder observes body consumption by the SDK without consuming the stream first. A response the SDK does not read has no body event.

Lark/Feishu records at the SDK HTTP-instance boundary, including token and message APIs. Successful responses contain the SDK payload and business code, not a synthesized HTTP status. Telegram records at the grammy API-transformer boundary, before multipart serialization. WeChat records HTTP requests through the bot adapter, including polling and sends. QR login requests outside the adapter are not recorded.

## Payload handling

Authentication headers, cookies, credential fields, token-bearing URL paths, and credential query parameters are redacted. Nested JSON strings are inspected too. Binary bodies and non-JSON objects are represented by omission markers. Each detail is bounded to 32 KiB of JSON text. HTTP response inspection has a 250 ms bound and leaves the caller's response readable. Diagnostic failures do not replace API errors or delivery results. With tracing off, responses are not inspected.

Message content and platform identifiers remain visible. Enable recording only for the sessions whose content should enter the configured log store. This is field-based credential redaction, not detection of secrets pasted into free-form chat text. Do not commit exported captures before reviewing and replacing personal content and identifiers.

## Fixture workflow and simulation UI

1. Capture a small real-platform interaction and export its records.
2. Group by platform and exchange ID. Compare the request and response shapes with `src/test/kit/im/`.
3. Replace personal content and identifiers with synthetic values. Add a scenario asserting the newly observed behavior and update the modeled route.
4. Run `pnpm test:im` and keep only the synthetic scenario in the repository.

Captures are evidence for fixture changes, not executable scripts. A future simulation UI can use the same event envelope for a request timeline and read the fixture's message state for conversation rendering. Scenario controls can call the existing event injection and fault barriers. Keep platform payloads available alongside the conversation view so the UI does not hide protocol differences.

The UI is not implemented here. Raw Gateway/WebSocket frames, full reconnect replay, a capture importer, and a browser control API remain separate work. These API records alone cannot reconstruct every incoming Lark or Discord event.
