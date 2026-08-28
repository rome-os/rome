import { describe, it, expect, afterEach } from "@rstest/core";
import { callAction } from "./call-action.js";
import { actionExecutionContext } from "./context.js";
import { buildAgentConfig } from "../test/helpers.js";
import { createTestRome, buildAction, recordingAction, type TestRome } from "../test/kit/index.js";
import type { ActionResult } from "./types.js";
import type { ThreadContext } from "../core/types.js";

// ApprovalHandler tests through the real wiring (testkit): real repos on an
// in-memory DB, the real ActionEngine executing registered actions
// in-process, and the real AgentRunner/session stack driven by FakeModel.
// Assertions read approval/journal rows and the prompts the model received —
// not stub call shapes.

describe("ApprovalHandler", () => {
  let rome: TestRome;

  afterEach(async () => {
    await rome?.cleanup();
  });

  async function setup(options: Parameters<typeof createTestRome>[0] = {}) {
    const sendMessage = recordingAction("send_message", {
      sideEffects: "write",
      execute: async () => ({ status: "ok", data: { sent: true } }),
    });
    rome = await createTestRome({
      ...options,
      agents: options.agents ?? [
        buildAgentConfig({ name: "main", actions: ["*"] }),
        buildAgentConfig({ name: "assistant", actions: ["*"] }),
      ],
      actions: [sendMessage.action, ...(options.actions ?? [])],
    });
    return { sendMessage };
  }

  async function seedAgentSession(
    id: string,
    agentName = "main",
    channelThreadKey = `approval:${id}`,
  ) {
    await rome.repos.sessions.create({
      id,
      agentName,
      channelThreadKey,
      status: "active",
    });
  }

  // onApproved — action-level replay
  describe("onApproved — action-level replay", () => {
    it("replays the recorded journal: cached children are reused, only the gated child executes", async () => {
      const childA = recordingAction("child_a", {
        execute: async () => ({ status: "ok", data: "A-result" }),
      });
      const childB = recordingAction("child_b", {
        requiresApproval: true,
        execute: async () => ({ status: "ok", data: "B-result" }),
      });
      const parent = buildAction("parent", {
        execute: async () => {
          // During record, child_b parks on its approval gate and returns a
          // pending result — the parent must complete anyway (the engine
          // surfaces the pending signal at the root).
          const dataOf = (r: ActionResult) => (r.status === "ok" ? r.data : undefined);
          const rA = await callAction("child_a", { id: 1 });
          const rB = await callAction("child_b", { id: 2 });
          return { status: "ok", data: [dataOf(rA), dataOf(rB)] };
        },
      });
      await setup({ actions: [childA.action, childB.action, parent] });

      // Record mode: the real engine runs parent, executes child_a, parks on
      // child_b's approval gate and persists the journal + approval payload.
      const recorded = await rome.actionEngine.run(
        "parent",
        {},
        { initiator: "agent:main", channelContext: { channel: "telegram", threadId: "t-1" } },
      );
      if (recorded.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${recorded.status}`);
      }
      const approvalId = recorded.approval.approvalId;
      expect(childA.calls).toEqual([{ id: 1 }]);
      expect(childB.calls).toEqual([]);

      const resolved = await rome.repos.approvals.resolvePending(approvalId, "approve");
      expect(resolved.outcome).toBe("resolved");
      childA.calls.length = 0;

      await rome.approvalHandler.onApproved(approvalId);

      // child_a came from the journal; child_b really executed.
      expect(childA.calls).toEqual([]);
      expect(childB.calls).toEqual([{ id: 2 }]);

      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("succeeded");
      expect(row!.executedAt).not.toBeNull();
    });

    it("propagates replayRootExecutionId and channelContext into the replayed execution", async () => {
      let observed: { rootExecutionId?: string; channelContext?: ThreadContext } = {};
      const probe = buildAction("probe", {
        requiresApproval: true,
        execute: async () => {
          const store = actionExecutionContext.getStore();
          observed = {
            rootExecutionId: store?.rootExecutionId,
            channelContext: store?.channelContext,
          };
          return { status: "ok" };
        },
      });
      const parent = buildAction("probe_parent", {
        execute: async () => callAction("probe", {}),
      });
      await setup({ actions: [probe, parent] });

      const channelContext: ThreadContext = {
        channel: "whatsapp",
        threadId: "wa-1",
        channelUserId: "u-1",
      };
      const recorded = await rome.actionEngine.run(
        "probe_parent",
        {},
        { initiator: "agent:main", channelContext },
      );
      if (recorded.status !== "pending_approval") {
        throw new Error(`expected pending_approval, got ${recorded.status}`);
      }
      const approvalId = recorded.approval.approvalId;
      const payload = (await rome.repos.approvals.findById(approvalId))!.payload as Record<
        string,
        unknown
      >;
      await rome.repos.approvals.resolvePending(approvalId, "approve");

      await rome.approvalHandler.onApproved(approvalId);

      // The replayed execution reuses the recorded root execution id and the
      // originating channel context — observed from inside the real action.
      expect(observed.rootExecutionId).toBe(payload.rootExecutionId);
      expect(observed.channelContext).toEqual(channelContext);
    });

    it("marks the approval failed when replay throws", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "ghost_child",
        args: {},
        rootActionName: "ghost_root", // not registered — engine.run rejects
        rootArgs: {},
        replayJournal: [],
      });

      await expect(rome.approvalHandler.onApproved(approvalId)).resolves.toBeUndefined();

      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("failed");
      expect(row!.executionError).toContain("ghost_root");
      expect(row!.executedAt).toBeNull();
    });
  });

  // onApproved — direct execution + agent session resumption
  describe("onApproved — agent-level session resumption", () => {
    it("executes the action directly when no replayJournal and marks it executed", async () => {
      const { sendMessage } = await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "send_message",
        args: { to: "user-1", text: "hello" },
      });
      await seedAgentSession("sess-1");

      await rome.approvalHandler.onApproved(approvalId);

      expect(sendMessage.calls).toEqual([{ to: "user-1", text: "hello" }]);
      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("succeeded");
      expect(row!.executedAt).not.toBeNull();
    });

    it("resumes the agent session with the formatted success result", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "send_message",
        args: { to: "user-1", text: "hello" },
        sessionId: "sess-1",
        agentName: "main",
        channelThreadKey: "telegram:t-1",
        channelContext: { channel: "telegram", threadId: "t-1", threadType: "group" },
      });
      await seedAgentSession("sess-1", "main", "telegram:t-1");

      await rome.approvalHandler.onApproved(approvalId);

      // A real turn ran: the model received the outcome prompt under the
      // main agent's real system prompt.
      expect(rome.model.prompts()).toHaveLength(1);
      expect(rome.model.lastPrompt()).toContain("approved and executed successfully");
      expect(rome.model.lastPrompt()).toContain('"sent": true');
      expect(rome.model.lastSystemPrompt()).toContain("You are a test agent.");
      expect(rome.model.sessions[0].sessionId).toBe("sess-1");
    });

    it("resumes the agent session with the formatted error result", async () => {
      const failing = buildAction("failing_action", {
        execute: async () => ({ status: "error", error: "insufficient permissions" }),
      });
      await setup({ actions: [failing] });
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "failing_action",
        args: {},
        sessionId: "sess-1",
        agentName: "main",
      });
      await seedAgentSession("sess-1");

      await rome.approvalHandler.onApproved(approvalId);

      expect(rome.model.lastPrompt()).toContain("failed with error");
      expect(rome.model.lastPrompt()).toContain("insufficient permissions");

      // An action that ran and reported failure still counts as executed.
      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("succeeded");
    });

    it("tells the agent when the result itself is pending further approval", async () => {
      const nested = buildAction("needs_more", {
        execute: async () => ({
          status: "pending_approval",
          approval: {
            approvalId: "nested-approval-1",
            actionName: "dangerous_action",
            description: "requires approval",
          },
        }),
      });
      await setup({ actions: [nested] });
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "needs_more",
        args: {},
        sessionId: "sess-1",
        agentName: "main",
      });
      await seedAgentSession("sess-1");

      await rome.approvalHandler.onApproved(approvalId);

      expect(rome.model.lastPrompt()).toContain("further approval");
      expect(rome.model.lastPrompt()).toContain("dangerous_action");
    });

    it("defaults to the 'main' agent when payload has no agentName", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "send_message",
        args: {},
        sessionId: "sess-1",
      });
      await seedAgentSession("sess-1");

      await rome.approvalHandler.onApproved(approvalId);

      expect(rome.model.sessions).toHaveLength(1);
      expect(rome.model.sessions[0].agentName).toBe("main");
    });

    it("skips session resumption when payload has no sessionId", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "send_message",
        args: {},
      });

      await rome.approvalHandler.onApproved(approvalId);

      expect(rome.model.calls).toHaveLength(0);
      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("succeeded");
    });

    it("does not execute when the execution was already claimed", async () => {
      const { sendMessage } = await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "send_message",
        args: {},
      });
      // Another worker claimed it (queued -> running).
      expect(await rome.repos.approvals.claimExecution(approvalId)).toBe(true);

      await rome.approvalHandler.onApproved(approvalId);

      expect(sendMessage.calls).toEqual([]);
      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("running");
      expect(row!.executedAt).toBeNull();
    });

    it("marks execution failed and does not throw when execution rejects", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "unregistered_action",
        args: {},
      });

      await expect(rome.approvalHandler.onApproved(approvalId)).resolves.toBeUndefined();

      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("failed");
      expect(row!.executionError).toContain("unregistered_action");
      expect(row!.executedAt).toBeNull();
    });
  });

  // onApproved — edge cases
  describe("onApproved — edge cases", () => {
    it("returns early when the approval does not exist", async () => {
      const { sendMessage } = await setup();

      await expect(rome.approvalHandler.onApproved("nonexistent")).resolves.toBeUndefined();

      expect(sendMessage.calls).toEqual([]);
    });

    it("marks execution failed when the approval has no payload", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval(null);

      await rome.approvalHandler.onApproved(approvalId);

      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("failed");
      expect(row!.executionError).toBe("approval has no payload");
    });

    it("marks execution failed when the payload is missing actionName", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval({ args: { foo: "bar" } });

      await rome.approvalHandler.onApproved(approvalId);

      const row = await rome.repos.approvals.findById(approvalId);
      expect(row!.executionState).toBe("failed");
      expect(row!.executionError).toBe("approval payload missing required field: actionName");
    });
  });

  // onRejected
  describe("onRejected", () => {
    it("notifies the agent session of the rejection when sessionId is present", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "send_message",
        args: {},
        sessionId: "sess-1",
        agentName: "assistant",
        channelThreadKey: "telegram:t-1",
      });
      await seedAgentSession("sess-1", "assistant", "telegram:t-1");

      await rome.approvalHandler.onRejected(approvalId);

      expect(rome.model.prompts()).toHaveLength(1);
      expect(rome.model.lastPrompt()).toContain('"send_message"');
      expect(rome.model.lastPrompt()).toContain("rejected by the guardian");
      expect(rome.model.lastPrompt()).not.toContain("feedback");
      expect(rome.model.sessions[0].agentName).toBe("assistant");
    });

    it("preserves the journal for the audit trail", async () => {
      await setup();
      await rome.repos.executionJournal.saveJournal("exec-42", [
        {
          sequence: 0,
          actionName: "child",
          argsHash: "abc",
          args: {},
          result: { status: "ok" },
          status: "completed",
        },
      ]);
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "send_message",
        args: {},
        rootExecutionId: "exec-42",
      });

      await rome.approvalHandler.onRejected(approvalId);

      const journal = await rome.repos.executionJournal.loadJournal("exec-42");
      expect(journal).toHaveLength(1);
    });

    it("returns silently when the approval does not exist", async () => {
      await setup();

      await expect(rome.approvalHandler.onRejected("nonexistent")).resolves.toBeUndefined();

      expect(rome.model.calls).toHaveLength(0);
    });

    it("does not throw when notifying the agent fails", async () => {
      await setup();
      const approvalId = await rome.seed.approvedActionApproval({
        actionName: "send_message",
        args: {},
        sessionId: "sess-1",
        agentName: "ghost_agent", // not loaded — the real runner rejects
      });

      await expect(rome.approvalHandler.onRejected(approvalId)).resolves.toBeUndefined();
    });
  });

  // multiple concurrent pending approvals (resolved out of order)
  describe("multiple concurrent pending approvals", () => {
    it("resolves three approvals out of insertion order without cross-contamination", async () => {
      const order: Array<{ action: string; args: Record<string, unknown> }> = [];
      const track = (name: string) =>
        buildAction(name, {
          execute: async (args) => {
            order.push({ action: name, args });
            return { status: "ok" };
          },
        });
      await setup({ actions: [track("demo_action"), track("summon")] });
      // setup() registers send_message as a recorder; track it via order too.
      const sendOrder = buildAction("tracked_send", {
        execute: async (args) => {
          order.push({ action: "tracked_send", args });
          return { status: "ok" };
        },
      });
      rome.actionRegistry.register(sendOrder);

      const ids = {
        A: await rome.seed.approvedActionApproval({
          actionName: "tracked_send",
          args: { text: "from-A" },
          sessionId: "sess-A",
          channelThreadKey: "telegram:tA",
        }),
        B: await rome.seed.approvedActionApproval({
          actionName: "demo_action",
          args: { name: "from-B" },
          sessionId: "sess-B",
          channelThreadKey: "telegram:tB",
        }),
        C: await rome.seed.approvedActionApproval({
          actionName: "summon",
          args: { goal: "from-C" },
          sessionId: "sess-C",
          channelThreadKey: "telegram:tC",
        }),
      };
      await seedAgentSession("sess-A", "main", "telegram:tA");
      await seedAgentSession("sess-B", "main", "telegram:tB");
      await seedAgentSession("sess-C", "main", "telegram:tC");

      await rome.approvalHandler.onApproved(ids.C);
      await rome.approvalHandler.onApproved(ids.A);
      await rome.approvalHandler.onApproved(ids.B);

      expect(order).toEqual([
        { action: "summon", args: { goal: "from-C" } },
        { action: "tracked_send", args: { text: "from-A" } },
        { action: "demo_action", args: { name: "from-B" } },
      ]);

      for (const id of Object.values(ids)) {
        const row = await rome.repos.approvals.findById(id);
        expect(row!.executionState).toBe("succeeded");
      }
    });

    it("isolates failure: one approval failing does not block the others", async () => {
      const order: string[] = [];
      const track = (name: string) =>
        buildAction(name, {
          execute: async () => {
            order.push(name);
            return { status: "ok" };
          },
        });
      await setup({ actions: [track("first_action"), track("third_action")] });

      const ids = {
        A: await rome.seed.approvedActionApproval({
          actionName: "first_action",
          args: {},
          sessionId: "sess-A",
        }),
        B: await rome.seed.approvedActionApproval({
          actionName: "missing_action", // not registered — this one fails
          args: {},
          sessionId: "sess-B",
        }),
        C: await rome.seed.approvedActionApproval({
          actionName: "third_action",
          args: {},
          sessionId: "sess-C",
        }),
      };
      await seedAgentSession("sess-A");
      await seedAgentSession("sess-C");

      await rome.approvalHandler.onApproved(ids.A);
      await rome.approvalHandler.onApproved(ids.B);
      await rome.approvalHandler.onApproved(ids.C);

      expect(order).toEqual(["first_action", "third_action"]);

      expect((await rome.repos.approvals.findById(ids.A))!.executionState).toBe("succeeded");
      expect((await rome.repos.approvals.findById(ids.C))!.executionState).toBe("succeeded");
      const failed = await rome.repos.approvals.findById(ids.B);
      expect(failed!.executionState).toBe("failed");
      expect(failed!.executionError).toContain("missing_action");
    });
  });
});
