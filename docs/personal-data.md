# Personal data

The personal-data store: what the guardian's devices push, what Rome keeps, and how an agent reads it. The terms are in [personal data](concepts/data.md#personal-data), and the code is in [`packages/core/src/personal-data/`](../packages/core/src/personal-data/README.md).

How stored data and live reads fit together: [Device connection](domains/connections.md#device-connection).

## Scope

A source joins the store when each item is either a reading or an entry. A reading has a time range and a numeric value, and a query over a window aggregates it: Health readings fit, and so would location samples or screen time. An entry is a document with a time, such as a calendar event: it has words and people, changes in place, is listed over a window it overlaps and found by its words, and is never aggregated. Entries keep the same personal-data mark, origin and ingest log as readings, and never go into a reading's `fields`. Contacts and notes have no time, so neither shape fits them.

Each source declares its types in core: the type, its shape, its canonical unit, whether it adds up or averages, and the units a query may convert to. An entry type declares instead the content fields it keeps, each a text, a flag, a number or a list of texts, and how far past Rome's clock an entry may end. Apple Health's table is [`sources/apple-health.ts`](../packages/core/src/personal-data/sources/apple-health.ts), and the iPhone's calendar is [`sources/apple-calendar.ts`](../packages/core/src/personal-data/sources/apple-calendar.ts).

| Shape | What one reading is | Example |
| --- | --- | --- |
| `bucket` | An hour or a day, with a sum or an average and its `min` and `max` | `stepCount`, `heartRate` |
| `sample` | One reading at a time | `bodyMass`, `restingHeartRate` |
| `record` | One span with what goes with it | `sleep` (one night), `workouts` |
| `entry` | A document with a time, and its `content` as the type declares it | `events` |

A new type or source needs a core release before a device sends it, because an ingest refuses a type it does not know.

## Routes

The ingest takes only `Content-Type: application/json`, and answers 415 otherwise. The data is the guardian's own, so only the guardian's signed-in session, as the iOS app sends it, writes it: the ingest, a state change and a delete. The `GET` routes also answer a [dashboard admin](concepts/access.md#dashboard-admin)'s signed-in session ([decision](adrs/a-dashboard-admin-has-the-guardians-access.md)). Any other caller gets 403: an app visitor, an app key, an anonymous caller, and a loopback caller, which an agent's shell is. Each answer is `Cache-Control: no-store`.

| Route | Does |
| --- | --- |
| `POST /api/personal-data/ingest` | Applies one batch |
| `GET /api/personal-data/sources` | The catalog, as `core:personal_data_catalog` lists it, with each source's `connectionId` in place of its live pointer |
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
  "deletes": [{ "key": "workouts:3A9D…" }],
  // A snapshot of a window, for calendar events. Windows only on the last batch.
  "snapshot": { "id": "<uuid>", "readAt": "2026-11-13T09:00:00Z",
    "windows": [{ "type": "events", "start": "2026-11-05T16:00:00Z", "end": "2026-11-28T16:00:00Z" }] }
}
```

- A batch id the origin already sent answers the answer it got then and writes nothing. An upsert whose stored fields are unchanged counts as `unchanged`, and so does a delete of a missing key. A retry after a lost answer is always safe.
- Each item is checked on its own. A refused item is listed in `rejected` with its index and code, the rest applies, and the status is `partial`. The index counts upserts first, then deletes after them.
- A bad envelope (another version, an unknown source, a missing origin or batch) is refused whole with 400.
- One batch takes at most 2,000 items and 1 MB, with or without a Content-Length, or it is refused with 413. An origin may send 60 batches a minute. Over that, it gets 429 with `Retry-After`.
- One batch is one transaction, the catalog included.
- A batch brings its origin back to `active`, and refreshes the origin's name and app version.
- `connectionId` is still accepted and stored for older apps, but nothing reads it: the device's report names its origin, which links the data to its install ([live](#live)). `null` clears it, and an envelope without it leaves it as it is.
- `syncedThrough` is how far the device reports a type complete, which is not the latest reading: a day with no steps still counts as synced. It only moves forward, and a value more than a day ahead of Rome's clock is ignored.
- The metadata keys a source allows are kept, and others are dropped.
- An entry carries `content` and no `value`, `unit` or `fields`. Content fields its type does not declare, or of the wrong kind, are dropped, and a text is cut at its declared length. An entry may end up to its type's horizon past Rome's clock (400 days for calendar events) and last up to 366 days.
- A device may send a type it reads as a rolling window (calendar events) as a snapshot: every entry in the window, in one or more batches that carry the same `snapshot.id`, which stamps each row they send. The last batch adds `snapshot.windows`, and the store then deletes the origin's rows of that type that lie strictly inside the window and were not sent by this snapshot. A row that only touches an edge stays. The device sends every entry that touches the window, edges included, so the commit never deletes one it still has.
- A run cut off before its last batch deletes nothing, and the rows it sent stay, stamped. The next commit cleans them up. A commit retried with the same `snapshot.id` changes nothing and answers the type in `committed` again. A batch of a snapshot read before the newest one the origin has sent for the type (`snapshot.readAt`, to the millisecond), or read at the same time under another id, changes nothing: its items are neither written nor stamped, and its window does not commit. So a late batch of an older run cannot bring back an event the phone removed. A window further back or ahead of `readAt` than the type reads, give or take two days, does not commit either. Nor does a type with a refused item in the same batch. The device leaves out the window of a type refused in an earlier batch.
- A snapshot may hold more rows than the type cap allows while it replaces the window: as many past it as the rows its commit may delete. So a calendar at the cap can still be replaced.
- A batch without `snapshot` applies its upserts and deletes as they are. An older app sends calendar events this way: what changed, and a delete for each event gone from the phone.

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

`committed` lists the types whose snapshot the batch committed, now or on an earlier try. It is absent when it committed none.

The ingest log keeps 90 days of rows with counts, ranges and codes, and never a value.

## Agent access

`core:personal_data_catalog` takes no input and lists each source and origin: its state, when it last synced, each type with its unit, range, count and `syncedThrough`, and its [live pointer](#live). `core:personal_data_query` aggregates or lists readings. Main reaches both through `actions: ["*"]`, and the Concierge lists both in `concierge.yaml`.

Any turn may call both: past [entry](domains/participation.md#entry) nothing asks who is asking.

## Live

The store points to where the rest can be read. It never says how to run the device, and it never chooses the device: it asks the [connection layer](domains/connections.md#device-connection) for the connection that reads the source live for this turn. That is the device the guardian is asking from, and only that device. Without one, it is a working connection whose device says it syncs to the source and reported in the last 7 days, the install that reports the origin holding the data first. A fresh connect before the first sync reads live at once.

When the stored data does not cover a query's window, the reply's `connection` names that device connection: its id, capability as `kind`, title, device id and name, state and `lastSeenAt`. With no connection, it says `not_connected`, with the connect card's `kind` when another device names it. The pointer carries a `next` step for the Agent to take in the same reply. A `working` connection answers from the store when it is under an hour behind, and otherwise reads the gap live now, never through a check scheduled for later, since the device is often in front just after it connects while a backfill is still landing. One that cannot (`off`, `broken` or `not_connected`) answers from the stored data, and offers the connect card or says what to turn on. The step rides on the reply so it does not depend on prompt prose alone. The catalog gives each source the same pointer without the step, and lists a source no device has synced yet when a connection says it syncs to it.

The agent reads the device with `system:run_on_device`, with the operation and arguments from `system:read_devices` ([device connection](domains/connections.md#device-connection)). When the device does not answer, or the connection is `off`, it answers from stored data and says how fresh it is. Live answers are never written to the store.

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
  "records": { "limit": 100, "cursor": null }, // one sample or record type: list instead of aggregate
  "search": "review"                           // entries only: words the content holds, any case
}
```

- An ISO time without an offset, and a date, are read in `timeZone`. A date as `end` means the end of that day. With no `start`, the window starts at the local midnight of the day that ends at `end`.
- A bucket is stored under its type, width and start, whatever key the device sends, and a delete of a bucket key is read the same way.
- `hour` reads hour buckets. When the window starts at a local midnight, `day` reads each day from the device's day bucket, else from the day's hours added up. When the device's buckets are in another zone than `timeZone`, every day is split by the device's dates and read as the day with the same date here, so no hour is dropped or counted twice, and the reply names that zone in `dayZones`. `freshness` still measures the window's end in `timeZone`, so the last device date may run past it. Otherwise it adds up hours. A device may keep only day buckets for older history. `week`, `month` and `total` roll up from days. Weeks start on Monday.
- A summed type adds up. An averaged type takes the mean of its daily averages, labelled `avg_of_days`, or of its hours, labelled `avg_of_hours`. `min` and `max` are the exact extremes. `latest` does not fit a summed type, and `sum` does not fit an averaged one.
- A sample or record belongs to the bucket it starts in. A night of sleep belongs to the day it ends on, as its key says. A record adds up what comes with it, such as minutes per sleep stage, and counts how many there were. An averaged record averages what comes with it too.
- A bucket with no value is left out, never 0.
- A batch that refuses a reading of a type does not mark that type synced.
- `latest` for a bucket type reads the last hour, not a day's average.
- A type of entries is always listed, one type per query, and takes no `interval`, `aggregate` or `unit`. It lists every entry that overlaps the window, such as a holiday that began before it, with its `key`, `startISO`, `endISO` and content.
- `freshness` says a type covers the window only when its earliest stored reading reaches back to the window's start and the device reports it synced up to the end. A query that reads only hours (`hour`, a window that starts mid-day, `latest`) reaches back only to `hourlyFrom`, the earliest hour bucket. Otherwise `missingFrom` says where coverage is not known.
- A type the device sends as a rolling snapshot, such as calendar events, covers only the window its last committed snapshot read, whatever older entries the store holds. Dates between two syncs far apart were never read, a date past the window's end was never sent, and an empty calendar the phone synced is covered. Before an origin's first commit, the span its type declares around the last sync (`syncedBackDays`, `syncedAheadDays`) stands in for the window.
- Each type is read from one origin. An origin whose committed snapshot holds the whole window comes first, an empty one too, and among those the one read last, by its snapshot or a later mark that found nothing new. After those comes one whose readings reach back to the window's start, and among those the one that reports the type synced furthest. When none reaches back, the one synced furthest answers. An origin set off is never read. A second device, or a new origin after a sign-in, takes over a window once its backfill reaches it.

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

- A turn that an action starts through a worker, such as `system:summon` or the reply to a channel message, takes the audience Rome read for the turn or chat that ran the action. Only a first-party action's chat is trusted for that, and only a first-party action passes it on, so a third-party action's turn is shared. Rome reads who sent a direct message from People itself, never from what the caller says. A session the turn opens gets the same value in its shell, but a session already live keeps the one it opened with.
- `system:run_on_device`, like its older name `core:device_run`, refuses an operation of a personal capability (one its device reports `personal`, such as Health) in a shared turn before it calls the device, with the same `personal_data_private_only`. A shell reaches a device through `rome-node device run`, which runs any capability in any chat.
- Any turn can send what it read elsewhere, with `send_message` or an email, including a Concierge turn woken by outside content, such as a mail it follows. Content that tells the agent to send Health data on can therefore reach it, and only the system prompt guards against that.
- The store lives in Rome's database, which an agent's shell can read.
- An installed app's page runs in the guardian's browser with their session, so it can call these routes as the guardian. No route returns a reading, but such a page can read the catalog and the ingest log, ingest, or delete an origin.
- What an agent already wrote into memory or a chat is not checked.
