import { describe, it, expect, afterEach } from "@rstest/core";
import { getCurrentActionContext, runWithCurrentActionContext } from "@rome-os/app-runtime";
import { callAction } from "./call-action.js";
import { actionExecutionContext } from "./context.js";
import type { ActionResult } from "./types.js";
import type { ThreadContext } from "../core/types.js";
import { createTestRome, buildAction, recordingAction, type TestRome } from "../test/kit/index.js";

// callAction tests through the real wiring (testkit): a parent action invokes
// callAction() inside a real ActionEngine.run(), and the assertions read what
// actually reached the child action — its args, its execution context, and
// the execution rows the engine persisted — not stub call shapes.

describe("callAction", () => {
  let rome: TestRome;

  afterEach(async () => {
    await rome?.cleanup();
  });

  it("executes the named action through the engine and returns its result to the caller", async () => {
    const child = recordingAction("send_message", {
      execute: async () => ({ status: "ok", data: "result" }),
    });
    let childResult: ActionResult | undefined;
    const parent = buildAction("parent", {
      execute: async () => {
        childResult = await callAction("send_message", { to: "user-1", text: "hi" });
        return { status: "ok" };
      },
    });
    rome = await createTestRome({ actions: [child.action, parent] });

    await rome.actionEngine.run("parent", {});

    expect(child.calls).toEqual([{ to: "user-1", text: "hi" }]);
    expect(childResult).toEqual({ status: "ok", data: "result" });

    // The child execution is recorded under the parent's execution tree.
    const [parentRow] = await rome.repos.actionExecutions.findByAction("parent");
    const [childRow] = await rome.repos.actionExecutions.findByAction("send_message");
    expect(childRow.rootExecutionId).toBe(parentRow.id);
    expect(childRow.parentId).toBe(parentRow.id);
  });

  it("throws when called outside ActionEngine.run() context", async () => {
    await expect(callAction("some_action", {})).rejects.toThrow(
      "callAction() must be used within ActionEngine.run() context",
    );
  });

  it("throws when context has no engine reference", async () => {
    await expect(
      actionExecutionContext.run(
        { executionId: "exec-1", rootExecutionId: "exec-1", initiator: "test" },
        () => callAction("some_action", {}),
      ),
    ).rejects.toThrow("callAction() must be used within ActionEngine.run() context");
  });

  it("passes complex args through unchanged and surfaces the action's failure result", async () => {
    const child = recordingAction("complex_action", {
      execute: async () => ({ status: "error", error: "denied" }),
    });
    let childResult: ActionResult | undefined;
    const args = { complex: { nested: true }, array: [1, 2, 3] };
    const parent = buildAction("parent", {
      execute: async () => {
        childResult = await callAction("complex_action", args);
        return { status: "ok" };
      },
    });
    rome = await createTestRome({ actions: [child.action, parent] });

    await rome.actionEngine.run("parent", {});

    expect(child.calls).toEqual([{ complex: { nested: true }, array: [1, 2, 3] }]);
    expect(childResult).toEqual({ status: "error", error: "denied" });
  });

  it("forwards channelContext and session fields to the called action", async () => {
    let observed: Record<string, unknown> | undefined;
    const child = buildAction("child_probe", {
      execute: async () => {
        const store = actionExecutionContext.getStore();
        observed = {
          initiator: store?.initiator,
          channelContext: store?.channelContext,
          sharedContext: store?.sharedContext,
          sessionId: store?.sessionId,
          agentName: store?.agentName,
          channelThreadKey: store?.channelThreadKey,
        };
        return { status: "ok" };
      },
    });
    const parent = buildAction("parent", {
      execute: () => callAction("child_probe", { text: "hello" }),
    });
    rome = await createTestRome({ actions: [child, parent] });

    const channelContext: ThreadContext = {
      channel: "telegram",
      threadId: "t-1",
      channelUserId: "u-1",
      threadName: "Dev Chat",
      threadType: "group",
    };
    await rome.actionEngine.run(
      "parent",
      {},
      {
        initiator: "channel:telegram",
        channelContext,
        sharedContext: {
          requestId: "req-7",
          flags: { dryRun: true },
        },
        sessionId: "sess-42",
        agentName: "main",
        channelThreadKey: "telegram:t-1",
      },
    );

    expect(observed).toEqual({
      initiator: "channel:telegram",
      channelContext,
      sharedContext: {
        requestId: "req-7",
        flags: { dryRun: true },
      },
      sessionId: "sess-42",
      agentName: "main",
      channelThreadKey: "telegram:t-1",
    });
  });

  it("exposes the current execution context through the app runtime SDK", async () => {
    await actionExecutionContext.run(
      {
        executionId: "exec-4",
        rootExecutionId: "exec-4",
        initiator: "channel:webchat",
        channelContext: {
          channel: "webchat",
          threadId: "thread-1",
          threadPath: "/tmp/threads/thread-1",
          channelUserId: "u-1",
          threadType: "private",
          projectName: "alpha",
        },
        sharedContext: {
          requestId: "req-9",
          tenantId: "tenant-alpha",
        },
        sessionId: "sess-7",
        agentName: "main",
        channelThreadKey: "webchat:thread-1",
      },
      async () => {
        expect(getCurrentActionContext()).toEqual({
          actionName: undefined,
          executionId: "exec-4",
          rootExecutionId: "exec-4",
          parentExecutionId: undefined,
          parentActionName: undefined,
          channelContext: {
            channel: "webchat",
            threadId: "thread-1",
            threadPath: "/tmp/threads/thread-1",
            channelUserId: "u-1",
            threadType: "private",
            projectName: "alpha",
          },
          sharedContext: {
            requestId: "req-9",
            tenantId: "tenant-alpha",
          },
          sessionId: "sess-7",
          agentName: "main",
          channelThreadKey: "webchat:thread-1",
        });
      },
    );
  });

  it("merges shared context through the app runtime SDK runner", async () => {
    let observedSharedContext: Record<string, unknown> | undefined;
    const child = buildAction("send_message", {
      execute: async () => {
        observedSharedContext = actionExecutionContext.getStore()?.sharedContext;
        return { status: "ok" };
      },
    });
    const parent = buildAction("parent", {
      execute: async () => {
        await runWithCurrentActionContext(
          {
            sharedContext: {
              company_id: "company-1",
              run_id: "run-1",
            },
          },
          async () => {
            expect(getCurrentActionContext()?.sharedContext).toEqual({
              requestId: "req-10",
              company_id: "company-1",
              run_id: "run-1",
            });

            await callAction("send_message", { text: "hello" });
          },
        );
        return { status: "ok" };
      },
    });
    rome = await createTestRome({ actions: [child, parent] });

    await rome.actionEngine.run(
      "parent",
      {},
      {
        initiator: "channel:webchat",
        sharedContext: { requestId: "req-10" },
      },
    );

    expect(observedSharedContext).toEqual({
      requestId: "req-10",
      company_id: "company-1",
      run_id: "run-1",
    });
  });
});
