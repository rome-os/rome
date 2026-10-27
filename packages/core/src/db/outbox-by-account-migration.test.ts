import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const OUTBOX_BY_ACCOUNT = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../drizzle/system/0101_outbox_by_account.sql",
  ),
  "utf8",
);

const OPAQUE = "0b5c6d1e-9a8f-4c3b-8e2d-7f6a5b4c3d2e";

/** The tables the migration reads, as they stand before it, with Rome's
 *  Telegram account on an opaque channel and a signed-in WeChat account whose
 *  record knows none. */
function before(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE channels (
      id text PRIMARY KEY NOT NULL, connection_kind text NOT NULL, platform text NOT NULL,
      connection_id text, platform_account_id text, created_at integer NOT NULL, agent text
    );
    CREATE TABLE outbound_messages (
      id text PRIMARY KEY NOT NULL, channel text NOT NULL, channel_user_id text NOT NULL,
      chat_id text NOT NULL, text text NOT NULL, state text NOT NULL,
      provider_message_id text, error text, created_at integer NOT NULL,
      updated_at integer NOT NULL, from_channel text
    );
    CREATE INDEX idx_outbound_account ON outbound_messages (channel, channel_user_id);
    CREATE TABLE outbound_send_receipts (
      id text PRIMARY KEY NOT NULL, response text NOT NULL, expires_at integer NOT NULL
    );
    CREATE TABLE sentinel_log (
      id text PRIMARY KEY NOT NULL, message_id text NOT NULL, channel text NOT NULL,
      channel_user_id text NOT NULL, display_name text, thread_id text, text text,
      action text NOT NULL, response text, reviewed integer DEFAULT false,
      created_at integer NOT NULL
    );
    INSERT INTO channels (id, connection_kind, platform, connection_id, platform_account_id, created_at)
    VALUES
      ('${OPAQUE}', 'telegram', 'telegram', 'c-tg', 'tg-me', 1),
      ('wechat_user', 'wechat_user', 'wechat', 'c-wx', NULL, 1);
  `);
  return sqlite;
}

function migrate(sqlite: Database.Database): void {
  for (const statement of OUTBOX_BY_ACCOUNT.split("--> statement-breakpoint")) {
    sqlite.exec(statement);
  }
}

describe("the outbox by account migration", () => {
  it("names each row's account and Rome's account it went out from", () => {
    const sqlite = before();
    sqlite.exec(`
      INSERT INTO outbound_messages
        (id, channel, channel_user_id, chat_id, text, state, created_at, updated_at, from_channel)
      VALUES
        ('from-opaque', '${OPAQUE}', 'ada', 'ada', 'hi', 'failed', 1, 2, '${OPAQUE}'),
        ('unrecorded', 'telegram', 'ada', 'ada', 'hi', 'failed', 1, 2, NULL),
        ('no-account', 'wechat_user', 'wx-bob', 'wx-bob', 'hi', 'unconfirmed', 1, 2, 'wechat_user'),
        ('agents', 'agents', 'agent-1', 'agent-1', 'hi', 'sending', 1, 2, NULL);
    `);

    migrate(sqlite);

    expect(
      sqlite
        .prepare(
          "SELECT id, platform, account_id, channel, from_platform, from_account_id FROM outbound_messages ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "agents",
        platform: "agents",
        account_id: "agent-1",
        channel: "agents",
        from_platform: null,
        from_account_id: null,
      },
      {
        id: "from-opaque",
        platform: "telegram",
        account_id: "ada",
        channel: OPAQUE,
        from_platform: "telegram",
        from_account_id: "tg-me",
      },
      {
        id: "no-account",
        platform: "wechat",
        account_id: "wx-bob",
        channel: "wechat_user",
        from_platform: null,
        from_account_id: null,
      },
      // Written before rows recorded their sender, so it went out from the
      // service-named channel, which no record holds now.
      {
        id: "unrecorded",
        platform: "telegram",
        account_id: "ada",
        channel: "telegram",
        from_platform: null,
        from_account_id: null,
      },
    ]);
  });

  it("rewrites each receipt to what the wire answered for it", () => {
    const sqlite = before();
    const receipt = (id: string, response: Record<string, unknown>) =>
      sqlite
        .prepare("INSERT INTO outbound_send_receipts (id, response, expires_at) VALUES (?, ?, 1)")
        .run(id, JSON.stringify({ id, channelUserId: "ada", text: "hi", ...response }));
    receipt("from-opaque", { channel: OPAQUE, from: OPAQUE });
    receipt("from-unknown", { channel: "wechat_user", from: "wechat_user" });
    receipt("from-null", { channel: "telegram_user", from: null });
    receipt("no-from", { channel: "slack_bot" });

    migrate(sqlite);

    const responses = Object.fromEntries(
      (
        sqlite.prepare("SELECT id, response FROM outbound_send_receipts").all() as Array<{
          id: string;
          response: string;
        }>
      ).map((row) => [row.id, JSON.parse(row.response)]),
    );
    expect(responses["from-opaque"]).toMatchObject({
      channel: "telegram",
      from: { platform: "telegram", id: "tg-me" },
    });
    expect(responses["from-unknown"]).toMatchObject({ channel: "wechat", from: null });
    expect(responses["from-null"]).toMatchObject({ channel: "telegram", from: null });
    expect(responses["no-from"]).toEqual({
      id: "no-from",
      channelUserId: "ada",
      text: "hi",
      channel: "slack",
    });
  });

  it("gives each triage record its sender's platform and keeps its channel", () => {
    const sqlite = before();
    sqlite.exec(`
      INSERT INTO sentinel_log (id, message_id, channel, channel_user_id, action, created_at)
      VALUES
        ('s1', 'm1', '${OPAQUE}', 'ada', 'replied', 1),
        ('s2', 'm2', 'telegram_user', 'ada', 'ignored', 2),
        ('s3', 'm3', 'whatsapp', 'wa-1', 'escalated', 3);
    `);

    migrate(sqlite);

    expect(
      sqlite.prepare("SELECT id, channel, platform FROM sentinel_log ORDER BY id").all(),
    ).toEqual([
      { id: "s1", channel: OPAQUE, platform: "telegram" },
      { id: "s2", channel: "telegram_user", platform: "telegram" },
      { id: "s3", channel: "whatsapp", platform: "whatsapp" },
    ]);
  });
});
