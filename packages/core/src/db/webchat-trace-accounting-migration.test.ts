import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

interface UsageTotals {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

type NullableUsageTotals = { [Key in keyof UsageTotals]: number | null };

function extractExpectedTotals(content: string): UsageTotals {
  const totals: UsageTotals = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const blocks = JSON.parse(content) as unknown[];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    if (type !== "result" && type !== "error") continue;
    const accounting = (block as { accounting?: unknown }).accounting;
    if (!accounting || typeof accounting !== "object") continue;
    const usage = (accounting as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") continue;
    totals.cacheReadTokens += Number((usage as { cacheReadTokens?: unknown }).cacheReadTokens ?? 0);
    totals.cacheWriteTokens += Number(
      (usage as { cacheWriteTokens?: unknown }).cacheWriteTokens ?? 0,
    );
    totals.inputTokens += Number((usage as { inputTokens?: unknown }).inputTokens ?? 0);
    totals.outputTokens += Number((usage as { outputTokens?: unknown }).outputTokens ?? 0);
    totals.costUsd += Number((accounting as { costUsd?: unknown }).costUsd ?? 0);
  }
  return totals;
}

function runMigration(sqlite: Database.Database) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(
    resolve(__dirname, "../../drizzle/system/0018_webchat_trace_accounting_columns.sql"),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
}

describe("0018_webchat_trace_accounting_columns migration", () => {
  it("backfills trace accounting columns to match JSON-walked totals", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE webchat_messages (
          id text PRIMARY KEY NOT NULL,
          session_id text NOT NULL,
          turn_id text,
          role text NOT NULL,
          content text NOT NULL,
          created_at integer NOT NULL
        );
      `);
      const traceContent = JSON.stringify([
        {
          type: "thinking",
          content: "ignored",
        },
        {
          type: "result",
          content: "done",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              inputTokens: 100,
              outputTokens: 20,
            },
            costUsd: 0.25,
          },
        },
        {
          type: "error",
          error: "subagent failed",
          accounting: {
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              cacheReadTokens: 2,
              cacheWriteTokens: 3,
              inputTokens: 40,
              outputTokens: 8,
            },
            costUsd: 0.07,
          },
        },
      ]);
      const expected = extractExpectedTotals(traceContent);

      sqlite
        .prepare(
          "INSERT INTO webchat_messages (id, session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("trace-1", "sess-1", null, "trace", traceContent, Date.now());
      sqlite
        .prepare(
          "INSERT INTO webchat_messages (id, session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("assistant-1", "sess-1", null, "assistant", "[]", Date.now());

      runMigration(sqlite);

      const row = sqlite
        .prepare(
          `
            SELECT
              input_tokens AS inputTokens,
              output_tokens AS outputTokens,
              cache_read_tokens AS cacheReadTokens,
              cache_write_tokens AS cacheWriteTokens,
              cost_usd AS costUsd
            FROM webchat_messages
            WHERE id = 'trace-1'
          `,
        )
        .get() as UsageTotals;
      expect(row).toEqual(expected);

      const assistantRow = sqlite
        .prepare(
          `
            SELECT
              input_tokens AS inputTokens,
              output_tokens AS outputTokens,
              cache_read_tokens AS cacheReadTokens,
              cache_write_tokens AS cacheWriteTokens,
              cost_usd AS costUsd
            FROM webchat_messages
            WHERE id = 'assistant-1'
          `,
        )
        .get() as NullableUsageTotals;
      expect(assistantRow).toEqual({
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      });
    } finally {
      sqlite.close();
    }
  });
});
