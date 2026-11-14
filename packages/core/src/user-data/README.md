# user-data

The store for the guardian's user data, such as Apple Health: what a device pushes, what Rome keeps, and how an agent reads it. Contracts: [docs/user-data.md](../../../../docs/user-data.md). Terms: [docs/concepts/data.md](../../../../docs/concepts/data.md#user-data).

It owns:

- `domain/`: the source and type table shape, the ingest checks, the query plan and rollups, and calendar arithmetic in a zone. Pure, with no database.
- `sources/`: each source's type table. `apple-health.ts` is the only Health-specific file in core, and it is data, not logic.
- `repository.ts`: the one way into the `user_data_*` tables.
- `read.ts`: a query answered from the repository, with freshness.
- `routes.ts`: `/api/user-data/*`, for the guardian's session only.
- `actions.ts`: `core:user_data_catalog` and `core:user_data_query`.

A source joins the store only when each item is a reading with a time range and a numeric value, and a query over a window aggregates them. Document data, such as calendar events, gets its own design.

The personal-data mark and the turn audience that guard the actions live outside this folder: `apps/actions/personal-data.ts` and `agent/domain/turn-audience.ts`.
