import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const CHANNEL_RECORDS = readFileSync(migrationPath("0080_channel_records.sql"), "utf8");
const LARK_PLATFORM = readFileSync(migrationPath("0083_lark_is_its_own_platform.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

describe("lark is its own platform migration", () => {
  it("moves a Feishu channel to lark only when its app grant names the Lark domain", () => {
    const sqlite = new Database(":memory:");
    run(sqlite, CHANNEL_RECORDS);
    sqlite.exec(
      "CREATE TABLE connection_grants (custody text NOT NULL, name text NOT NULL, state text NOT NULL, credential text, profile text, PRIMARY KEY(custody, name))",
    );
    const channel = sqlite.prepare(
      "INSERT INTO channels (id, service, platform, connection_id, created_at) VALUES (?, ?, ?, ?, 0)",
    );
    const grant = sqlite.prepare(
      "INSERT INTO connection_grants (custody, name, state, credential, profile) VALUES (?, ?, 'authorized', ?, ?)",
    );
    const material = (domain: string) =>
      JSON.stringify({ material: { kind: "inline", record: { appId: "a", domain } } });
    const profile = (domain: string) => JSON.stringify({ appId: "a", domain });

    channel.run("feishu", "feishu", "feishu", "c1");
    grant.run("c1", "app", material("feishu"), profile("feishu"));
    channel.run("lark-app", "feishu", "feishu", "c2");
    grant.run("c2", "app", material("lark"), profile("lark"));
    // A grant from before profiles names its domain only in its material.
    channel.run("bridge-lark", "feishu", "feishu", "c3");
    grant.run("c3", "app", material("lark"), null);
    channel.run("gone", "feishu", "feishu", null);
    channel.run("telegram", "telegram", "telegram", "c4");
    grant.run("c4", "app", null, profile("lark"));

    run(sqlite, LARK_PLATFORM);

    const platforms = Object.fromEntries(
      (
        sqlite.prepare("SELECT id, platform FROM channels").all() as {
          id: string;
          platform: string;
        }[]
      ).map((row) => [row.id, row.platform]),
    );
    expect(platforms).toEqual({
      feishu: "feishu",
      "lark-app": "lark",
      "bridge-lark": "lark",
      gone: "feishu",
      telegram: "telegram",
    });
  });
});
