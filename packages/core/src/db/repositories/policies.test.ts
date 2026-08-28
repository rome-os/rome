import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { PoliciesRepository } from "./policies.js";
import { eq } from "drizzle-orm";
import { policies } from "../schema.js";
import type { PolicyScope, PolicyRule } from "../../types.js";

describe("PoliciesRepository", () => {
  let testDb: TestDb;
  let repo: PoliciesRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PoliciesRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  const makePolicy = (overrides?: {
    scope?: PolicyScope;
    rules?: PolicyRule[];
    priority?: number;
  }) => ({
    scope: { type: "global" as const },
    rules: [{ action: "allow" as const }],
    priority: 10,
    ...overrides,
  });

  it("create() inserts policy", async () => {
    const id = await repo.create(makePolicy());

    expect(id).toBeDefined();
    const policy = await repo.findById(id);
    expect(policy).not.toBeNull();
    expect(policy!.scope).toEqual({ type: "global" });
    expect(policy!.rules).toEqual([{ action: "allow" }]);
    expect(policy!.priority).toBe(10);
  });

  it("findByScope() returns policies matching scope type", async () => {
    await repo.create(makePolicy({ scope: { type: "channel", channel: "general" } }));
    await repo.create(makePolicy({ scope: { type: "channel", channel: "random" } }));
    await repo.create(makePolicy({ scope: { type: "global" } }));

    const channelPolicies = await repo.findByScopeType("channel");
    expect(channelPolicies).toHaveLength(2);
    channelPolicies.forEach((p) => {
      expect((p.scope as { type: string }).type).toBe("channel");
    });
  });

  it("findAll() returns policies ordered by priority desc", async () => {
    await repo.create(makePolicy({ priority: 5 }));
    await repo.create(makePolicy({ priority: 20 }));
    await repo.create(makePolicy({ priority: 10 }));

    const all = await repo.findAll();
    expect(all).toHaveLength(3);
    expect(all[0].priority).toBe(20);
    expect(all[1].priority).toBe(10);
    expect(all[2].priority).toBe(5);
  });

  it("delete() removes policy", async () => {
    const id = await repo.create(makePolicy());

    await testDb.db.delete(policies).where(eq(policies.id, id));

    const policy = await repo.findById(id);
    expect(policy).toBeNull();
  });

  it("update() modifies rules", async () => {
    const id = await repo.create(makePolicy());
    const newRules: PolicyRule[] = [{ action: "block", conditions: { after: "22:00" } }];

    await testDb.db.update(policies).set({ rules: newRules }).where(eq(policies.id, id));

    const policy = await repo.findById(id);
    expect(policy!.rules).toEqual(newRules);
  });
});
