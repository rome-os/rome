import { describe, it, expect, rs } from "@rstest/core";
import type { ActionResult } from "@rome-os/app-runtime";
import { createSummonAction } from "./index.js";
import { actionExecutionContext } from "../../../../../packages/core/src/actions/context.js";
import { emitAgentMessage } from "../../../../../packages/core/src/actions/runtime-events.js";
import type { AgentMessage } from "../../../../../packages/core/src/types.js";
import type { AgentRunner } from "../../../../../packages/core/src/core/agent-runner.js";

const passthroughArtifactReference = ({ value }: { value: string }) => value;

function summonDeps(agentRunner: AgentRunner) {
  return { agentRunner, resolveArtifactReference: passthroughArtifactReference };
}

function createMockRunner(
  messages: AgentMessage[] = [
    {
      type: "session_init",
      sessionId: "session-001",
      romeSession: { _romeSessionId: "action:exec-1:coder", _type: "action" },
    },
    { type: "turn_start", turnId: "turn-001", sessionId: "session-001", userPrompt: "fix bug" },
    { type: "result", content: "Task completed successfully" },
    { type: "turn_end", turnId: "turn-001", status: "completed", durationMs: 5 },
  ],
): AgentRunner {
  return {
    async *run() {
      for (const msg of messages) {
        yield msg;
      }
    },
  } as unknown as AgentRunner;
}

const actionConfig = {
  name: "summon",
  type: "system",
  description: "Summon subagent",
  complexity: "complex",
  speed: "slow",
  reliability: "medium",
  sideEffects: "write",
} as const;

describe("summon", () => {
  it("runs subagent without overriding the working directory", async () => {
    const calls: Array<{
      agentName: string;
      prompt: string;
      workingDir?: string;
      sharedContext?: Record<string, unknown>;
    }> = [];
    const runner = {
      async *run(params: {
        agentName: string;
        prompt: string;
        workingDir?: string;
        sharedContext?: Record<string, unknown>;
      }) {
        calls.push(params);
        yield {
          type: "session_init" as const,
          sessionId: "s-1",
          romeSession: { _romeSessionId: "action:exec-1:coder", _type: "action" },
        };
        yield { type: "result" as const, content: "done" };
      },
    } as unknown as AgentRunner;

    const tool = createSummonAction(actionConfig, summonDeps(runner));
    await tool.execute({ agentName: "coder", prompt: "fix bug" });

    expect(calls).toHaveLength(1);
    expect(calls[0].agentName).toBe("coder");
    expect(calls[0].prompt).toBe("fix bug");
    expect(calls[0].workingDir).toBeUndefined();
    expect(calls[0].sharedContext).toBeUndefined();
  });

  it("returns session id and result", async () => {
    const runner = createMockRunner();
    const tool = createSummonAction(actionConfig, summonDeps(runner));

    const actionResult = await tool.execute({ agentName: "coder", prompt: "fix bug" });
    if (actionResult.status !== "ok") throw new Error(`expected ok, got ${actionResult.status}`);
    const data = actionResult.data as {
      sessionId: string;
      result: string;
      romeSession: { _romeSessionId: string; _type: "action" };
    };

    expect(data.sessionId).toBe("session-001");
    expect(data.result).toBe("Task completed successfully");
    expect(data.romeSession).toEqual({
      _romeSessionId: "action:exec-1:coder",
      _type: "action",
    });
  });

  it("emits the opaque Rome session before the summoned agent finishes", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner = {
      async *run() {
        yield {
          type: "session_init" as const,
          sessionId: "session-001",
          romeSession: { _romeSessionId: "action:exec-1:coder", _type: "action" },
        };
        await gate;
        yield {
          type: "turn_start" as const,
          turnId: "turn-001",
          sessionId: "session-001",
          userPrompt: "fix bug",
        };
        yield { type: "result" as const, content: "done" };
      },
    } as unknown as AgentRunner;
    const tool = createSummonAction(actionConfig, summonDeps(runner));
    let receiveEvent!: (event: unknown) => void;
    const eventReceived = new Promise<unknown>((resolve) => {
      receiveEvent = resolve;
    });

    const resultPromise = tool.execute(
      { agentName: "coder", prompt: "fix bug" },
      {
        emitActionEvent(event) {
          receiveEvent(event);
        },
      },
    );

    await expect(eventReceived).resolves.toEqual({
      type: "rome_session_started",
      agentName: "coder",
      romeSession: { _romeSessionId: "action:exec-1:coder", _type: "action" },
    });
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await expect(resultPromise).resolves.toMatchObject({
      status: "ok",
      data: {
        romeSession: { _romeSessionId: "action:exec-1:coder", _type: "action" },
      },
    });
  });

  it("forwards summoned agent trace messages to the active runtime observer", async () => {
    // turn_start/turn_end bracket the summoned stream and must stay local to
    // summon (not forwarded) — only session_init + content reach the observer.
    const runner = createMockRunner([
      {
        type: "session_init",
        sessionId: "session-001",
        romeSession: { _romeSessionId: "action:exec-1:coder", _type: "action" },
      },
      { type: "turn_start", turnId: "turn-001", sessionId: "session-001", userPrompt: "fix bug" },
      { type: "thinking", content: "Planning the work" },
      { type: "tool_use", id: "tu-summon-1", tool: "read_file", input: { path: "src/index.ts" } },
      { type: "tool_result", toolUseId: "tu-summon-1", tool: "read_file", output: "file contents" },
      { type: "text", content: "Implemented the change" },
      { type: "result", content: "Task completed successfully" },
      { type: "turn_end", turnId: "turn-001", status: "completed", durationMs: 5 },
    ]);
    const tool = createSummonAction(actionConfig, {
      ...summonDeps(runner),
      emitAgentMessage,
    });
    const observerEvents: unknown[] = [];

    await actionExecutionContext.run(
      {
        executionId: "exec-1",
        rootExecutionId: "exec-1",
        initiator: "test",
        runtimeObserver: {
          onRuntimeEvent: (event) => observerEvents.push(event),
        },
      },
      () => tool.execute({ agentName: "coder", prompt: "fix bug" }),
    );

    expect(observerEvents).toEqual([
      {
        type: "agent_message",
        message: {
          type: "session_init",
          sessionId: "session-001",
          romeSession: { _romeSessionId: "action:exec-1:coder", _type: "action" },
          agent: "coder",
        },
      },
      {
        type: "agent_message",
        message: { type: "thinking", content: "Planning the work", agent: "coder" },
      },
      {
        type: "agent_message",
        message: {
          type: "tool_use",
          id: "tu-summon-1",
          tool: "read_file",
          input: { path: "src/index.ts" },
          agent: "coder",
        },
      },
      {
        type: "agent_message",
        message: {
          type: "tool_result",
          toolUseId: "tu-summon-1",
          tool: "read_file",
          output: "file contents",
          agent: "coder",
        },
      },
      {
        type: "agent_message",
        message: { type: "text", content: "Implemented the change", agent: "coder" },
      },
      {
        type: "agent_message",
        message: { type: "result", content: "Task completed successfully", agent: "coder" },
      },
    ]);
  });

  it("resolves the agent before running it and forwards shared context", async () => {
    const calls: Array<{
      agentName?: string;
      sharedContext?: Record<string, unknown>;
    }> = [];
    const runner = {
      async *run(params: { sharedContext?: Record<string, unknown> }) {
        calls.push(params);
        yield {
          type: "session_init" as const,
          sessionId: "s-1",
          romeSession: { _romeSessionId: "action:exec-1:coder", _type: "action" },
        };
        yield { type: "result" as const, content: "done" };
      },
    } as unknown as AgentRunner;
    const resolveArtifactReference = rs.fn(({ value }: { value: string }) => value);
    const tool = createSummonAction(actionConfig, {
      agentRunner: runner,
      resolveArtifactReference,
    });

    await actionExecutionContext.run(
      {
        executionId: "exec-1",
        rootExecutionId: "exec-1",
        initiator: "test",
        sharedContext: {
          company_id: "company-1",
          run_id: "run-1",
        },
      },
      () => tool.execute({ agentName: "workflow-studio:coder", prompt: "fill records" }),
    );

    expect(resolveArtifactReference).toHaveBeenCalledWith({
      kind: "agent",
      value: "workflow-studio:coder",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agentName: "workflow-studio:coder",
      prompt: "fill records",
      sharedContext: {
        company_id: "company-1",
        run_id: "run-1",
      },
    });
  });

  it("propagates errors from agent execution", async () => {
    const runner = {
      async *run() {
        throw new Error("agent failed");
      },
    } as unknown as AgentRunner;
    const tool = createSummonAction(actionConfig, summonDeps(runner));

    await expect(tool.execute({ agentName: "coder", prompt: "fix bug" })).rejects.toThrow(
      "agent failed",
    );
  });

  it("previews the bound agent and the verbatim prompt that will run", () => {
    const tool = createSummonAction(actionConfig, summonDeps(createMockRunner()));
    const payload = tool.preview!({ agentName: "main", prompt: "Summarize the email." });

    expect(payload).toEqual({
      kind: "generic",
      title: "Run agent “main”",
      summary: "Summarize the email.",
    });
  });

  it("previews an interactive summon as a handoff to the agent", () => {
    const tool = createSummonAction(actionConfig, summonDeps(createMockRunner()));
    const payload = tool.preview!({
      agentName: "designer",
      prompt: "Draft the layout.",
      interactive: true,
      appId: "workflow-studio",
    });

    expect(payload).toMatchObject({ kind: "generic", title: "Hand off to “designer”" });
  });

  it("canonicalizes interactive handoff references before returning the directive", async () => {
    const resolveArtifactReference = rs.fn(({ kind }: { kind: "agent" | "action" }) =>
      kind === "agent" ? "workflow-studio:designer" : "workflow-studio:validate-design",
    );
    const tool = createSummonAction(actionConfig, {
      agentRunner: createMockRunner(),
      resolveArtifactReference,
    });
    const result = await actionExecutionContext.run(
      {
        executionId: "exec-handoff",
        rootExecutionId: "exec-handoff",
        initiator: "app:workflow-studio",
      },
      () =>
        tool.execute({
          agentName: "workflow-studio:designer",
          prompt: "Draft the layout.",
          interactive: true,
          appId: "workflow-studio",
          handback: {
            schema: { type: "object" },
            validate: "workflow-studio:validate-design",
          },
        }),
    );

    expect(result).toMatchObject({
      status: "handoff",
      handoff: {
        appId: "workflow-studio",
        agentName: "workflow-studio:designer",
        handback: {
          validate: "workflow-studio:validate-design",
        },
      },
    });
    expect(resolveArtifactReference).toHaveBeenNthCalledWith(1, {
      kind: "agent",
      value: "workflow-studio:designer",
    });
    expect(resolveArtifactReference).toHaveBeenNthCalledWith(2, {
      kind: "action",
      value: "workflow-studio:validate-design",
    });
  });

  it("rejects input missing a required field without invoking the agent", async () => {
    const calls: unknown[] = [];
    const runner = {
      async *run(params: unknown) {
        calls.push(params);
        yield { type: "result" as const, content: "should not run" };
      },
    } as unknown as AgentRunner;
    const tool = createSummonAction(actionConfig, summonDeps(runner));

    // `prompt` is required by the schema; omitting it must fail closed.
    const result = (await tool.execute({ agentName: "coder" })) as ActionResult;

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Invalid input/);
    expect(calls).toHaveLength(0);
  });
});
