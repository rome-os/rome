import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { ExecutionJournalRepository } from "./execution-journal.js";
import { executionJournal } from "../schema.js";
import type { JournalEntry } from "../../actions/replay.js";

describe("ExecutionJournalRepository", () => {
  let testDb: TestDb;
  let repo: ExecutionJournalRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ExecutionJournalRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  // saveJournal
  describe("saveJournal", () => {
    it("inserts journal entries into the database", async () => {
      const entries: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "action_a",
          argsHash: "hash-a",
          args: { key: "val" },
          result: { status: "ok", data: "result-a" },
          status: "completed",
        },
        {
          sequence: 1,
          actionName: "action_b",
          argsHash: "hash-b",
          args: { key2: "val2" },
          result: null,
          status: "pending_approval",
        },
      ];

      await repo.saveJournal("exec-1", entries);

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded).toHaveLength(2);
      expect(loaded[0].actionName).toBe("action_a");
      expect(loaded[1].actionName).toBe("action_b");
    });

    it("handles empty entries array (no-op)", async () => {
      await repo.saveJournal("exec-1", []);
      const loaded = await repo.loadJournal("exec-1");
      expect(loaded).toHaveLength(0);
    });

    it("stores args and result as JSON", async () => {
      const complexArgs = { nested: { deep: true }, array: [1, 2, 3] };
      const complexResult = { status: "ok" as const, data: { items: ["a", "b"] } };

      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "test",
          argsHash: "hash",
          args: complexArgs,
          result: complexResult,
          status: "completed",
        },
      ]);

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded[0].args).toEqual(complexArgs);
      expect(loaded[0].result).toEqual(complexResult);
    });

    it("stores divergence fields (expected and actual)", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "actual_action",
          argsHash: "actual-hash",
          args: {},
          result: null,
          status: "diverged",
          expectedActionName: "expected_action",
          expectedArgsHash: "expected-hash",
          actualActionName: "actual_action",
          actualArgsHash: "actual-hash",
        },
      ]);

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded[0].status).toBe("diverged");
      expect(loaded[0].expectedActionName).toBe("expected_action");
      expect(loaded[0].expectedArgsHash).toBe("expected-hash");
      expect(loaded[0].actualActionName).toBe("actual_action");
      expect(loaded[0].actualArgsHash).toBe("actual-hash");
    });
  });

  // loadJournal
  describe("loadJournal", () => {
    it("loads and sorts entries by sequence", async () => {
      // Insert out of order
      await repo.saveJournal("exec-1", [
        {
          sequence: 2,
          actionName: "c",
          argsHash: "hc",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
        {
          sequence: 0,
          actionName: "a",
          argsHash: "ha",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
        {
          sequence: 1,
          actionName: "b",
          argsHash: "hb",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ]);

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded.map((e) => e.actionName)).toEqual(["a", "b", "c"]);
      expect(loaded.map((e) => e.sequence)).toEqual([0, 1, 2]);
    });

    it("returns empty array for non-existent rootExecutionId", async () => {
      const loaded = await repo.loadJournal("does-not-exist");
      expect(loaded).toEqual([]);
    });

    it("maps DB rows back to JournalEntry shape correctly", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "test_action",
          argsHash: "test-hash",
          args: { key: "value" },
          result: { status: "ok", data: 42 },
          status: "completed",
        },
      ]);

      const loaded = await repo.loadJournal("exec-1");
      const entry = loaded[0];

      expect(entry).toEqual({
        sequence: 0,
        actionName: "test_action",
        argsHash: "test-hash",
        args: { key: "value" },
        result: { status: "ok", data: 42 },
        status: "completed",
        expectedActionName: undefined,
        expectedArgsHash: undefined,
        actualActionName: undefined,
        actualArgsHash: undefined,
      });
    });
  });

  // updateEntry
  describe("updateEntry", () => {
    it("updates result and status for a specific entry", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "test",
          argsHash: "hash",
          args: {},
          result: null,
          status: "pending_approval",
        },
      ]);

      await repo.updateEntry("exec-1", 0, { status: "ok", data: "done" }, "completed");

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded[0].status).toBe("completed");
      expect(loaded[0].result).toEqual({ status: "ok", data: "done" });
    });

    it("no-ops when entry not found (no error)", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "test",
          argsHash: "hash",
          args: {},
          result: null,
          status: "pending_approval",
        },
      ]);

      await expect(
        repo.updateEntry("exec-1", 99, { status: "ok" }, "completed"),
      ).resolves.toBeUndefined();

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded[0].status).toBe("pending_approval");
    });
  });

  // deleteJournal
  describe("deleteJournal", () => {
    it("deletes all entries for a rootExecutionId", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "a",
          argsHash: "ha",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
        {
          sequence: 1,
          actionName: "b",
          argsHash: "hb",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ]);

      await repo.deleteJournal("exec-1");

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded).toHaveLength(0);
    });

    it("does not affect entries for other rootExecutionIds", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "a",
          argsHash: "ha",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ]);
      await repo.saveJournal("exec-2", [
        {
          sequence: 0,
          actionName: "b",
          argsHash: "hb",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ]);

      await repo.deleteJournal("exec-1");

      const loaded1 = await repo.loadJournal("exec-1");
      const loaded2 = await repo.loadJournal("exec-2");
      expect(loaded1).toHaveLength(0);
      expect(loaded2).toHaveLength(1);
    });
  });

  // deleteOlderThan
  describe("deleteOlderThan", () => {
    it("deletes entries older than cutoff and keeps recent ones", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * 86400000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 86400000);
      const cutoff = new Date(now.getTime() - 7 * 86400000);

      // Insert directly to control createdAt timestamps
      await testDb.db.insert(executionJournal).values([
        {
          id: "old-entry",
          rootExecutionId: "exec-old",
          sequence: 0,
          actionName: "old_action",
          argsHash: "hash-old",
          args: {},
          result: { status: "ok" },
          status: "completed",
          createdAt: tenDaysAgo,
        },
        {
          id: "recent-entry",
          rootExecutionId: "exec-recent",
          sequence: 0,
          actionName: "recent_action",
          argsHash: "hash-recent",
          args: {},
          result: { status: "ok" },
          status: "completed",
          createdAt: twoDaysAgo,
        },
      ]);

      await repo.deleteOlderThan(cutoff);

      const old = await repo.loadJournal("exec-old");
      const recent = await repo.loadJournal("exec-recent");
      expect(old).toHaveLength(0);
      expect(recent).toHaveLength(1);
    });

    it("no-ops when no entries are older than cutoff", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "test",
          argsHash: "hash",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ]);

      // Cutoff far in the past — nothing should be deleted
      const cutoff = new Date(0);
      await repo.deleteOlderThan(cutoff);

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded).toHaveLength(1);
    });

    it("deletes all entries when cutoff is in the future", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "a",
          argsHash: "ha",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
        {
          sequence: 1,
          actionName: "b",
          argsHash: "hb",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ]);

      const future = new Date(Date.now() + 86400000);
      await repo.deleteOlderThan(future);

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded).toHaveLength(0);
    });

    it("preserves old journals whose rootExecutionId is in excludeRootIds", async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      await testDb.db.insert(executionJournal).values([
        {
          id: "ancient-protected",
          rootExecutionId: "exec-protected",
          sequence: 0,
          actionName: "pending_action",
          argsHash: "hash-protected",
          args: {},
          result: null,
          status: "pending_approval",
          createdAt: thirtyDaysAgo,
        },
        {
          id: "ancient-unprotected",
          rootExecutionId: "exec-unprotected",
          sequence: 0,
          actionName: "old_action",
          argsHash: "hash-unprotected",
          args: {},
          result: { status: "ok" },
          status: "completed",
          createdAt: thirtyDaysAgo,
        },
      ]);

      const cutoff = new Date(Date.now() + 86400000);
      await repo.deleteOlderThan(cutoff, ["exec-protected"]);

      const protectedJournal = await repo.loadJournal("exec-protected");
      const unprotectedJournal = await repo.loadJournal("exec-unprotected");
      expect(protectedJournal).toHaveLength(1);
      expect(unprotectedJournal).toHaveLength(0);
    });

    it("ignores empty excludeRootIds and deletes everything older than cutoff", async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      await testDb.db.insert(executionJournal).values([
        {
          id: "old-1",
          rootExecutionId: "exec-old-1",
          sequence: 0,
          actionName: "a",
          argsHash: "h1",
          args: {},
          result: { status: "ok" },
          status: "completed",
          createdAt: thirtyDaysAgo,
        },
      ]);

      const cutoff = new Date(Date.now() + 86400000);
      await repo.deleteOlderThan(cutoff, []);

      const loaded = await repo.loadJournal("exec-old-1");
      expect(loaded).toHaveLength(0);
    });
  });

  // round-trip
  describe("round-trip", () => {
    it("save → load returns equivalent entries", async () => {
      const entries: JournalEntry[] = [
        {
          sequence: 0,
          actionName: "action_a",
          argsHash: "hash-a",
          args: { key: "value", nested: { deep: true } },
          result: { status: "ok", data: [1, 2, 3] },
          status: "completed",
        },
        {
          sequence: 1,
          actionName: "action_b",
          argsHash: "hash-b",
          args: {},
          result: null,
          status: "pending_approval",
        },
      ];

      await repo.saveJournal("exec-1", entries);
      const loaded = await repo.loadJournal("exec-1");

      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({
        sequence: 0,
        actionName: "action_a",
        argsHash: "hash-a",
        args: { key: "value", nested: { deep: true } },
        result: { status: "ok", data: [1, 2, 3] },
        status: "completed",
      });
      expect(loaded[1]).toMatchObject({
        sequence: 1,
        actionName: "action_b",
        argsHash: "hash-b",
        args: {},
        result: null,
        status: "pending_approval",
      });
    });

    it("save → update → load reflects updated entry", async () => {
      await repo.saveJournal("exec-1", [
        {
          sequence: 0,
          actionName: "test",
          argsHash: "hash",
          args: { x: 1 },
          result: null,
          status: "pending_approval",
        },
      ]);

      await repo.updateEntry("exec-1", 0, { status: "ok", data: "executed" }, "completed");

      const loaded = await repo.loadJournal("exec-1");
      expect(loaded[0].status).toBe("completed");
      expect(loaded[0].result).toEqual({ status: "ok", data: "executed" });
    });
  });
});
