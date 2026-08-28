import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { trace } from "@opentelemetry/api";
import { PolicyEngine, type PolicyContext } from "./policy-engine.js";
import { PoliciesRepository } from "../db/repositories/policies.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import type { PolicyRule, PolicyScope } from "../types.js";
import {
  createTestDb,
  installTestSpanHarness,
  type SpanHarness,
  type TestDb,
} from "../test/helpers.js";

// PolicyEngine over real repositories on in-memory SQLite (edge-only fakes,
// #763): policies and the trustedBondLevels setting are DB rows, so evaluate()
// runs against the same persistence — including the priority ordering
// findAll() applies — that the production engine reads.

function makeContext(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    channel: "telegram",
    sender: { id: "person-1", bondLevel: "acquaintance" },
    bondLevel: "acquaintance",
    ...overrides,
  };
}

describe("PolicyEngine", () => {
  let testDb: TestDb;
  let policiesRepo: PoliciesRepository;
  let settingsRepo: SettingsRepository;
  let engine: PolicyEngine;

  beforeEach(() => {
    testDb = createTestDb();
    policiesRepo = new PoliciesRepository(testDb.db);
    settingsRepo = new SettingsRepository(testDb.db);
    engine = new PolicyEngine(policiesRepo, settingsRepo);
  });

  afterEach(() => {
    testDb.close();
  });

  function seedPolicy(
    scope: PolicyScope,
    action: PolicyRule["action"],
    priority = 10,
  ): Promise<string> {
    return policiesRepo.create({ scope, rules: [{ action }], priority });
  }

  it("evaluate() matches sender-specific policy first", async () => {
    await seedPolicy({ type: "global" }, "block", 1);
    await seedPolicy({ type: "sender_specific", personId: "person-1" }, "allow", 100);

    const result = await engine.evaluate(makeContext());
    expect(result).toEqual({ action: "allow" });
  });

  it("evaluate() falls back to thread-specific policy", async () => {
    await seedPolicy({ type: "global" }, "block", 1);
    await seedPolicy({ type: "thread", threadName: "support", threadType: "group" }, "allow", 50);

    const result = await engine.evaluate(
      makeContext({
        sender: null,
        threadName: "support",
        threadType: "group",
      }),
    );
    expect(result).toEqual({ action: "allow" });
  });

  it("evaluate() falls back to sender-tier policy", async () => {
    await seedPolicy({ type: "global" }, "block", 1);
    await seedPolicy({ type: "sender", bondLevel: "acquaintance" }, "require_approval", 30);

    const result = await engine.evaluate(makeContext({ sender: null }));
    expect(result).toEqual({ action: "require_approval" });
  });

  it("evaluate() falls back to channel policy", async () => {
    await seedPolicy({ type: "channel", channel: "telegram" }, "sentinel_review", 20);

    const result = await engine.evaluate(makeContext({ sender: null, bondLevel: "other" }));
    expect(result).toEqual({ action: "sentinel_review" });
  });

  it("evaluate() falls back to global policy", async () => {
    await seedPolicy({ type: "global" }, "block", 1);

    const result = await engine.evaluate(makeContext({ sender: null, bondLevel: "other" }));
    expect(result).toEqual({ action: "block" });
  });

  it('evaluate() returns "allow" when no policies match and bond level is trusted', async () => {
    const result = await engine.evaluate(makeContext({ bondLevel: "guardian" }));
    expect(result).toEqual({ action: "allow" });
  });

  it('evaluate() defaults non-guardian bond levels to "sentinel_review"', async () => {
    const result = await engine.evaluate(makeContext({ bondLevel: "inner-circle" }));
    expect(result).toEqual({ action: "sentinel_review" });
  });

  it("evaluate() lets scope specificity beat higher-priority broader scopes", async () => {
    // The broader scopes carry the higher priorities, so findAll() returns
    // them first — only the scope-tier grouping can make sender_specific win.
    await seedPolicy({ type: "global" }, "sentinel_review", 100);
    await seedPolicy({ type: "channel", channel: "telegram" }, "block", 50);
    await seedPolicy({ type: "sender_specific", personId: "person-1" }, "allow", 1);

    const result = await engine.evaluate(makeContext());
    expect(result).toEqual({ action: "allow" });
  });

  it("evaluate() picks the higher-priority policy within the same scope", async () => {
    // Within one scope tier the engine takes the first match from findAll(),
    // which orders by priority descending — the low-priority row is inserted
    // first so only the repository's ordering can make the right policy win.
    await seedPolicy({ type: "global" }, "block", 1);
    await seedPolicy({ type: "global" }, "require_approval", 99);

    const result = await engine.evaluate(makeContext({ sender: null, bondLevel: "other" }));
    expect(result).toEqual({ action: "require_approval" });
  });

  it('evaluate() handles "block" action', async () => {
    await seedPolicy({ type: "global" }, "block");

    const result = await engine.evaluate(makeContext({ sender: null }));
    expect(result.action).toBe("block");
  });

  it('evaluate() handles "require_approval" action', async () => {
    await seedPolicy({ type: "global" }, "require_approval");

    const result = await engine.evaluate(makeContext({ sender: null }));
    expect(result.action).toBe("require_approval");
  });

  it('evaluate() handles "sentinel_review" action', async () => {
    // Default when untrusted and no policies
    const result = await engine.evaluate(makeContext({ bondLevel: "other" }));
    expect(result.action).toBe("sentinel_review");
  });

  it("evaluate() honors the trustedBondLevels setting on the default path", async () => {
    await settingsRepo.set("trustedBondLevels", ["other"]);

    expect(await engine.evaluate(makeContext({ bondLevel: "other" }))).toEqual({
      action: "allow",
    });
    // The stored setting replaces the built-in trusted list entirely.
    expect(await engine.evaluate(makeContext({ bondLevel: "acquaintance" }))).toEqual({
      action: "sentinel_review",
    });
  });

  // Policy decision span-event emission
  describe("policy.decision span event", () => {
    // `node` kind installs an AsyncHooks context manager so
    // `trace.getActiveSpan()` survives awaits inside `evaluate()`.
    let harness: SpanHarness;

    beforeEach(() => {
      harness = installTestSpanHarness("node");
    });

    afterEach(async () => {
      await harness.shutdown();
    });

    async function evaluateInsideSpan(context: PolicyContext): Promise<void> {
      const tracer = trace.getTracer("test");
      await tracer.startActiveSpan("parent", async (span) => {
        try {
          await engine.evaluate(context);
        } finally {
          span.end();
        }
      });
    }

    it("stamps decision + matched scope as a span event on the active span", async () => {
      await seedPolicy({ type: "global" }, "block");

      await evaluateInsideSpan(makeContext());

      const [parent] = await harness.finishedSpans();
      const event = parent.events.find((e) => e.name === "policy.decision");
      expect(event).toBeDefined();
      expect(event!.attributes?.["policy.decision"]).toBe("block");
      expect(event!.attributes?.["policy.matched_scope"]).toBe("global");
    });

    it("marks the default-path as matched_scope=default", async () => {
      await evaluateInsideSpan(makeContext({ bondLevel: "other" }));

      const [parent] = await harness.finishedSpans();
      const event = parent.events.find((e) => e.name === "policy.decision");
      expect(event!.attributes?.["policy.decision"]).toBe("sentinel_review");
      expect(event!.attributes?.["policy.matched_scope"]).toBe("default");
    });

    it("no-ops when evaluate runs outside any span (no crash)", async () => {
      const result = await engine.evaluate(makeContext());
      expect(result.action).toBe("sentinel_review"); // default trust is guardian-only.
      expect(await harness.finishedSpans()).toHaveLength(0);
    });
  });
});
