import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");

/** Every migration journal in the repo: core's system migrations and each app's. */
function journals(): string[] {
  const apps = resolve(repo, "rome_apps");
  return [
    resolve(here, "../../drizzle/system/meta/_journal.json"),
    ...readdirSync(apps)
      .map((app) => resolve(apps, app, "src/db/migrations/meta/_journal.json"))
      .filter((path) => existsSync(path)),
  ];
}

describe("migration journals", () => {
  // Drizzle applies a migration only when its `when` is later than the last one
  // a database applied. A new entry stamped earlier than the one before it is
  // skipped on every existing database, while a fresh test database applies it.
  it("stamp every migration later than the one before it", () => {
    for (const path of journals()) {
      const { entries } = JSON.parse(readFileSync(path, "utf8")) as {
        entries: { tag: string; when: number }[];
      };
      const late = entries.filter((entry, i) => i > 0 && entry.when <= entries[i - 1]!.when);
      expect({ path: path.slice(repo.length + 1), late: late.map((e) => e.tag) }).toEqual({
        path: path.slice(repo.length + 1),
        late: [],
      });
    }
  });
});
