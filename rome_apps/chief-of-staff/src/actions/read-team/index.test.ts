import { describe, expect, it } from "@rstest/core";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { createAction } from "./index.js";

const TABLE_PREFIX = "chief_of_staff";

function setup(seed: { roster?: string; goals?: string } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.exec(
    `CREATE TABLE ${TABLE_PREFIX}__documents (name TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
  );
  const insert = sqlite.prepare(
    `INSERT INTO ${TABLE_PREFIX}__documents (name, body, updated_at) VALUES (?, ?, ?)`,
  );
  if (seed.roster !== undefined) insert.run("roster", seed.roster, "2026-11-13T00:00:00.000Z");
  if (seed.goals !== undefined) insert.run("goals", seed.goals, "2026-11-13T00:00:00.000Z");
  const connection = drizzle(sqlite);
  const deps = {
    appContext: {
      db: {
        connection,
        tablePrefix: TABLE_PREFIX,
        tableName: (n: string) => `${TABLE_PREFIX}__${n}`,
      },
    },
  } as unknown as AppActionRuntimeDeps;
  const config = { tablePrefix: TABLE_PREFIX } as unknown as ActionConfig;
  return createAction(config, deps);
}

describe("read_team", () => {
  it("returns both documents, each named as a source", async () => {
    const action = setup({
      roster: "## Ada\nRole: engineer",
      goals: "## Ship it\nOwner: Ada",
    });
    const result = await action.execute({});
    expect(result.status).toBe("ok");
    const team = (result as { data: { team: string } }).data.team;
    expect(team).toContain("# Roster (source: the team roster)");
    expect(team).toContain("## Ada\nRole: engineer");
    expect(team).toContain("# Goals (source: the goals document)");
    expect(team).toContain("## Ship it\nOwner: Ada");
  });

  it("tells the agent a document is not set rather than leaving it blank", async () => {
    const action = setup({ roster: "## Ada" });
    const result = await action.execute({});
    const team = (result as { data: { team: string } }).data.team;
    expect(team).toContain("The goals document is not set yet");
    expect(team).toContain("Say you do not know the goals rather than guess");
  });
});
