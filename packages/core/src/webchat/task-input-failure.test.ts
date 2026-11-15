import { expect, it } from "@rstest/core";
import { and, eq } from "drizzle-orm";
import { agentTurnMessages, romeAgentMessages } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { WebChatRepository } from "./repository.js";

for (const kind of ["legacy", "chats"] as const) {
  const makeRepo = (db: DrizzleDb) =>
    kind === "legacy" ? new WebChatRepository(db) : new ChatsWebChatRepository(db);
  for (const state of [
    "queued",
    "submitted",
    "accepted",
    "consumed",
    "unknown",
    "failed",
  ] as const) {
    it(`${kind}: only fails a queued input, preserving the ${state} state's turn link`, async () => {
      const testDb = createTestDb();
      const repo = makeRepo(testDb.db);
      try {
        await repo.createSession("synthetic-task", "Synthetic");
        await repo.recordUserInput("synthetic-input", "synthetic-task", "[]");
        await repo.updateUserInput("synthetic-task", {
          type: "input_status",
          inputId: "synthetic-input",
          state,
          turnId: "existing-turn",
        });
        await repo.failQueuedUserInput("synthetic-task", "synthetic-input");
        await repo.failQueuedUserInput("synthetic-task", "synthetic-input");
        expect(await repo.getUserInput("synthetic-task", "synthetic-input")).toEqual({
          inputState: state === "queued" ? "failed" : state,
          turnId: "existing-turn",
        });
      } finally {
        testDb.close();
      }
    });
  }

  it(`${kind}: does not create a missing input or change a different chat's input`, async () => {
    const testDb = createTestDb();
    const repo = makeRepo(testDb.db);
    try {
      await repo.createSession("synthetic-task", "Synthetic");
      await repo.createSession("other-task", "Other");
      await repo.recordUserInput("synthetic-input", "synthetic-task", "[]");
      await repo.failQueuedUserInput("other-task", "synthetic-input");
      await repo.failQueuedUserInput("synthetic-task", "absent");
      expect(await repo.getUserInput("synthetic-task", "synthetic-input")).toEqual({
        inputState: "queued",
        turnId: null,
      });
      expect(await repo.getUserInput("synthetic-task", "absent")).toBeUndefined();
    } finally {
      testDb.close();
    }
  });

  it(`${kind}: does not overwrite consumption after a stale queued read`, async () => {
    const testDb = createTestDb();
    const repo = makeRepo(testDb.db);
    try {
      await repo.createSession("synthetic-task", "Synthetic");
      await repo.recordUserInput("synthetic-input", "synthetic-task", "[]");
      expect((await repo.getUserInput("synthetic-task", "synthetic-input"))?.inputState).toBe(
        "queued",
      );
      await repo.updateUserInput("synthetic-task", {
        type: "input_status",
        inputId: "synthetic-input",
        state: "consumed",
        turnId: "existing-turn",
      });
      await repo.failQueuedUserInput("synthetic-task", "synthetic-input");
      expect(await repo.getUserInput("synthetic-task", "synthetic-input")).toEqual({
        inputState: "consumed",
        turnId: "existing-turn",
      });
    } finally {
      testDb.close();
    }
  });

  it(`${kind}: does not change an assistant message even if it has a queued state`, async () => {
    const testDb = createTestDb();
    const repo = makeRepo(testDb.db);
    try {
      await repo.createSession("synthetic-task", "Synthetic");
      await repo.addMessage(
        "synthetic-assistant",
        "synthetic-task",
        "assistant",
        "[]",
        "existing-turn",
      );
      if (kind === "legacy") {
        await testDb.db
          .update(romeAgentMessages)
          .set({ inputState: "queued" })
          .where(eq(romeAgentMessages.id, "synthetic-assistant"));
      } else {
        await testDb.db
          .update(agentTurnMessages)
          .set({ inputState: "queued" })
          .where(
            and(
              eq(agentTurnMessages.sessionId, "synthetic-task"),
              eq(agentTurnMessages.role, "answer"),
            ),
          );
      }
      await repo.failQueuedUserInput("synthetic-task", "synthetic-assistant");
      const row =
        kind === "legacy"
          ? await testDb.db
              .select({ state: romeAgentMessages.inputState })
              .from(romeAgentMessages)
              .where(eq(romeAgentMessages.id, "synthetic-assistant"))
              .get()
          : await testDb.db
              .select({ state: agentTurnMessages.inputState })
              .from(agentTurnMessages)
              .where(
                and(
                  eq(agentTurnMessages.sessionId, "synthetic-task"),
                  eq(agentTurnMessages.role, "answer"),
                ),
              )
              .get();
      expect(row?.state).toBe("queued");
    } finally {
      testDb.close();
    }
  });
}
