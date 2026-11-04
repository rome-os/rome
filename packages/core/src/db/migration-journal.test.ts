import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const here = dirname(fileURLToPath(import.meta.url));
const JOURNAL = resolve(here, "../../drizzle/system/meta/_journal.json");
const APPS = resolve(here, "../../../../rome_apps");

/** The entries of a journal that are stamped no later than the one before them. */
function outOfOrder(path: string): string[] {
  const { entries } = JSON.parse(readFileSync(path, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  return entries.flatMap((entry, i) => {
    const before = entries[i - 1];
    return before && entry.when <= before.when ? [`${entry.tag} after ${before.tag}`] : [];
  });
}

describe("system migration journal", () => {
  // Drizzle's SQLite migrator applies only the migrations whose `when` is
  // later than the newest one a database has recorded. A migration stamped
  // earlier than one before it runs on a fresh database, so tests pass, and
  // is skipped on every database that already exists.
  it("stamps every migration later than the one before it", () => {
    expect(outOfOrder(JOURNAL)).toEqual([]);
  });

  it("holds for every app's journal too", () => {
    for (const app of readdirSync(APPS)) {
      const path = resolve(APPS, app, "src/db/migrations/meta/_journal.json");
      if (!existsSync(path)) continue;
      expect({ app, late: outOfOrder(path) }).toEqual({ app, late: [] });
    }
  });
});
