import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { SessionQueryRepository } from "./session-query.js";

describe("SessionQueryRepository", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it("uses the bounded message scan and partial trace indexes for run aggregation", () => {
    const sqlite = (
      testDb.db as unknown as {
        $client: {
          prepare(sql: string): { all(...values: unknown[]): Array<{ detail: string }> };
        };
      }
    ).$client;
    const plan = sqlite
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT messages.session_id,
               json_extract(terminal.content, '$.accounting.model'),
               json_extract(turn_end.content, '$.status')
        FROM rome_agent_messages AS messages
        LEFT JOIN rome_agent_trace_blocks AS terminal
          ON terminal.message_id = messages.id
         AND json_extract(terminal.content, '$.type') IN ('result', 'error')
        LEFT JOIN rome_agent_trace_blocks AS turn_end
          ON turn_end.message_id = messages.id
         AND json_extract(turn_end.content, '$.type') = 'turn_end'
        WHERE messages.role = 'trace'
          AND messages.turn_id IS NOT NULL
          AND messages.created_at >= ?
          AND messages.created_at <= ?
      `)
      .all(0, 4_000_000_000);
    const details = plan.map((row) => row.detail).join("\n");

    expect(details).toContain("idx_rome_agent_messages_role_created_at");
    expect(details).toContain("idx_rome_agent_trace_blocks_terminal_message");
    expect(details).toContain("idx_rome_agent_trace_blocks_turn_end_message");
  });

  it("returns no aggregates when the structured scope has no allowed sessions", async () => {
    const repository = new SessionQueryRepository(testDb.db);

    await expect(
      repository.queryRunAggregates({
        from: null,
        to: new Date("2026-07-15T12:00:00.000Z"),
        sessionIds: [],
      }),
    ).resolves.toEqual([]);
  });
});
