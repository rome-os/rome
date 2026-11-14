# Personal data

The personal-data store: what the guardian's devices push, what Rome keeps, and how an agent reads it, only in a private turn ([audience](domains/participation.md#audience)). The terms are in [personal data](concepts/data.md#personal-data), and the code is in [`packages/core/src/personal-data/`](../packages/core/src/personal-data/README.md).

## Scope

A source joins the store only when each item is a reading with a time range and a numeric value, and a query over a window aggregates them. Health readings fit, and so would location samples or screen time. Calendar events, reminders, contacts and notes do not: they have titles and people, change in place, and are searched by text. A document source gets its own design, with the same personal-data mark, audience rule, origin and ingest log, and never goes into a reading's `fields`.

Each source declares its types in core: the type, its shape, its canonical unit, whether it adds up or averages, and the units a query may convert to. Apple Health's table is [`sources/apple-health.ts`](../packages/core/src/personal-data/sources/apple-health.ts).

| Shape | What one reading is | Example |
| --- | --- | --- |
| `bucket` | An hour or a day, with a sum or an average and its `min` and `max` | `stepCount`, `heartRate` |
| `sample` | One reading at a time | `bodyMass`, `restingHeartRate` |
| `record` | One span with what goes with it | `sleep` (one night), `workouts` |

A new type or source needs a core release before a device sends it, because an ingest refuses a type it does not know.

## Routes

The ingest takes only `Content-Type: application/json`, and answers 415 otherwise. Every route answers only the guardian's signed-in session, as the iOS app sends it. A visitor, an app key, an anonymous caller and a loopback caller, which an agent's shell is, get 403. Each answer is `Cache-Control: no-store`.

| Route | Does |
| --- | --- |
| `POST /api/personal-data/ingest` | Applies one batch |
| `GET /api/personal-data/sources` | The catalog, the same body as `core:personal_data_catalog` |
| `PUT /api/personal-data/sources/:source/origins/:origin/state` | Sets `active`, `paused` or `off`, so the agent knows why data stops |
| `DELETE /api/personal-data/sources/:source/origins/:origin` | Deletes every reading and catalog row of the origin, sets it `off`, logs one `deleted` row, and answers `{ deletedPoints }` |
| `GET /api/personal-data/sources/:source/ingests?limit=50` | The ingest log, newest first, at most 500 rows |

A state change or a delete for an origin Rome never heard from answers 404.

## Ingest

```jsonc
{
  "version": 1,
  "source": "apple_health",
  "origin": { "id": "<uuid>", "name": "iPhone", "platform": "ios", "appVersion": "1.6.0" },
  "batch": { "id": "<uuid>", "trigger": "observer", "index": 2, "last": false },
  "types": [{ "type": "stepCount", "syncedThrough": "2026-11-13T09:00:00Z" }],
  "upserts": [
    { "key": "stepCount:hour:2026-11-13T08:00:00Z", "type": "stepCount", "shape": "bucket",
      "resolution": "hour", "start": "2026-11-13T08:00:00Z", "end": "2026-11-13T09:00:00Z",
      "tz": "Asia/Shanghai", "value": 812, "unit": "count" }
  ],
  "deletes": [{ "key": "workouts:3A9D…" }]
}
```

- A batch id the origin already sent answers the answer it got then and writes nothing. An upsert whose stored fields are unchanged counts as `unchanged`, and so does a delete of a missing key. A retry after a lost answer is always safe.
- Each item is checked on its own. A refused item is listed in `rejected` with its index and code, the rest applies, and the status is `partial`. The index counts upserts first, then deletes after them.
- A bad envelope (another version, an unknown source, a missing origin or batch) is refused whole with 400.
- One batch takes at most 2,000 items and 1 MB, with or without a Content-Length, or it is refused with 413. An origin may send 60 batches a minute. Over that, it gets 429 with `Retry-After`.
- One batch is one transaction, the catalog included.
- A batch brings its origin back to `active`, and refreshes the origin's name and app version.
- `syncedThrough` is how far the device reports a type complete, which is not the latest reading: a day with no steps still counts as synced. It only moves forward, and a value more than a day ahead of Rome's clock is ignored.
- The metadata keys a source allows are kept, and others are dropped.

| Code | Why the item is refused |
| --- | --- |
| `unknown_type` | The source has no such type |
| `bad_unit` | The unit is not the type's canonical unit |
| `bad_range` | The end is before the start, the time is before 2000 or more than a day ahead, an hour bucket is not one hour, a day bucket is not 22 to 26 hours, or a record is longer than 7 days |
| `type_cap` | The origin already holds 50,000 samples or records of the type. Buckets have no cap |
| `too_large` | The item is over 4 KB of JSON |
| `bad_item` | A field is missing or of the wrong kind, the shape or resolution does not fit the type, or the zone is unknown |

```json
{ "batchId": "…", "status": "ok", "inserted": 12, "updated": 3, "unchanged": 140,
  "deleted": 1, "rejected": [], "receivedAt": "2026-11-13T09:04:11Z" }
```

The ingest log keeps 90 days of rows with counts, ranges and codes, and never a value.

## Agent access

`core:personal_data_catalog` takes no input and lists each source and origin: its state, when it last synced, each type with its unit, range, count and `syncedThrough`, and how to read it live. `core:personal_data_query` aggregates or lists readings. Main reaches both through `actions: ["*"]`, and the Concierge lists both in `concierge.yaml`.

Both are personal-data actions. They run only in a private turn and are refused in a shared one with `personal_data_private_only` and a reason the agent passes on ([audience](domains/participation.md#audience)).

The rule the agent follows is stored first, live second. It answers from stored data and says how fresh it is. It runs `rome-node device run <iphone> health.*` only when the stored data does not cover the question (`freshness.coversWindow` is false and the question needs the latest hours) and the phone is online.

## Query

The input and the reply follow the iPhone's live `health.stats`, so an agent that knows one knows the other.

```jsonc
{
  "source": "apple_health",
  "types": ["stepCount", "sleep"],             // or "type"
  "start": "2026-11-01", "end": "2026-11-13",  // ISO time or YYYY-MM-DD; default today so far
  "timeZone": "Asia/Shanghai",                 // default: the guardian's zone
  "interval": "day",                           // total | hour | day | week | month, at most 1000 buckets
  "aggregate": "sum",                          // default sum for summed types, avg for the rest
  "unit": "km",                                // optional conversion
  "records": { "limit": 100, "cursor": null }  // one sample or record type: list instead of aggregate
}
```

- An ISO time without an offset, and a date, are read in `timeZone`. A date as `end` means the end of that day. With no `start`, the window starts at the local midnight of the day that ends at `end`.
- A bucket is stored under its type, width and start, whatever key the device sends, and a delete of a bucket key is read the same way.
- `hour` reads hour buckets. When the window starts at a local midnight, `day` reads the device's day bucket for each day that has one in `timeZone`, and adds up the hours of each other day. Otherwise it adds up hours. `week`, `month` and `total` roll up from days. Weeks start on Monday.
- A summed type adds up. An averaged type takes the mean of its daily averages, labelled `avg_of_days`, or of its hours, labelled `avg_of_hours`. `min` and `max` are the exact extremes. `latest` does not fit a summed type, and `sum` does not fit an averaged one.
- A sample or record belongs to the bucket it starts in. A night of sleep belongs to the day it ends on, as its key says. A record adds up what comes with it, such as minutes per sleep stage, and counts how many there were. An averaged record averages what comes with it too.
- A bucket with no value is left out, never 0.
- `freshness` says a type covers the window only when its earliest stored reading reaches back to the window's start and the device reports it synced up to the end. Otherwise `missingFrom` says where coverage is not known.
- Each type is read from one origin: one whose readings reach back to the window's start, and among those the one that reports the type synced furthest. When none reaches back, the one synced furthest answers. An origin set off is never read. A second device, or a new origin after a sign-in, takes over a window once its backfill reaches it.

```json
{
  "startISO": "2026-11-01T00:00:00+08:00", "endISO": "2026-11-14T00:00:00+08:00",
  "timeZoneIdentifier": "Asia/Shanghai", "interval": "day",
  "results": [
    { "type": "stepCount", "unit": "count", "aggregate": "sum",
      "buckets": [{ "startISO": "…", "endISO": "…", "value": 8412 }] }
  ],
  "freshness": { "stepCount": { "syncedThrough": "2026-11-13T09:00:00Z", "earliest": "2026-05-14T16:00:00Z",
                                "coversWindow": false, "missingFrom": "2026-11-13T09:00:00Z" } }
}
```

## What is and is not enforced

- Core refuses a personal-data action in a shared turn before it runs, and refuses a routine that reads personal data unless it works for a private chat.
- A turn that an action starts through a worker, such as `system:summon` or the reply to a channel message, takes the audience Rome read for the turn or chat that ran the action. A first-party action's chat is trusted for that, and any other action's turn is shared. A session the turn opens gets the same value in its shell, but a session already live keeps the one it opened with.
- The live path goes through the agent's shell, where core sees no action. The agent's session carries `ROME_TURN_AUDIENCE`, and `rome-node device run` refuses a personal capability (Health on any device, and any capability `system.info` marks `personal`) while it says `shared`. The agent could unset the variable, so this is a guardrail against a model mistake, not a security boundary. The variable is read when the session opens, so a chat that opens to visitors later keeps the value its session started with.
- A private turn can still send what it read elsewhere, with `send_message` or an email, and a Concierge turn woken by outside content, such as a mail it follows, is private. Content that tells the agent to send Health data on can therefore reach it, and only the system prompt guards against that.
- The store lives in Rome's database, which an agent's shell can read. The private-only rule guards against a model mistake, not against an agent that content in a shared chat tells to read the database.
- What an agent already wrote into memory or a chat is not checked. The system prompt tells it not to repeat the guardian's personal data in a shared chat, and only the model keeps that rule.
