import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const JOURNAL = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle/system/meta/_journal.json",
);

describe("system migration journal", () => {
  // Drizzle's SQLite migrator applies only the migrations whose `when` is
  // later than the newest one a database has recorded. A migration stamped
  // earlier than one before it runs on a fresh database, so tests pass, and
  // is skipped on every database that already exists.
  it("stamps every migration later than the one before it", () => {
    const { entries } = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const outOfOrder = entries.flatMap((entry, i) => {
      const before = entries[i - 1];
      return before && entry.when <= before.when ? [`${entry.tag} after ${before.tag}`] : [];
    });
    expect(outOfOrder).toEqual([]);
  });
});
