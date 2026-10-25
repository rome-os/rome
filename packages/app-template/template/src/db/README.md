# Database (optional)

This app ships with a Drizzle/SQLite database layer that is **disabled by default**.
The `db:` section in `app.yaml` is commented out, so the runtime won't allocate a
DB connection for this app until you opt in.

## Enable the DB

1. Uncomment the `db:` block in `app.yaml`:
   ```yaml
   db:
     migrations: db/migrations
     tablePrefix: __APP_TABLE_PREFIX__
   ```
2. Edit `src/db/schema.ts` to define your tables.
3. Generate migrations from the schema:
   ```bash
   pnpm db:generate
   ```
   This writes SQL files into `src/db/migrations/` (and a `meta/` snapshot).
   Migrations are applied automatically the next time the app boots.
4. Wire the repository into your action / API handler. Example:
   ```ts
   import { createHelloRepository } from "../db/repositories/hello.js";
   const repo = createHelloRepository(runtime.appContext.db);
   repo.recordGreeting("hello");
   ```

Re-run `pnpm db:generate` whenever you change `schema.ts` to produce a new
migration file. Never hand-edit existing migration SQL — add a new one.

## Disable / remove the DB

If your app doesn't need persistence, delete the DB scaffolding:

- Delete this directory: `src/db/`
- Delete `drizzle.config.ts` at the app root
- Remove the commented `db:` block from `app.yaml`
- Remove `drizzle-orm` and `drizzle-kit` from `package.json` (and the
  `db:generate` script)
- Remove any imports of `../db/repositories/...` from actions / API handlers

## Files in this directory

- `schema.ts` — Drizzle table definitions; `tablePrefix` keeps app tables
  namespaced inside the shared SQLite file.
- `repositories/hello.ts` — Example repository wrapping `schema.ts`. Copy this
  pattern for your own tables.
- `migrations/` — Generated SQL migrations. Don't edit by hand; regenerate via
  `pnpm db:generate`.
