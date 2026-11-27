import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { trace } from "@opentelemetry/api";
import { matchingPolicy, type PolicyContext } from "./policy-engine.js";
import { PoliciesRepository } from "../../../db/repositories/policies.js";
import type { ConnectionKindOfChannel } from "../../../db/repositories/channel-records.js";
import type { PolicyRule, PolicyScope } from "../../../types.js";
import {
  createTestDb,
  installTestSpanHarness,
  type SpanHarness,
  type TestDb,
  identityConnectionKindOf,
} from "../../../test/helpers.js";

// matchingPolicy over real repositories on in-memory SQLite (edge-only fakes,
// #763): policies are DB rows, so the match runs against the same persistence,
// including the priority ordering findAll() applies, that the wake gate reads.

function makeContext(overrides?: Partial<PolicyContext>): PolicyContext {
  return { channel: "telegram", ...overrides };
}

// A later channel carries an opaque name.
const LATER_TELEGRAM = "9b2f4c1e-telegram-bot";

describe("matchingPolicy", () => {
  let testDb: TestDb;
  let policiesRepo: PoliciesRepository;
  let connectionKindOf: ConnectionKindOfChannel;

  beforeEach(() => {
    testDb = createTestDb();
    policiesRepo = new PoliciesRepository(testDb.db);
    connectionKindOf = identityConnectionKindOf;
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

  async function evaluate(context: PolicyContext): Promise<PolicyRule | null> {
    return matchingPolicy({ policies: await policiesRepo.findAll(), connectionKindOf }, context);
  }

  it("matches a thread policy before a global one", async () => {
    await seedPolicy({ type: "global" }, "block", 1);
    await seedPolicy({ type: "thread", threadName: "support", threadType: "group" }, "allow", 50);

    const result = await evaluate(makeContext({ threadName: "support", threadType: "group" }));
    expect(result).toEqual({ action: "allow" });
  });

  it("matches nothing an earlier release stored for a sender", async () => {
    await seedPolicy({ type: "global" }, "block", 1);
    const earlier = [
      { type: "sender", bondLevel: "acquaintance" },
      { type: "sender_specific", personId: "person-1" },
    ] as unknown as PolicyScope[];
    for (const scope of earlier) await seedPolicy(scope, "allow", 30);

    expect(await evaluate(makeContext())).toEqual({ action: "block" });
  });

  it("falls back to a channel policy", async () => {
    await seedPolicy({ type: "channel", channel: "telegram" }, "sentinel_review", 20);

    expect(await evaluate(makeContext())).toEqual({ action: "sentinel_review" });
  });

  it("applies a service's channel policy to its later channels", async () => {
    connectionKindOf = (name) => (name === LATER_TELEGRAM ? "telegram" : name);
    await seedPolicy({ type: "channel", channel: "telegram" }, "block", 20);

    const context = makeContext({ channel: LATER_TELEGRAM });
    expect(await evaluate(context)).toEqual({ action: "block" });

    await seedPolicy({ type: "channel", channel: LATER_TELEGRAM }, "sentinel_review", 10);
    expect(await evaluate(context)).toEqual({ action: "sentinel_review" });
  });

  it("falls back to a global policy", async () => {
    await seedPolicy({ type: "global" }, "block", 1);

    expect(await evaluate(makeContext())).toEqual({ action: "block" });
  });

  it("matches nothing when no policy is stored", async () => {
    expect(await evaluate(makeContext())).toBeNull();
  });

  it("lets scope specificity beat higher-priority broader scopes", async () => {
    // The broader scope carries the higher priority, so findAll() returns it
    // first; only the scope-tier grouping can make the channel policy win.
    await seedPolicy({ type: "global" }, "sentinel_review", 100);
    await seedPolicy({ type: "channel", channel: "telegram" }, "block", 50);

    expect(await evaluate(makeContext())).toEqual({ action: "block" });
  });

  it("picks the higher-priority policy within the same scope", async () => {
    // Within one scope tier the first match from findAll() wins, which orders
    // by priority descending. The low-priority row is inserted first so only
    // the repository's ordering can make the right policy win.
    await seedPolicy({ type: "global" }, "block", 1);
    await seedPolicy({ type: "global" }, "require_approval", 99);

    expect(await evaluate(makeContext())).toEqual({ action: "require_approval" });
  });

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
          await evaluate(context);
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

    it("no-ops when evaluated outside any span (no crash)", async () => {
      await seedPolicy({ type: "global" }, "block");
      expect(await evaluate(makeContext())).toEqual({ action: "block" });
      expect(await harness.finishedSpans()).toHaveLength(0);
    });
  });
});
