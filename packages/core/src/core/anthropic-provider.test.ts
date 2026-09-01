import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as claudeAgentSdkModule from "@anthropic-ai/claude-agent-sdk" with {
  rstest: "importActual",
};
import * as anthropicLoginModule from "../lib/anthropic-login.js" with { rstest: "importActual" };
import { AnthropicProvider } from "./anthropic-provider.js";
import type { AgentMessage } from "../types.js";
import type {
  ModelSession,
  ModelSessionForkOpenParams,
  ModelSessionParams,
} from "./agent-runner.js";
import { ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING } from "../lib/anthropic-compatible-providers.js";

const { AbortError } = claudeAgentSdkModule;

const {
  queryMock,
  createSdkMcpServerMock,
  sdkToolMock,
  markAnthropicAuthRevokedMock,
  clearAnthropicAuthRevokedMock,
} = rs.hoisted(() => ({
  queryMock: rs.fn(),
  createSdkMcpServerMock: rs.fn((config: unknown) => config),
  sdkToolMock: rs.fn(
    (
      name: string,
      description: string,
      inputSchema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => ({
      name,
      description,
      inputSchema,
      handler,
    }),
  ),
  markAnthropicAuthRevokedMock: rs.fn(),
  clearAnthropicAuthRevokedMock: rs.fn(),
}));

rs.mock("@anthropic-ai/claude-agent-sdk", () => ({
  ...claudeAgentSdkModule,
  query: queryMock,
  createSdkMcpServer: createSdkMcpServerMock,
  tool: sdkToolMock,
}));

rs.mock("../lib/anthropic-login.js", () => ({
  ...anthropicLoginModule,
  markAnthropicAuthRevoked: markAnthropicAuthRevokedMock,
  clearAnthropicAuthRevoked: clearAnthropicAuthRevokedMock,
}));

// Mock SDK Query: yields the canned messages then ends. The provider's
// events generator reads from this; the consumer drains it once and we
// then close the session.
function mockQuery(messages: unknown[], contextUsage?: unknown) {
  const iter = {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
    interrupt: rs.fn(async () => {}),
    close: rs.fn(),
    ...(contextUsage
      ? {
          getContextUsage: rs.fn(async () => contextUsage),
        }
      : {}),
  };
  queryMock.mockReturnValue(iter);
  return iter;
}

function mockThrowingQuery(error: unknown) {
  const iter = {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
    interrupt: rs.fn(async () => {}),
    close: rs.fn(),
  };
  queryMock.mockReturnValue(iter);
  return iter;
}

async function collectEvents(session: ModelSession): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  for await (const msg of session.events) {
    // Strip non-deterministic timestamps so deep-equal stays stable.
    const stripped = { ...(msg as unknown as Record<string, unknown>) };
    delete stripped.startedAt;
    delete stripped.endedAt;
    messages.push(stripped as unknown as AgentMessage);
  }
  return messages;
}

function buildParams(overrides: Partial<ModelSessionParams> = {}): ModelSessionParams {
  return {
    model: "claude-test",
    systemPrompt: "system",
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    sessionId: "test-session",
    isNewSession: true,
    executeAction: async () => ({ ok: true }),
    executeSubagent: async () => "delegated",
    ...overrides,
  };
}

function buildForkOpenParams(
  overrides: Partial<ModelSessionForkOpenParams> = {},
): ModelSessionForkOpenParams {
  const params = buildParams(
    overrides as Partial<ModelSessionParams>,
  ) as Partial<ModelSessionParams>;
  delete params.sessionId;
  delete params.isNewSession;
  delete params.providerThreadId;
  delete params.fork;
  return params as ModelSessionForkOpenParams;
}

describe("AnthropicProvider", () => {
  it("adopts a late SDK-queued input exactly once and gates the next native loop", async () => {
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    const prompts: { uuid: string; priority: string }[] = [];
    let enteredSecondLoop = false;
    queryMock.mockImplementation(({ prompt, options }) => ({
      async *[Symbol.asyncIterator]() {
        const inputs = prompt[Symbol.asyncIterator]();
        const hook = options.hooks.UserPromptSubmit[0].hooks[0];
        const first = (await inputs.next()).value;
        prompts.push(first);
        await hook({}, undefined, { signal: new AbortController().signal });
        yield { ...first, isReplay: true };
        const second = (await inputs.next()).value;
        prompts.push(second);
        yield { type: "result", subtype: "success", result: "first", num_turns: 1 };
        await hook({}, undefined, { signal: new AbortController().signal });
        enteredSecondLoop = true;
        yield { ...second, isReplay: true };
        yield { type: "result", subtype: "success", result: "second", num_turns: 1 };
      },
      close: rs.fn(),
    }));
    const session = await new AnthropicProvider().openSession(buildParams());
    const events = session.events[Symbol.asyncIterator]();
    await session.sendUserInput({ text: "first", inputId: a });
    expect((await events.next()).value).toMatchObject({ inputId: a, state: "consumed" });
    expect(await session.steerUserInput!({ text: "second", inputId: b })).toBe("accepted");
    expect((await events.next()).value).toMatchObject({ inputId: b, state: "queued" });
    expect((await events.next()).value).toMatchObject({ type: "result", content: "first" });
    const next = events.next();
    await new Promise((resolve) => setImmediate(resolve));
    expect(enteredSecondLoop).toBe(false);
    await session.sendUserInput({ text: "second", inputId: b });
    expect((await next).value).toMatchObject({ inputId: b, state: "consumed" });
    expect(prompts.map((input) => input.uuid)).toEqual([a, b]);
    expect(prompts.map((input) => input.priority)).toEqual(["next", "next"]);
    expect((await events.next()).value).toMatchObject({ type: "result", content: "second" });
    await session.close();
  });

  it("marks a boundary-consumed steer without creating another native turn", async () => {
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    queryMock.mockImplementation(({ prompt, options }) => ({
      async *[Symbol.asyncIterator]() {
        const inputs = prompt[Symbol.asyncIterator]();
        const first = (await inputs.next()).value;
        await options.hooks.UserPromptSubmit[0].hooks[0]({}, undefined, {
          signal: new AbortController().signal,
        });
        yield { ...first, isReplay: true };
        yield { ...(await inputs.next()).value, isReplay: true };
        yield { type: "result", subtype: "success", result: "both", num_turns: 2 };
      },
      close: rs.fn(),
    }));
    const session = await new AnthropicProvider().openSession(buildParams());
    const events = session.events[Symbol.asyncIterator]();
    await session.sendUserInput({ text: "first", inputId: a });
    await events.next();
    await session.steerUserInput!({ text: "second", inputId: b });
    expect((await events.next()).value).toMatchObject({ inputId: b, state: "consumed" });
    expect((await events.next()).value).toMatchObject({ type: "result", content: "both" });
    await session.close();
  });

  beforeEach(() => {
    rs.clearAllMocks();
    markAnthropicAuthRevokedMock.mockResolvedValue(undefined);
    clearAnthropicAuthRevokedMock.mockResolvedValue(undefined);
    mockQuery([
      {
        type: "result",
        subtype: "success",
        result: "Done",
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
  });

  it("allows TodoWrite as a builtin tool", () => {
    const provider = new AnthropicProvider();

    expect(provider.builtinTools.has("TodoWrite")).toBe(true);
  });

  it("uses SDK outputFormat and publishes only the native structured terminal", async () => {
    const schema = {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    };
    const structuredOutput = { value: 7 };
    mockQuery([
      {
        type: "assistant",
        uuid: "assistant-structured",
        session_id: "claude-structured",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: JSON.stringify(structuredOutput) }] },
      },
      {
        type: "result",
        subtype: "success",
        result: JSON.stringify(structuredOutput),
        structured_output: structuredOutput,
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);

    const session = await new AnthropicProvider().openSession(
      buildParams({ outputSchema: schema }),
    );
    await session.sendUserInput({ text: "return seven" });
    const events = await collectEvents(session);

    expect(queryMock.mock.calls[0]![0].options.outputFormat).toEqual({
      type: "json_schema",
      schema,
    });
    expect(events.some((event) => event.type === "text" || event.type === "text_delta")).toBe(
      false,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        content: JSON.stringify(structuredOutput),
        structuredOutput,
      }),
    );
    await session.close();
  });

  it("rejects native structured output that does not match outputSchema", async () => {
    mockQuery([
      {
        type: "result",
        subtype: "success",
        result: '{"value":"seven"}',
        structured_output: { value: "seven" },
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
    const session = await new AnthropicProvider().openSession(
      buildParams({
        outputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );
    await session.sendUserInput({ text: "return seven" });

    expect(await collectEvents(session)).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("failed validation"),
      }),
    );
    await session.close();
  });

  it("surfaces SDK structured-output retry exhaustion as a failed turn", async () => {
    mockQuery([
      {
        type: "result",
        subtype: "error_max_structured_output_retries",
        errors: [],
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
    const session = await new AnthropicProvider().openSession(
      buildParams({
        outputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );
    await session.sendUserInput({ text: "return a value" });
    expect(await collectEvents(session)).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("error_max_structured_output_retries"),
      }),
    );
    await session.close();
  });

  it.each([
    "startup",
    "partial",
    "completed-block",
  ])("aborts the Query during %s and preserves received output", async (phase) => {
    let controller!: AbortController;
    let begin!: () => void;
    const begun = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const q = {
      interrupt: rs.fn(),
      close: rs.fn(),
      async *[Symbol.asyncIterator]() {
        if (phase === "partial") {
          yield {
            type: "stream_event",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Saved work" },
            },
          };
        }
        if (phase === "completed-block") {
          yield {
            type: "assistant",
            uuid: "assistant-before-stop",
            session_id: "persisted-thread",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "Saved work" }] },
          };
        }
        begin();
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        if (phase === "completed-block") return;
        throw new AbortError("Cancelled");
      },
    };
    queryMock.mockImplementation(({ options }) => {
      controller = options.abortController;
      return q;
    });
    const session = await new AnthropicProvider().openSession(buildParams());
    await session.sendUserInput({ text: "work" });
    const collected = collectEvents(session);
    await begun;
    await session.interrupt("user-stop");
    const messages = await collected;
    expect(q.interrupt).not.toHaveBeenCalled();
    expect(q.close).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(true);
    expect(session.isClosed).toBe(true);
    expect(messages.filter((message) => message.type === "result")).toEqual([
      { type: "result", content: phase === "startup" ? "" : "Saved work" },
    ]);
    if (phase !== "startup") {
      expect(messages).toContainEqual({ type: "text", content: "Saved work", turnPhase: "final" });
    }
    expect(session.lastCompletedTurnCheckpoint).toBeUndefined();
    await expect(session.sendUserInput({ text: "next" })).rejects.toThrow("closed");
    await session.close();
  });

  it.each([
    { label: "the current assistant checkpoint", interruptedCheckpoint: "assistant-current" },
    { label: "no checkpoint", interruptedCheckpoint: undefined },
  ])("does not publish $label when interrupted after a successful turn", async ({
    interruptedCheckpoint,
  }) => {
    let controller!: AbortController;
    let beginInterruptibleTurn!: () => void;
    const interruptibleTurnBegun = new Promise<void>((resolve) => {
      beginInterruptibleTurn = resolve;
    });
    queryMock.mockImplementation(({ prompt, options }) => {
      controller = options.abortController;
      return {
        async *[Symbol.asyncIterator]() {
          const inputs = prompt[Symbol.asyncIterator]();
          await inputs.next();
          yield {
            type: "assistant",
            uuid: "assistant-previous",
            session_id: "persisted-thread",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "Previous turn" }] },
          };
          yield {
            type: "result",
            subtype: "success",
            result: "Previous turn",
            num_turns: 1,
            stop_reason: "end_turn",
            total_cost_usd: 0,
            duration_ms: 1,
          };

          await inputs.next();
          if (interruptedCheckpoint) {
            yield {
              type: "assistant",
              uuid: interruptedCheckpoint,
              session_id: "persisted-thread",
              parent_tool_use_id: null,
              message: { content: [{ type: "text", text: "Current turn" }] },
            };
          }
          beginInterruptibleTurn();
          if (!controller.signal.aborted) {
            await new Promise<void>((resolve) =>
              controller.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          }
          throw new AbortError("Cancelled");
        },
        close: rs.fn(),
      };
    });

    const session = await new AnthropicProvider().openSession(buildParams());
    const events = session.events[Symbol.asyncIterator]();
    await session.sendUserInput({ text: "first" });
    expect((await events.next()).value).toMatchObject({
      type: "text",
      content: "Previous turn",
    });
    expect((await events.next()).value).toMatchObject({ type: "result", content: "Previous turn" });
    expect(session.lastCompletedTurnCheckpoint).toBe("assistant-previous");

    await session.sendUserInput({ text: "second" });
    const remaining = (async () => {
      const messages: AgentMessage[] = [];
      for (;;) {
        const next = await events.next();
        if (next.done) return messages;
        messages.push(next.value);
      }
    })();
    await interruptibleTurnBegun;
    await session.interrupt("user-stop");
    expect(await remaining).toContainEqual({
      type: "result",
      content: interruptedCheckpoint ? "Current turn" : "",
    });
    expect(session.lastCompletedTurnCheckpoint).toBeUndefined();
    await session.close();
  });

  it("projects top-level TodoWrite snapshots while preserving generic tool events", async () => {
    const todoMessage = (id: string, todos: unknown, parentToolUseId: string | null = null) => ({
      type: "assistant",
      uuid: `assistant-${id}`,
      session_id: "claude-session",
      parent_tool_use_id: parentToolUseId,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }],
      },
    });
    mockQuery([
      todoMessage("todo-1", [
        {
          content: "Inspect the provider",
          activeForm: "Inspecting the provider",
          status: "completed",
        },
        { content: "Build the panel", activeForm: "Building the panel", status: "in_progress" },
      ]),
      // A malformed non-empty list must not clear the last valid snapshot.
      todoMessage("todo-bad", [{ content: "Unknown", activeForm: "Unknown", status: "blocked" }]),
      // SDK-internal child streams cannot replace the parent Plan.
      todoMessage(
        "todo-child",
        [{ content: "Child work", activeForm: "Doing child work", status: "in_progress" }],
        "toolu-subagent",
      ),
      todoMessage("todo-2", [
        {
          content: "Inspect the provider",
          activeForm: "Inspecting the provider",
          status: "completed",
        },
        { content: "Build the panel", activeForm: "Building the panel", status: "completed" },
        { content: "Verify in browser", activeForm: "Verifying in browser", status: "in_progress" },
      ]),
      {
        type: "result",
        subtype: "success",
        result: "Done",
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);

    const provider = new AnthropicProvider();
    const session = await provider.openSession(buildParams());
    const messages = await collectEvents(session);

    expect(messages.filter((message) => message.type === "plan_update")).toEqual([
      {
        type: "plan_update",
        plan: {
          steps: [
            {
              text: "Inspect the provider",
              activeText: "Inspecting the provider",
              status: "completed",
            },
            {
              text: "Build the panel",
              activeText: "Building the panel",
              status: "in_progress",
            },
          ],
        },
      },
      {
        type: "plan_update",
        plan: {
          steps: [
            {
              text: "Inspect the provider",
              activeText: "Inspecting the provider",
              status: "completed",
            },
            { text: "Build the panel", activeText: "Building the panel", status: "completed" },
            {
              text: "Verify in browser",
              activeText: "Verifying in browser",
              status: "in_progress",
            },
          ],
        },
      },
    ]);
    expect(messages.filter((message) => message.type === "tool_use")).toHaveLength(4);
    await session.close();
  });

  it("disposes the SDK query after an events consumer returns at a terminal", async () => {
    const sdkQuery = mockQuery([
      {
        type: "result",
        subtype: "success",
        result: "Done",
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
    const provider = new AnthropicProvider();
    const session = await provider.openSession(buildParams());
    const events = session.events[Symbol.asyncIterator]();

    const terminal = await events.next();
    expect(terminal.value).toMatchObject({ type: "result" });

    // Fork consumers intentionally stop at the first terminal block. Returning
    // the provider event iterator must not make the later ModelSession.close()
    // mistake "stream ended" for "SDK query already disposed".
    await events.return?.();
    await session.close();

    expect(sdkQuery.close).toHaveBeenCalledOnce();
  });

  it("opens forked Claude sessions with native resume fork options and a separate input queue", async () => {
    const provider = new AnthropicProvider();

    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const fork = await source.fork({
      sessionId: "fork-session",
      mode: "thread",
      sourceCheckpoint: "assistant-message-at-t2",
    });
    const forkSession = await fork.open(
      buildForkOpenParams({ model: "claude-fork", systemPrompt: "fork system" }),
    );

    expect(fork).toMatchObject({
      providerId: "anthropic",
      sessionId: "fork-session",
      sourceSessionId: "source-session",
      mode: "thread",
      providerThreadId: "fork-session",
    });
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        options: expect.objectContaining({
          model: "claude-fork",
          systemPrompt: "fork system",
          resume: "source-session",
          forkSession: true,
          sessionId: "fork-session",
          resumeSessionAt: "assistant-message-at-t2",
        }),
      }),
    );
    expect(queryMock.mock.calls[0]![0].prompt).not.toBe(queryMock.mock.calls[1]![0].prompt);

    await forkSession.close();
    await source.close();
  });

  it("rejects a second open of the same Claude fork descriptor", async () => {
    const provider = new AnthropicProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const fork = await source.fork({ sessionId: "fork-session" });
    const opened = await fork.open(buildForkOpenParams());

    await expect(fork.open(buildForkOpenParams())).rejects.toThrow(
      "ModelSession fork already opened",
    );

    await opened.close();
    await source.close();
  });

  describe("session resume gating", () => {
    it("starts a fresh SDK session with the host session id when the session is new", async () => {
      const provider = new AnthropicProvider();
      const session = await provider.openSession(
        buildParams({ sessionId: "fresh-session", isNewSession: true }),
      );

      expect(queryMock.mock.calls[0]![0].options).toMatchObject({ sessionId: "fresh-session" });
      expect(queryMock.mock.calls[0]![0].options.resume).toBeUndefined();

      await session.close();
    });

    it("uses a fresh SDK id when a reused session has no resumable transcript", async () => {
      // A stored session row with no captured provider thread id — e.g. a turn
      // that short-circuited (the not-logged-in notice) before opening an SDK
      // conversation. Resuming it would fail with "No conversation found".
      const provider = new AnthropicProvider();
      const session = await provider.openSession(
        buildParams({
          sessionId: "reused-session",
          isNewSession: false,
          providerThreadId: undefined,
        }),
      );

      expect(queryMock.mock.calls[0]![0].options.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(queryMock.mock.calls[0]![0].options.sessionId).not.toBe("reused-session");
      expect(queryMock.mock.calls[0]![0].options.resume).toBeUndefined();

      await session.close();
    });

    it("resumes by provider thread id when a prior transcript was captured", async () => {
      const provider = new AnthropicProvider();
      const session = await provider.openSession(
        buildParams({
          sessionId: "reused-session",
          isNewSession: false,
          providerThreadId: "sdk-thread-123",
        }),
      );

      expect(queryMock.mock.calls[0]![0].options).toMatchObject({ resume: "sdk-thread-123" });
      expect(queryMock.mock.calls[0]![0].options.sessionId).toBeUndefined();

      await session.close();
    });

    it("exposes the SDK session id as providerThreadId once a turn produces content", async () => {
      mockQuery([
        {
          type: "assistant",
          session_id: "sdk-thread-xyz",
          parent_tool_use_id: null,
          uuid: "u1",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "hi",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(
        buildParams({ sessionId: "host-session", isNewSession: true }),
      );

      expect(session.providerThreadId).toBeUndefined();
      await collectEvents(session);
      expect(session.providerThreadId).toBe("sdk-thread-xyz");
      expect(session.lastCompletedTurnCheckpoint).toBe("u1");

      await session.close();
    });
  });

  it("marks quota before exposing a usage-limit terminal", async () => {
    mockQuery([
      {
        type: "result",
        subtype: "error",
        errors: ["Claude usage limit reached. Please try again later."],
        num_turns: 1,
        stop_reason: "error",
        total_cost_usd: 0,
        duration_ms: 1,
      },
    ]);
    let quotaMarked = false;
    const provider = new AnthropicProvider({
      env: { PATH: "/usr/bin" },
      onQuotaExhausted: () => {
        quotaMarked = true;
      },
    });
    const session = await provider.openSession(buildParams());

    const terminal = await session.events[Symbol.asyncIterator]().next();

    expect(quotaMarked).toBe(true);
    expect(terminal.value).toMatchObject({ type: "error", code: "usage_limit" });
    await session.close();
  });

  describe("auth revoked handling", () => {
    it("tags invalid-credential result errors and waits for the revoked marker before terminal error", async () => {
      mockQuery([
        {
          type: "result",
          subtype: "error",
          errors: ["Failed to authenticate. API Error: 401 Invalid authentication credentials"],
          num_turns: 1,
          stop_reason: "error",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);
      let resolveMarker!: () => void;
      let resolveMarkerStarted!: () => void;
      const markerStarted = new Promise<void>((resolve) => {
        resolveMarkerStarted = resolve;
      });
      const markerDone = new Promise<void>((resolve) => {
        resolveMarker = resolve;
      });
      markAnthropicAuthRevokedMock.mockImplementationOnce(async () => {
        resolveMarkerStarted();
        await markerDone;
      });
      let authStateMarked = false;
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin" },
        onAuthRevoked: () => {
          authStateMarked = true;
        },
      });
      const session = await provider.openSession(buildParams());
      const iter = session.events[Symbol.asyncIterator]();
      const next = iter.next();

      await markerStarted;
      let terminalEmitted = false;
      void next.then(() => {
        terminalEmitted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(terminalEmitted).toBe(false);
      expect(authStateMarked).toBe(false);

      resolveMarker();
      const terminal = await next;

      expect(markAnthropicAuthRevokedMock).toHaveBeenCalledTimes(1);
      expect(authStateMarked).toBe(true);
      expect(terminal).toMatchObject({
        done: false,
        value: {
          type: "error",
          error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
          code: "auth_revoked",
        },
      });

      await session.close();
    });

    it("converts thrown invalid-credential stream errors into auth_revoked terminals", async () => {
      mockThrowingQuery(new Error("OAuth token revoked · Please run /login"));
      const provider = new AnthropicProvider({ env: { PATH: "/usr/bin" } });
      const session = await provider.openSession(buildParams());

      const messages = await collectEvents(session);

      expect(markAnthropicAuthRevokedMock).toHaveBeenCalledTimes(1);
      expect(messages).toEqual([
        {
          type: "error",
          error: "OAuth token revoked · Please run /login",
          code: "auth_revoked",
        },
      ]);

      await session.close();
    });

    it("scopes invalid stored Anthropic-compatible credentials to the provider API key", async () => {
      mockQuery([
        {
          type: "result",
          subtype: "error",
          errors: ["Failed to authenticate. API Error: 401 Invalid authentication credentials"],
          num_turns: 1,
          stop_reason: "error",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin" },
        settingsRepo: {
          get: rs.fn().mockResolvedValue({
            provider: "deepseek",
            apiKey: "deepseek-key",
            updatedAt: "2026-04-26T00:00:00.000Z",
          }),
        },
      });
      const session = await provider.openSession(buildParams());

      const messages = await collectEvents(session);

      expect(markAnthropicAuthRevokedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "stored-compatible",
          provider: "deepseek",
          apiKeyHash: expect.any(String),
        }),
      );
      expect(JSON.stringify(markAnthropicAuthRevokedMock.mock.calls[0]?.[0])).not.toContain(
        "deepseek-key",
      );
      expect(messages).toEqual([
        {
          type: "error",
          error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
          code: "auth_revoked",
        },
      ]);

      await session.close();
    });

    it("does not persist a Claude revoked marker for invalid raw env API keys", async () => {
      mockQuery([
        {
          type: "result",
          subtype: "error",
          errors: ["Failed to authenticate. API Error: 401 Invalid authentication credentials"],
          num_turns: 1,
          stop_reason: "error",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "env-token" },
      });
      const session = await provider.openSession(buildParams());

      const messages = await collectEvents(session);

      expect(markAnthropicAuthRevokedMock).not.toHaveBeenCalled();
      expect(messages).toEqual([
        {
          type: "error",
          error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        },
      ]);

      await session.close();
    });
  });

  describe("buildQueryEnv", () => {
    it("passes sandbox mode to the Claude SDK env", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", IS_SANDBOX: "0" },
      });

      const session = await provider.openSession(buildParams());
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            effort: "high",
            env: expect.objectContaining({
              PATH: "/usr/bin",
              IS_SANDBOX: "1",
              CLAUDE_CODE_EFFORT_LEVEL: "high",
            }),
          }),
        }),
      );
    });

    it.each([
      ["low", "low"],
      ["high", "high"],
      ["xhigh", "max"],
    ] as const)("maps %s reasoning effort to Claude effort %s", async (configured, expected) => {
      const provider = new AnthropicProvider({ env: { PATH: "/usr/bin" } });

      const session = await provider.openSession(buildParams({ reasoningEffort: configured }));
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            effort: expected,
            env: expect.objectContaining({ CLAUDE_CODE_EFFORT_LEVEL: expected }),
          }),
        }),
      );
    });

    it("passes stored Anthropic-compatible provider credentials to the Claude SDK env", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "old-token" },
        settingsRepo: {
          get: rs.fn().mockResolvedValue({
            provider: "deepseek",
            apiKey: "deepseek-key",
            updatedAt: "2026-04-26T00:00:00.000Z",
          }),
        },
      });

      const session = await provider.openSession(buildParams());
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: "deepseek-v4-pro[1m]",
            env: expect.objectContaining({
              PATH: "/usr/bin",
              ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
              ANTHROPIC_AUTH_TOKEN: "deepseek-key",
              ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
              ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
              CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
              CLAUDE_CODE_EFFORT_LEVEL: "high",
            }),
          }),
        }),
      );
    });

    it("uses a custom provider env without inherited Anthropic or Claude Code values", async () => {
      const provider = new AnthropicProvider({
        env: {
          PATH: "/usr/bin",
          ANTHROPIC_API_KEY: "inherited-key",
          ANTHROPIC_MODEL: "inherited-model",
          CLAUDE_CODE_OAUTH_TOKEN: "inherited-oauth",
          ENABLE_TOOL_SEARCH: "true",
        },
        settingsRepo: {
          get: rs.fn().mockResolvedValue({
            provider: "custom",
            env: {
              ANTHROPIC_AUTH_TOKEN: "ark-key",
              ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
              ANTHROPIC_MODEL: "ep-model",
              ANTHROPIC_DEFAULT_HAIKU_MODEL: "ep-model",
              ANTHROPIC_DEFAULT_SONNET_MODEL: "ep-model",
              ANTHROPIC_DEFAULT_OPUS_MODEL: "ep-model",
              CLAUDE_CODE_SUBAGENT_MODEL: "ep-model",
            },
            updatedAt: "2026-07-16T00:00:00.000Z",
          }),
        },
      });

      const session = await provider.openSession(buildParams({ model: "claude-sonnet-5" }));
      await collectEvents(session);
      await session.close();

      expect(session.model).toBe("ep-model");
      const queryEnv = queryMock.mock.calls[0]![0].options.env;
      expect(queryEnv).toMatchObject({
        PATH: "/usr/bin",
        IS_SANDBOX: "1",
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
        ANTHROPIC_MODEL: "ep-model",
        CLAUDE_CODE_SUBAGENT_MODEL: "ep-model",
        CLAUDE_CODE_EFFORT_LEVEL: "high",
      });
      expect(queryEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(queryEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(queryEnv.ENABLE_TOOL_SEARCH).toBeUndefined();
    });

    it("uses Meta's model id instead of the tier-resolved Claude model", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "anthropic-key" },
        settingsRepo: {
          get: rs.fn().mockResolvedValue({
            provider: "meta",
            apiKey: "meta-key",
            updatedAt: "2026-04-26T00:00:00.000Z",
          }),
        },
      });

      const session = await provider.openSession(buildParams({ model: "claude-sonnet-5" }));
      await collectEvents(session);
      await session.close();

      expect(session.model).toBe("muse-spark-1.1");
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: "muse-spark-1.1",
            env: expect.objectContaining({
              ANTHROPIC_AUTH_TOKEN: "meta-key",
              ANTHROPIC_BASE_URL: "https://api.meta.ai",
              ANTHROPIC_MODEL: "muse-spark-1.1",
            }),
          }),
        }),
      );
      expect(queryMock.mock.calls[0]![0].options.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("passes the stored timezone to the Claude SDK env", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", TZ: "UTC" },
        settingsRepo: {
          get: rs
            .fn()
            .mockImplementation(async (key: string) =>
              key === "guardianTimezone" ? "America/Los_Angeles" : null,
            ),
        },
      });

      const session = await provider.openSession(buildParams());
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            env: expect.objectContaining({
              PATH: "/usr/bin",
              TZ: "America/Los_Angeles",
            }),
          }),
        }),
      );
    });

    it("combines stored timezone with Anthropic-compatible provider credentials", async () => {
      const provider = new AnthropicProvider({
        env: { PATH: "/usr/bin", TZ: "UTC" },
        settingsRepo: {
          get: rs.fn().mockImplementation(async (key: string) => {
            if (key === "guardianTimezone") {
              return "America/New_York";
            }
            if (key === ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING) {
              return {
                provider: "deepseek",
                apiKey: "deepseek-key",
                updatedAt: "2026-04-26T00:00:00.000Z",
              };
            }
            return null;
          }),
        },
      });

      const session = await provider.openSession(buildParams());
      await collectEvents(session);
      await session.close();

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            env: expect.objectContaining({
              PATH: "/usr/bin",
              TZ: "America/New_York",
              ANTHROPIC_AUTH_TOKEN: "deepseek-key",
              ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
            }),
          }),
        }),
      );
    });
  });

  describe("event translation", () => {
    it("yields text_delta previews from top-level partial stream events only", async () => {
      mockQuery([
        {
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hel" },
          },
        },
        {
          // Non-text deltas (tool input streaming) are not previews.
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"q":' },
          },
        },
        {
          // SDK-internal subagent stream — must be skipped.
          type: "stream_event",
          parent_tool_use_id: "toolu_sub_1",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "subagent text" },
          },
        },
        {
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "lo" },
          },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
        {
          type: "result",
          subtype: "success",
          result: "Hello",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        { type: "text_delta", content: "Hel" },
        { type: "text_delta", content: "lo" },
        // Held until the turn ends with nothing following it → the closing answer.
        { type: "text", content: "Hello", turnPhase: "final" },
        { type: "result", content: "Hello" },
      ]);
      // Deltas only flow when partial messages are requested from the SDK.
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ includePartialMessages: true }),
        }),
      );
    });

    it("emits tool_result messages for builtin SDK tools like WebSearch", async () => {
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_websearch_1",
                name: "WebSearch",
                input: { query: "rome latest" },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_websearch_1",
          tool_use_result: {
            results: [{ title: "Result 1", url: "https://example.com" }],
          },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_websearch_1",
                content: { results: [{ title: "Result 1", url: "https://example.com" }] },
              },
            ],
          },
          session_id: "sess-1",
        },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        {
          type: "tool_use",
          id: "toolu_websearch_1",
          tool: "WebSearch",
          input: { query: "rome latest" },
        },
        {
          type: "tool_result",
          toolUseId: "toolu_websearch_1",
          tool: "WebSearch",
          output: { results: [{ title: "Result 1", url: "https://example.com" }] },
        },
        { type: "result", content: "Done" },
      ]);
    });

    it("tags text followed by a tool call as commentary and the closing text as final", async () => {
      // No stop_reason is set (the SDK never populates it on streamed assistant
      // messages); tagging is by position only — a text block with a tool call
      // after it is mid-turn narration; the last text before `result` is final.
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me check the weather first." },
              { type: "tool_use", id: "toolu_1", name: "WebSearch", input: { query: "weather" } },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_1",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }],
          },
          session_id: "sess-1",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "It's sunny." }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "It's sunny.",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      const texts = messages.filter((m) => m.type === "text");
      expect(texts).toEqual([
        { type: "text", content: "Let me check the weather first.", turnPhase: "commentary" },
        { type: "text", content: "It's sunny.", turnPhase: "final" },
      ]);
    });

    it("tags narration as commentary across per-block messages with no stop_reason", async () => {
      // Mirrors the real agent-SDK shape: stop_reason is always null and one API
      // message is split into one `assistant` message per content block (thinking,
      // text, tool_use arrive separately). The lookahead must still tag the
      // narration before the tool call as commentary and only the trailing text
      // — the one nothing follows but `result` — as the final answer.
      mockQuery([
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Let me look that up." }] },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_1",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" }],
          },
          session_id: "sess-1",
        },
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "ok" }] } },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "You have two files." }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "You have two files.",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      const texts = messages.filter((m) => m.type === "text");
      expect(texts).toEqual([
        { type: "text", content: "Let me look that up.", turnPhase: "commentary" },
        { type: "text", content: "You have two files.", turnPhase: "final" },
      ]);
    });

    it("falls back to top-level tool_use_result when content blocks are absent", async () => {
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_action_1",
                name: "execute_action",
                input: { action_name: "demo_action", json_args: { title: "Standup" } },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_action_1",
          tool_use_result: { success: true, data: { id: "evt_123" } },
          message: { role: "user", content: [] },
          session_id: "sess-2",
        },
        {
          type: "result",
          subtype: "success",
          result: "Scheduled",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        {
          type: "tool_use",
          id: "toolu_action_1",
          tool: "execute_action",
          input: { action_name: "demo_action", json_args: { title: "Standup" } },
        },
        {
          type: "tool_result",
          toolUseId: "toolu_action_1",
          tool: "execute_action",
          output: { success: true, data: { id: "evt_123" } },
        },
        { type: "result", content: "Scheduled" },
      ]);
    });

    it("preserves tool_result error metadata from content blocks", async () => {
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_webfetch_1",
                name: "WebFetch",
                input: { url: "https://example.com" },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_webfetch_1",
          tool_use_result: { content: "Request failed" },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_webfetch_1",
                content: "Request failed",
                is_error: true,
              },
            ],
          },
          session_id: "sess-3",
        },
        {
          type: "result",
          subtype: "success",
          result: "Handled",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        {
          type: "tool_use",
          id: "toolu_webfetch_1",
          tool: "WebFetch",
          input: { url: "https://example.com" },
        },
        {
          type: "tool_result",
          toolUseId: "toolu_webfetch_1",
          tool: "WebFetch",
          output: { content: "Request failed", isError: true },
        },
        { type: "result", content: "Handled" },
      ]);
    });

    it("normalizes MCP tool names before yielding tool messages", async () => {
      mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_subagent_1",
                name: "mcp__subagents__explore",
                input: { prompt: "Inspect src/index.ts" },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "toolu_subagent_1",
          tool_use_result: "Explore complete",
          message: { role: "user", content: [] },
          session_id: "sess-4",
        },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          num_turns: 1,
          stop_reason: "end_turn",
          total_cost_usd: 0,
          duration_ms: 1,
        },
      ]);

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams());
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toEqual([
        {
          type: "tool_use",
          id: "toolu_subagent_1",
          tool: "explore",
          input: { prompt: "Inspect src/index.ts" },
        },
        {
          type: "tool_result",
          toolUseId: "toolu_subagent_1",
          tool: "explore",
          output: "Explore complete",
        },
        { type: "result", content: "Done" },
      ]);
    });
  });

  describe("accounting", () => {
    it("attaches normalized accounting metadata to result messages", async () => {
      mockQuery(
        [
          {
            type: "result",
            subtype: "success",
            result: "Done",
            usage: {
              input_tokens: 1000,
              output_tokens: 200,
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 400,
            },
            num_turns: 2,
            stop_reason: "end_turn",
            total_cost_usd: 0.00789,
            duration_ms: 50,
          },
        ],
        {
          totalTokens: 12345,
          maxTokens: 900000,
          rawMaxTokens: 1000000,
          percentage: 1.2345,
          categories: [],
          gridRows: [],
          model: "claude-sonnet-5",
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: false,
          apiUsage: {
            input_tokens: 30,
            output_tokens: 200,
            cache_read_input_tokens: 10000,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const provider = new AnthropicProvider();
      const session = await provider.openSession(buildParams({ model: "claude-sonnet-5" }));
      const messages = await collectEvents(session);
      await session.close();

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "result",
        content: "Done",
        accounting: {
          provider: "anthropic",
          model: "claude-sonnet-5",
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 300,
            cacheWriteTokens: 400,
          },
          context: {
            usedTokens: 12345,
            windowTokens: 1000000,
            remainingTokens: 987655,
          },
          costUsd: 0.00789,
          numTurns: 2,
          stopReason: "end_turn",
          durationMs: 50,
          rawUsage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 400,
          },
        },
      });
      expect(
        (messages[0] as { type: "result"; accounting?: { costUsd?: number } }).accounting?.costUsd,
      ).toBeCloseTo(0.00789);
    });
  });
});
