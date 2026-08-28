/**
 * End-to-end coverage for the approval flow.
 *
 * Wires real DB-backed repos + ActionEngine + ApprovalHandler with mock
 * channel adapter + mock agent runner. Behaviors numbered 1-N below match the
 * historical BRS at d6807982:docs/specs/approval-flow-brs.md; unimplemented
 * cases (4, 5) are kept as it.skip so the gap stays visible without falsely
 * passing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "@rstest/core";
import { ActionEngine, type ApprovalCreatedEvent } from "./engine.js";
import { ActionRegistryImpl } from "./registry.js";
import { ApprovalHandler } from "./approval-handler.js";
import { createBackendTurnRunner } from "./backend-turn.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import { ExecutionJournalRepository } from "../db/repositories/execution-journal.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import {
  createTestDb,
  buildTestDeps,
  MockProviderAdapter,
  createMockAgentRunner,
} from "../test/helpers.js";
import { buildApp } from "../api/index.js";
import type { Action, ActionConfig, ActionResult } from "./types.js";
import type { OutgoingMessage } from "../types.js";
import type { ThreadContext } from "../core/types.js";

// Test scaffolding

const baseConfig: Omit<ActionConfig, "name"> = {
  type: "system",
  description: "test action",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
};

function makeAction(
  name: string,
  overrides: Partial<ActionConfig> & {
    execute?: Action["execute"];
    preview?: Action["preview"];
  } = {},
): Action & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const execute =
    overrides.execute ??
    (async (args: Record<string, unknown>): Promise<ActionResult> => {
      calls.push(args);
      return { status: "ok", data: { ran: name, args } };
    });
  const { execute: _e, preview, ...configOverrides } = overrides;
  return {
    config: { ...baseConfig, name, ...configOverrides },
    calls,
    execute,
    preview,
  };
}

function buildHarness() {
  const testDb = createTestDb();
  const approvalsRepo = new ApprovalsRepository(testDb.db);
  const journalRepo = new ExecutionJournalRepository(testDb.db);
  const executionsRepo = new ActionExecutionsRepository(testDb.db);

  const registry = new ActionRegistryImpl([]);
  const channel = new MockProviderAdapter("webchat");
  const cardEmissions: ApprovalCreatedEvent[] = [];

  const engine = new ActionEngine(registry, undefined, executionsRepo, approvalsRepo, journalRepo, {
    // "worker" keeps everything in-process so the test's in-memory action
    // registry is visible to root invocations (no child fork).
    processRole: "worker",
    onApprovalCreated: async (event) => {
      cardEmissions.push(event);
      if (!event.channelContext) return;
      const msg: OutgoingMessage = {
        parts: [
          {
            type: "approval_card",
            approvalId: event.approvalId,
            actionName: event.actionName,
            preview: event.preview ?? {
              kind: "generic",
              title: event.actionName,
              summary: "Awaiting guardian approval",
            },
            status: "pending",
          },
        ],
      };
      await channel.sendMessage(
        event.channelContext.channelUserId ?? event.channelContext.threadId,
        event.channelContext.threadId,
        msg,
      );
    },
  });

  const agentRunner = createMockAgentRunner();
  // No webchat runtime is wired here (BRS 7 exercises the degrade path), so the
  // orchestrator runs backend session tasks bare — same as the old no-streamHost.
  const backendTurnRunner = createBackendTurnRunner({
    agentRunner,
    talkRouter: {
      list: async () => [],
      subscribe: () => () => {},
      send: async () => {
        throw new Error("Talk is unavailable in this test");
      },
      feature: () => null,
    },
  });
  const handler = new ApprovalHandler(
    approvalsRepo,
    journalRepo,
    engine,
    agentRunner,
    backendTurnRunner,
  );

  return {
    testDb,
    approvalsRepo,
    journalRepo,
    executionsRepo,
    registry,
    engine,
    handler,
    channel,
    agentRunner,
    cardEmissions,
  };
}

const guardianContext: ThreadContext = {
  channel: "webchat",
  channelUserId: "guardian-user",
  threadId: "thread-A",
};

// BRS 1 — sensitive action triggers a pending approval card

describe("Approval flow E2E — triggering an approval", () => {
  it("BRS 1 (root): sensitive root call creates pending approval and posts card to originating channel", async () => {
    const h = buildHarness();
    h.registry.register(
      makeAction("send_sensitive_demo", {
        requiresApproval: true,
        preview: (args) => ({
          kind: "sensitive_message",
          channel: String(args.channel ?? "webchat"),
          threadId: String(args.threadId ?? "thread-A"),
          text: String(args.text ?? ""),
        }),
      }),
    );

    const result = await h.engine.run(
      "send_sensitive_demo",
      { channel: "webchat", threadId: "thread-A", text: "hi guardian" },
      {
        channelContext: guardianContext,
        sessionId: "sess-1",
        agentName: "main",
        channelThreadKey: "webchat:thread-A",
      },
    );

    if (result.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${result.status}`);
    }

    const approvalId = result.approval.approvalId;
    const approval = await h.approvalsRepo.findById(approvalId);
    expect(approval?.status).toBe("pending");
    expect(approval?.type).toBe("action_execution");

    expect(h.cardEmissions).toHaveLength(1);
    expect(h.channel.sentMessages).toHaveLength(1);
    const card = h.channel.sentMessages[0]!.message.parts?.[0];
    expect(card?.type).toBe("approval_card");
    if (card?.type === "approval_card") {
      expect(card.approvalId).toBe(approvalId);
      expect(card.status).toBe("pending");
      expect(card.preview.kind).toBe("sensitive_message");
    }

    h.testDb.close();
  });

  it("BRS 1 (nested): sensitive action invoked inside another action still creates an approval", async () => {
    const h = buildHarness();
    let nestedTriggered = false;

    const sensitive = makeAction("nested_sensitive", {
      requiresApproval: true,
      preview: (args) => ({
        kind: "generic",
        title: "Nested sensitive",
        summary: String(args.summary ?? ""),
      }),
    });
    h.registry.register(sensitive);

    h.registry.register(
      makeAction("parent_action", {
        execute: async (): Promise<ActionResult> => {
          nestedTriggered = true;
          // Nest the sensitive action inside the parent. The engine should
          // surface the pending approval out through the root result.
          await h.engine.run("nested_sensitive", { summary: "from parent" });
          return { status: "ok" };
        },
      }),
    );

    const result = await h.engine.run(
      "parent_action",
      {},
      { channelContext: guardianContext, sessionId: "sess-2", agentName: "main" },
    );

    expect(nestedTriggered).toBe(true);
    if (result.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${result.status}`);
    }
    const approvalId = result.approval.approvalId;
    const approval = await h.approvalsRepo.findById(approvalId);
    expect(approval?.status).toBe("pending");
    expect(h.cardEmissions).toHaveLength(1);
    h.testDb.close();
  });

  it("BRS 6: two pending approvals coexist and are addressable independently", async () => {
    const h = buildHarness();
    h.registry.register(
      makeAction("a_demo", {
        requiresApproval: true,
        preview: (args) => ({
          kind: "generic",
          title: String(args.title ?? "demo"),
          summary: "summary",
        }),
      }),
    );

    const r1 = await h.engine.run(
      "a_demo",
      { title: "first" },
      { channelContext: guardianContext },
    );
    const r2 = await h.engine.run(
      "a_demo",
      { title: "second" },
      { channelContext: { ...guardianContext, threadId: "thread-B" } },
    );

    if (r1.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${r1.status}`);
    }
    if (r2.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${r2.status}`);
    }
    expect(r1.approval.approvalId).not.toBe(r2.approval.approvalId);
    const pending = await h.approvalsRepo.findPending();
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(h.channel.sentMessages.map((m) => m.threadId)).toEqual(["thread-A", "thread-B"]);

    h.testDb.close();
  });
});

// BRS 7–11 — resolving an approval

describe("Approval flow E2E — resolving an approval", () => {
  it("BRS 7: approve resumes the agent session and runs the action with the approved payload", async () => {
    const h = buildHarness();
    const action = makeAction("approve_demo", {
      requiresApproval: true,
      preview: (args) => ({
        kind: "generic",
        title: "Demo",
        summary: String(args.note ?? ""),
      }),
    });
    h.registry.register(action);

    const r = await h.engine.run(
      "approve_demo",
      { note: "looks good" },
      {
        channelContext: guardianContext,
        sessionId: "sess-approve",
        agentName: "main",
        channelThreadKey: "webchat:thread-A",
      },
    );
    if (r.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${r.status}`);
    }
    const approvalId = r.approval.approvalId;
    await h.approvalsRepo.resolvePending(approvalId, "approve");

    await h.handler.onApproved(approvalId);

    expect(action.calls).toHaveLength(1);
    expect(action.calls[0]).toEqual({ note: "looks good" });

    const after = await h.approvalsRepo.findById(approvalId);
    expect(after?.executedAt).not.toBeNull();

    expect(h.agentRunner.calls).toHaveLength(1);
    expect(h.agentRunner.calls[0]!.sessionId).toBe("sess-approve");
    expect(h.agentRunner.calls[0]!.prompt).toContain("approved and executed");

    h.testDb.close();
  });

  it("BRS 7 (webchat delivery): approving a webchat action over HTTP delivers the agent's reply to the chat — pushed live and durable", async () => {
    // Black-box through the real surface: the full API app (buildApp wires the
    // approval handler to the webchat runtime via setStreamHost, so a
    // regression that drops that wiring fails here), driven over HTTP. The
    // guardian approves via POST /api/approvals/:id/approve and the view
    // observes via the same endpoints the browser uses — the SSE events
    // stream and the messages endpoint. Only the agent model is mocked.
    const prevRoot = process.env.ROME_PROJECTS_ROOT;
    const projectsRoot = mkdtempSync(join(tmpdir(), "rome-approval-e2e-"));
    process.env.ROME_PROJECTS_ROOT = projectsRoot;
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);

      // Compose the approval handler the way the daemon does (its own engine +
      // registry over the shared DB, a mocked agent), then hand it to buildApp.
      // We deliberately do NOT call setStreamHost here — buildApp does, and
      // that is the wiring under test.
      const registry = new ActionRegistryImpl([]);
      const engine = new ActionEngine(
        registry,
        undefined,
        deps.actionExecutionsRepo,
        deps.approvalsRepo,
        deps.executionJournalRepo,
        { processRole: "worker" },
      );
      const agentRunner = createMockAgentRunner([
        [{ type: "result", content: "Done — I sent the message." }],
      ]);
      deps.actionEngine = engine;
      // Reuse the deps' orchestrator — buildApp binds the live webchat runtime
      // onto it (the wiring under test); the continuation runs on the mock above.
      deps.approvalHandler = new ApprovalHandler(
        deps.approvalsRepo,
        deps.executionJournalRepo,
        engine,
        agentRunner,
        deps.backendTurnRunner,
      );

      const { app } = buildApp(deps, { port: 0, host: "127.0.0.1" });

      const sessionId = "thread-webchat-delivery";
      await deps.webchatRepo.createSession(sessionId, "Delivery");
      registry.register(
        makeAction("send_sensitive_demo", {
          requiresApproval: true,
          preview: () => ({ kind: "generic", title: "demo", summary: "x" }),
        }),
      );

      // Arrange: a sensitive action ran in this webchat session and is now
      // awaiting guardian approval. This seeds the precondition that in
      // production an agent's gated tool call creates; we invoke the action
      // directly only because the mocked agent never reaches the engine. The
      // approval row it writes is real and DB-backed — everything the test
      // then acts on and observes goes over HTTP.
      await engine.run(
        "send_sensitive_demo",
        { text: "hi guardian" },
        {
          channelContext: { channel: "webchat", channelUserId: "guardian", threadId: sessionId },
          sessionId,
          agentName: "main",
          channelThreadKey: `webchat:${sessionId}`,
        },
      );

      // Discover the pending approval the way the guardian's activity page does
      // — over HTTP — instead of peeking at the engine's in-process return.
      const pendingRes = await app.request(`/api/approvals?status=pending`);
      expect(pendingRes.status).toBe(200);
      const pending = (await pendingRes.json()) as Array<{ id: string; status: string }>;
      expect(pending).toHaveLength(1);
      const approvalId = pending[0]!.id;

      // The guardian's open session view subscribes to the live event stream.
      const events = await app.request(`/api/chat/sessions/${sessionId}/events`);
      expect(events.status).toBe(200);
      const reader = events.body!.getReader();
      const pendingRead = reader.read();

      // Act: the guardian approves over HTTP.
      const approveRes = await app.request(`/api/approvals/${approvalId}/approve`, {
        method: "POST",
      });
      expect(approveRes.status).toBe(202);

      // Observe (live): the reply is pushed to the open view with no reload.
      const chunk = await pendingRead;
      expect(chunk.done).toBe(false);
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("event: message_insert");
      expect(text).toContain("Done — I sent the message.");
      await reader.cancel();

      // Observe (durable): the reply is in the session's message history.
      const msgsRes = await app.request(`/api/chat/sessions/${sessionId}/messages`);
      expect(msgsRes.status).toBe(200);
      const msgs = (await msgsRes.json()) as Array<{ role: string; content: string }>;
      const replies = msgs.filter(
        (m) => m.role === "assistant" && m.content.includes("Done — I sent the message."),
      );
      expect(replies).toHaveLength(1);
    } finally {
      testDb.close();
      rmSync(projectsRoot, { recursive: true, force: true });
      if (prevRoot === undefined) delete process.env.ROME_PROJECTS_ROOT;
      else process.env.ROME_PROJECTS_ROOT = prevRoot;
    }
  });

  it("BRS 9: reject drops the action and resumes the session with a rejection prompt (no exception)", async () => {
    const h = buildHarness();
    const action = makeAction("reject_demo", {
      requiresApproval: true,
      preview: () => ({ kind: "generic", title: "demo", summary: "x" }),
    });
    h.registry.register(action);

    const r = await h.engine.run(
      "reject_demo",
      {},
      {
        channelContext: guardianContext,
        sessionId: "sess-reject",
        agentName: "main",
        channelThreadKey: "webchat:thread-A",
      },
    );
    if (r.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${r.status}`);
    }
    const approvalId = r.approval.approvalId;
    await h.approvalsRepo.reject(approvalId);

    await expect(h.handler.onRejected(approvalId)).resolves.toBeUndefined();

    expect(action.calls).toHaveLength(0);
    expect(h.agentRunner.calls).toHaveLength(1);
    expect(h.agentRunner.calls[0]!.sessionId).toBe("sess-reject");
    expect(h.agentRunner.calls[0]!.prompt).toMatch(/rejected/i);

    h.testDb.close();
  });

  it("BRS 11: a second approve attempt after execution is a no-op (decision is final)", async () => {
    const h = buildHarness();
    const action = makeAction("once_demo", {
      requiresApproval: true,
      preview: () => ({ kind: "generic", title: "demo", summary: "x" }),
    });
    h.registry.register(action);

    const r = await h.engine.run(
      "once_demo",
      {},
      {
        channelContext: guardianContext,
        sessionId: "sess-once",
        agentName: "main",
        channelThreadKey: "webchat:thread-A",
      },
    );
    if (r.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${r.status}`);
    }
    const approvalId = r.approval.approvalId;
    await h.approvalsRepo.resolvePending(approvalId, "approve");
    await h.handler.onApproved(approvalId);

    // Second call should not re-execute — duplicate-execution guard kicks in.
    await h.handler.onApproved(approvalId);
    expect(action.calls).toHaveLength(1);
    h.testDb.close();
  });
});

// BRS 14 — persistence: approvals do not auto-expire

describe("Approval flow E2E — persistence and time", () => {
  it("BRS 14: a pending approval stays pending across an arbitrary delay; nothing auto-resolves", async () => {
    const h = buildHarness();
    h.registry.register(
      makeAction("persist_demo", {
        requiresApproval: true,
        preview: () => ({ kind: "generic", title: "demo", summary: "x" }),
      }),
    );
    const r = await h.engine.run("persist_demo", {}, { channelContext: guardianContext });
    if (r.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${r.status}`);
    }
    const approvalId = r.approval.approvalId;

    // Simulate "guardian was offline for a long time" by waiting a tick and
    // re-reading: there should be no proactive resolution.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const pendingNow = await h.approvalsRepo.findById(approvalId);
    expect(pendingNow?.status).toBe("pending");
    expect(pendingNow?.resolvedAt ?? null).toBeNull();
    h.testDb.close();
  });
});

// Unimplemented v1 behaviors — kept visible as skipped tests

describe("Approval flow E2E — deferred (not implemented in v1)", () => {
  it.skip("BRS 4: independent steps in the same session continue while one step is suspended", () => {
    // No agent-side scheduler models per-step independence yet — the agent
    // is told to keep working in the tool-result text but parallel branch
    // semantics are not enforced by the runtime.
  });

  it.skip("BRS 5: a step depending on a suspended step waits for completion", () => {
    // Same gap as BRS 4 — completion-dependency is not modeled in v1.
  });
});
