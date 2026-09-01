import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { CodexAppServerProvider } from "./codex-app-server-provider.js";
import type {
  ModelSession,
  ModelSessionForkOpenParams,
  ModelSessionParams,
} from "./agent-runner.js";
import type { AgentMessage } from "../types.js";

// Capture the transport so tests can drive server→client notifications and
// assert the requests the provider issues.
const {
  getCodexCliStatusMock,
  markCodexAuthRevokedMock,
  requestMock,
  notifyMock,
  startMock,
  closeMock,
  captured,
} = rs.hoisted(() => ({
  getCodexCliStatusMock: rs.fn(),
  markCodexAuthRevokedMock: rs.fn(),
  requestMock: rs.fn(),
  notifyMock: rs.fn(),
  startMock: rs.fn(),
  closeMock: rs.fn(),
  captured: {
    onNotification: undefined as undefined | ((m: string, p: unknown) => void),
    onExit: undefined as undefined | ((code: number | null) => void),
    onServerRequest: undefined as
      | undefined
      | ((method: string, params: unknown) => Promise<unknown>),
    lastStartedThreadId: undefined as string | undefined,
  },
}));

rs.mock("../lib/codex-cli-auth.js", () => ({
  getCodexCliStatus: getCodexCliStatusMock,
  markCodexAuthRevoked: markCodexAuthRevokedMock,
}));

rs.mock("./codex/app-server-client.js", () => ({
  AppServerClient: rs.fn().mockImplementation((opts) => {
    captured.onNotification = (method, params) => {
      if (method === "thread/started") {
        const id = (params as { thread?: { id?: unknown } })?.thread?.id;
        if (typeof id === "string") captured.lastStartedThreadId = id;
      }
      opts.onNotification(method, params);
    };
    captured.onExit = opts.onExit;
    captured.onServerRequest = opts.onServerRequest;
    return {
      start: startMock,
      request: async (method: string, params: unknown) => {
        const result = await requestMock(method, params);
        if (method === "thread/start" && !(result as { thread?: unknown } | undefined)?.thread) {
          return { thread: { id: captured.lastStartedThreadId ?? "thr-1" } };
        }
        if (method === "thread/resume" && !(result as { thread?: unknown } | undefined)?.thread) {
          return { thread: { id: (params as { threadId: string }).threadId } };
        }
        return result;
      },
      notify: notifyMock,
      close: closeMock,
    };
  }),
}));

function buildParams(overrides: Partial<ModelSessionParams> = {}): ModelSessionParams {
  return {
    model: "gpt-5.4",
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

function usage(
  overrides: Partial<{
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  }> = {},
  totalOverrides: Partial<{
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  }> = {},
) {
  const last = {
    totalTokens: 10,
    inputTokens: 6,
    cachedInputTokens: 1,
    outputTokens: 4,
    reasoningOutputTokens: 0,
    ...overrides,
  };
  return { total: { ...last, ...totalOverrides }, last, modelContextWindow: null };
}

// Drain session.events until a terminal `result`/`error` arrives.
async function collectUntilTerminal(session: ModelSession): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const msg of session.events) {
    const stripped = { ...(msg as unknown as Record<string, unknown>) };
    delete stripped.startedAt;
    delete stripped.endedAt;
    out.push(stripped as unknown as AgentMessage);
    if (msg.type === "result" || msg.type === "error") break;
  }
  return out;
}

describe("CodexAppServerProvider", () => {
  it("steers the owned native turn, correlating consumption separately from RPC acceptance", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thr-1" } };
      if (method === "turn/start") {
        captured.onNotification?.("turn/started", { threadId: "thr-1", turn: { id: "native-a" } });
        return { turn: { id: "native-a" } };
      }
      if (method === "turn/steer") return { turnId: "native-a" };
      return {};
    });
    const session = await new CodexAppServerProvider().openSession(buildParams());
    await session.sendUserInput({ text: "first", inputId: "a" });
    const steering = session.steerUserInput!({ text: "second", inputId: "b" });
    await rs.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("turn/start", expect.anything()),
    );
    expect(requestMock).not.toHaveBeenCalledWith("turn/steer", expect.anything());
    captured.onNotification?.("item/completed", {
      threadId: "thr-1",
      turnId: "native-a",
      item: { type: "userMessage", id: "native-input-a", clientId: "a", content: [] },
    });
    expect(await steering).toBe("accepted");
    expect(requestMock).toHaveBeenCalledWith("turn/steer", {
      threadId: "thr-1",
      expectedTurnId: "native-a",
      clientUserMessageId: "b",
      input: [{ type: "text", text: "second", text_elements: [] }],
    });
    expect(requestMock.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(requestMock.mock.calls.filter(([method]) => method === "turn/interrupt")).toHaveLength(
      0,
    );
    captured.onNotification?.("item/completed", {
      threadId: "thr-1",
      turnId: "native-a",
      item: { type: "userMessage", id: "native-b", clientId: "b", content: [] },
    });
    captured.onNotification?.("turn/completed", {
      threadId: "thr-1",
      turn: { id: "native-a", status: "completed" },
    });
    const messages = await collectUntilTerminal(session);
    expect(messages.filter((message) => message.type === "input_status")).toEqual([
      { type: "input_status", inputId: "a", state: "consumed" },
      { type: "input_status", inputId: "b", state: "consumed" },
    ]);
    expect(await session.steerUserInput!({ text: "late", inputId: "c" })).toBe("deferred");
    await session.close();
  });

  it("releases a buffered steer when startup ends without confirming the first input", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thr-1" } };
      if (method === "turn/start") return { turn: { id: "native-a" } };
      return {};
    });
    const session = await new CodexAppServerProvider().openSession(buildParams());
    await session.sendUserInput({ text: "first", inputId: "a" });
    const steering = session.steerUserInput!({ text: "second", inputId: "b" });
    await rs.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("turn/start", expect.anything()),
    );
    captured.onNotification?.("turn/completed", {
      threadId: "thr-1",
      turn: { id: "native-a", status: "completed" },
    });
    expect(await steering).toBe("deferred");
    expect(requestMock).not.toHaveBeenCalledWith("turn/steer", expect.anything());
    await collectUntilTerminal(session);
    await session.close();
  });

  beforeEach(() => {
    rs.clearAllMocks();
    getCodexCliStatusMock.mockResolvedValue({ loggedIn: true });
    markCodexAuthRevokedMock.mockResolvedValue(undefined);
    captured.onNotification = undefined;
    captured.onExit = undefined;
    captured.onServerRequest = undefined;
    captured.lastStartedThreadId = undefined;
    // thread/start resolves after emitting thread/started (where the id lands).
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      return {};
    });
  });

  it("exposes the provider-agnostic builtin tool set and openai id", () => {
    const provider = new CodexAppServerProvider();
    expect(provider.id).toBe("openai");
    expect(provider.builtinTools.has("Task")).toBe(true);
  });

  it("handshakes once and starts a thread with Rome dynamic tools", async () => {
    const provider = new CodexAppServerProvider();
    await provider.openSession(buildParams());

    expect(startMock).toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledWith(
      "initialize",
      expect.objectContaining({ capabilities: { experimentalApi: true } }),
    );
    expect(notifyMock).toHaveBeenCalledWith("initialized", expect.any(Object));
    const startCall = requestMock.mock.calls.find((c) => c[0] === "thread/start");
    expect(startCall).toBeTruthy();
    expect(startCall![1]).toMatchObject({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      baseInstructions: "system",
    });
    expect((startCall![1] as { config: Record<string, unknown> }).config).not.toHaveProperty(
      "mcp_servers",
    );
    expect(startCall![1]).toMatchObject({
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({ name: "list_actions" }),
        expect.objectContaining({ name: "execute_action" }),
      ]),
    });
  });

  it("keeps external MCP servers while omitting every Rome HTTP MCP server", async () => {
    const provider = new CodexAppServerProvider();
    await provider.openSession(
      buildParams({
        externalMcpServers: {
          discovered_browser: { command: "browser-mcp", args: ["--stdio"] },
        },
      }),
    );

    const startCall = requestMock.mock.calls.find((call) => call[0] === "thread/start");
    const mcpServers = (
      startCall?.[1] as {
        config: { mcp_servers: Record<string, unknown> };
      }
    ).config.mcp_servers;
    expect(mcpServers).toEqual({
      discovered_browser: { command: "browser-mcp", args: ["--stdio"] },
    });
    expect(Object.keys(mcpServers).some((name) => name.startsWith("rome_"))).toBe(false);
  });

  it("shares one initialized client while routing different thread tool catalogs", async () => {
    const alphaExecute = rs.fn(async () => "alpha result");
    const betaExecute = rs.fn(async () => "beta result");
    requestMock.mockImplementation(async (method: string, requestParams: unknown) => {
      const payload = requestParams as {
        threadId?: string;
        dynamicTools?: Array<{ name: string }>;
      };
      if (method === "thread/start") {
        const names = payload.dynamicTools?.map((tool) => tool.name) ?? [];
        return {
          thread: { id: names.includes("alpha_researcher") ? "thread-alpha" : "thread-beta" },
        };
      }
      if (method === "turn/start") {
        const isAlpha = payload.threadId === "thread-alpha";
        const turnId = isAlpha ? "turn-alpha" : "turn-beta";
        const tool = isAlpha ? "alpha_researcher" : "beta_researcher";
        const callId = isAlpha ? "call-alpha" : "call-beta";
        captured.onNotification?.("turn/started", {
          threadId: payload.threadId,
          turn: { id: turnId },
        });
        await captured.onServerRequest?.("item/tool/call", {
          threadId: payload.threadId,
          turnId,
          callId,
          namespace: null,
          tool,
          arguments: { prompt: tool },
        });
        captured.onNotification?.("turn/completed", {
          threadId: payload.threadId,
          turn: { id: turnId, status: "completed" },
        });
      }
      return {};
    });
    const tool = (name: string) => ({
      name,
      description: name,
      inputSchema: {
        type: "object" as const,
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    });
    const provider = new CodexAppServerProvider();

    const [alpha, beta] = await Promise.all([
      provider.openSession(
        buildParams({
          sessionId: "alpha",
          systemPrompt: "alpha",
          subagentTools: [tool("alpha_researcher")],
          executeSubagent: alphaExecute,
        }),
      ),
      provider.openSession(
        buildParams({
          sessionId: "beta",
          systemPrompt: "beta",
          subagentTools: [tool("beta_researcher")],
          executeSubagent: betaExecute,
        }),
      ),
    ]);
    const alphaDone = collectUntilTerminal(alpha);
    const betaDone = collectUntilTerminal(beta);
    await Promise.all([
      alpha.sendUserInput({ text: "alpha" }),
      beta.sendUserInput({ text: "beta" }),
    ]);
    await Promise.all([alphaDone, betaDone]);

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls.filter((call) => call[0] === "initialize")).toHaveLength(1);
    expect(alpha.providerThreadId).toBe("thread-alpha");
    expect(beta.providerThreadId).toBe("thread-beta");
    expect(alphaExecute).toHaveBeenCalledWith(
      "alpha_researcher",
      { prompt: "alpha_researcher" },
      { toolUseId: "call-alpha" },
    );
    expect(betaExecute).toHaveBeenCalledWith(
      "beta_researcher",
      { prompt: "beta_researcher" },
      { toolUseId: "call-beta" },
    );
    expect(alphaExecute).toHaveBeenCalledTimes(1);
    expect(betaExecute).toHaveBeenCalledTimes(1);

    await alpha.close();
    await beta.close();
    expect(closeMock).not.toHaveBeenCalled();
    provider.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("maps dynamic facade results into app-server responses and Rome tool traces", async () => {
    let dynamicResponse: unknown;
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-ask" } };
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thread-ask", turn: { id: "turn-ask" } });
        n("item/started", {
          item: {
            type: "dynamicToolCall",
            id: "call-ask",
            tool: "ask_question",
            arguments: {
              questions: [{ id: "city", question: "Which city?", type: "text" }],
            },
          },
          threadId: "thread-ask",
          turnId: "turn-ask",
        });
        dynamicResponse = await captured.onServerRequest?.("item/tool/call", {
          threadId: "thread-ask",
          turnId: "turn-ask",
          callId: "call-ask",
          namespace: null,
          tool: "ask_question",
          arguments: {
            questions: [{ id: "city", question: "Which city?", type: "text" }],
          },
        });
        n("item/completed", {
          item: {
            type: "dynamicToolCall",
            id: "call-ask",
            tool: "ask_question",
            arguments: {},
          },
          threadId: "thread-ask",
          turnId: "turn-ask",
        });
        n("turn/completed", {
          threadId: "thread-ask",
          turn: { id: "turn-ask", status: "completed" },
        });
      }
      return {};
    });
    const provider = new CodexAppServerProvider();
    const session = await provider.openSession(buildParams({ supportsInteractiveSurface: true }));
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "ask" });
    const messages = await collected;

    expect(dynamicResponse).toMatchObject({ success: true });
    const result = messages.find((message) => message.type === "tool_result") as
      | { output?: { content?: Array<{ text?: string }> } }
      | undefined;
    const payload = JSON.parse(result?.output?.content?.[0]?.text ?? "{}");
    expect(payload).toMatchObject({ pendingInteraction: true });
    await session.close();
  });

  it.each([
    "ephemeral",
    "thread",
  ] as const)("materializes a Rome %s fork and resumes it on the shared app-server", async (mode) => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "source-thread" } });
      }
      if (method === "thread/fork") {
        // app-server emits this on the source client; it must not replace the
        // source session's provider thread identity.
        captured.onNotification?.("thread/started", { thread: { id: "fork-thread" } });
        return { thread: { id: "fork-thread" } };
      }
      return {};
    });

    const provider = new CodexAppServerProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const fork = await source.fork({ sessionId: "fork-session", mode });
    const forkSession = await fork.open(buildForkOpenParams());

    expect(requestMock).toHaveBeenCalledWith(
      "thread/fork",
      expect.objectContaining({
        threadId: "source-thread",
        model: "gpt-5.4",
        cwd: null,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        baseInstructions: "system",
        ephemeral: false,
        dynamicTools: expect.arrayContaining([expect.objectContaining({ name: "execute_action" })]),
      }),
    );
    expect(source.providerThreadId).toBe("source-thread");
    expect(fork).toMatchObject({
      sessionId: "fork-session",
      sourceSessionId: "source-session",
      sourceProviderThreadId: "source-thread",
      providerThreadId: "fork-thread",
      mode,
    });
    expect(requestMock).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId: "fork-thread" }),
    );

    await forkSession.close();
    await source.close();
  });

  it("materializes an exact fork at the selected historical provider turn", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "source-thread" } });
      }
      if (method === "thread/fork") {
        return { thread: { id: "historical-fork-thread" } };
      }
      return {};
    });

    const provider = new CodexAppServerProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const fork = await source.fork({
      sessionId: "fork-session",
      mode: "ephemeral",
      configurationMode: "exact",
      sourceCheckpoint: "provider-turn-t2",
    });
    const forkSession = await fork.open(buildForkOpenParams());

    expect(requestMock).toHaveBeenCalledWith(
      "thread/fork",
      expect.objectContaining({
        threadId: "source-thread",
        model: "gpt-5.4",
        cwd: null,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        baseInstructions: "system",
        ephemeral: false,
        lastTurnId: "provider-turn-t2",
        dynamicTools: expect.arrayContaining([expect.objectContaining({ name: "execute_action" })]),
      }),
    );
    expect(requestMock).not.toHaveBeenCalledWith("thread/rollback", expect.anything());
    expect(fork.providerThreadId).toBe("historical-fork-thread");

    await forkSession.close();
    await source.close();
  });

  it("runs a same-model exact fork on the source thread and rolls it back", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "source-thread" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "source-thread", turn: { id: "hidden-fork-turn" } });
        n("item/completed", {
          item: { type: "agentMessage", id: "m1", text: "fork answer", phase: "final_answer" },
          threadId: "source-thread",
          turnId: "hidden-fork-turn",
          completedAtMs: 0,
        });
        n("thread/tokenUsage/updated", {
          threadId: "source-thread",
          turnId: "hidden-fork-turn",
          tokenUsage: usage({ inputTokens: 100, cachedInputTokens: 90 }),
        });
        n("turn/completed", {
          threadId: "source-thread",
          turn: { id: "hidden-fork-turn", status: "completed" },
        });
      }
      return {};
    });

    const provider = new CodexAppServerProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const fork = await source.fork({
      sessionId: "fork-session",
      mode: "ephemeral",
      configurationMode: "exact",
    });
    const forkSession = await fork.open(buildForkOpenParams());
    const collected = collectUntilTerminal(forkSession);
    await forkSession.sendUserInput({ text: "feedback" });
    const msgs = await collected;

    expect(requestMock).not.toHaveBeenCalledWith("thread/fork", expect.anything());
    expect(requestMock).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "source-thread" }),
    );
    expect(requestMock).toHaveBeenCalledWith("thread/rollback", {
      threadId: "source-thread",
      numTurns: 1,
    });
    expect(fork.providerThreadId).toBe("source-thread");
    expect(source.providerThreadId).toBe("source-thread");
    expect(msgs.find((m) => m.type === "result")).toMatchObject({
      content: "fork answer",
      accounting: { usage: { inputTokens: 10, cacheReadTokens: 90 } },
    });

    await forkSession.close();
    await source.close();
  });

  it("routes dynamic subagent calls in a borrowed exact fork to the fork executor", async () => {
    const sourceExecuteSubagent = rs.fn(async () => "source result");
    const forkExecuteSubagent = rs.fn(async () => ({
      status: "completed",
      sessionId: "fork-child-session",
      turnId: "fork-child-turn",
      output: "fork result",
    }));
    const subagentTools = [
      {
        name: "researcher",
        description: "Research a topic",
        inputSchema: {
          type: "object" as const,
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
      },
    ];

    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "source-thread" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "source-thread", turn: { id: "fork-turn" } });
        n("item/started", {
          item: {
            type: "dynamicToolCall",
            id: "call-fork-subagent",
            tool: "researcher",
            arguments: { prompt: "inspect the fork" },
          },
          threadId: "source-thread",
          turnId: "fork-turn",
        });
        await captured.onServerRequest?.("item/tool/call", {
          threadId: "source-thread",
          turnId: "fork-turn",
          callId: "call-fork-subagent",
          namespace: null,
          tool: "researcher",
          arguments: { prompt: "inspect the fork" },
        });
        n("item/completed", {
          item: {
            type: "dynamicToolCall",
            id: "call-fork-subagent",
            tool: "researcher",
            arguments: { prompt: "inspect the fork" },
          },
          threadId: "source-thread",
          turnId: "fork-turn",
        });
        n("turn/completed", {
          threadId: "source-thread",
          turn: { id: "fork-turn", status: "completed" },
        });
      }
      return {};
    });

    const provider = new CodexAppServerProvider();
    const source = await provider.openSession(
      buildParams({
        sessionId: "source-session",
        isNewSession: true,
        subagentTools,
        executeSubagent: sourceExecuteSubagent,
      }),
    );
    const fork = await source.fork({
      sessionId: "fork-session",
      mode: "ephemeral",
      configurationMode: "exact",
    });
    const forkSession = await fork.open(
      buildForkOpenParams({ subagentTools, executeSubagent: forkExecuteSubagent }),
    );
    const collected = collectUntilTerminal(forkSession);
    await forkSession.sendUserInput({ text: "feedback" });
    await collected;

    expect(forkExecuteSubagent).toHaveBeenCalledWith(
      "researcher",
      { prompt: "inspect the fork" },
      { toolUseId: "call-fork-subagent" },
    );
    expect(sourceExecuteSubagent).not.toHaveBeenCalled();

    await forkSession.close();
    await source.close();
  });

  it("settles an in-flight turn when the app-server exits after acking turn/start", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        // turn/start is acknowledged, then the process dies before
        // turn/completed ever arrives.
        captured.onNotification?.("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        captured.onExit?.(1);
      }
      return {};
    });

    const provider = new CodexAppServerProvider();
    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "hi" });
    const msgs = await collected;

    expect(msgs.find((m) => m.type === "error")).toMatchObject({
      type: "error",
      error: "codex app-server exited",
    });
    // The settled turn released the coordinator, so shutdown does not hang.
    await session.close();
  });

  it("lazily resumes an idle thread on a new shared process after exit", async () => {
    let turnNumber = 0;
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-restart" } };
      if (method === "turn/start") {
        turnNumber += 1;
        const n = captured.onNotification!;
        const turnId = `turn-${turnNumber}`;
        n("turn/started", { threadId: "thread-restart", turn: { id: turnId } });
        if (turnNumber === 1) {
          captured.onExit?.(137);
        } else {
          n("item/completed", {
            item: {
              type: "agentMessage",
              id: "message-after-restart",
              text: "recovered",
              phase: "final_answer",
            },
            threadId: "thread-restart",
            turnId,
            completedAtMs: 0,
          });
          n("turn/completed", {
            threadId: "thread-restart",
            turn: { id: turnId, status: "completed" },
          });
        }
      }
      return {};
    });
    const provider = new CodexAppServerProvider();
    const session = await provider.openSession(buildParams());

    const failed = collectUntilTerminal(session);
    await session.sendUserInput({ text: "first" });
    expect(await failed).toEqual([
      expect.objectContaining({ type: "error", error: "codex app-server exited" }),
    ]);

    const recovered = collectUntilTerminal(session);
    await session.sendUserInput({ text: "second" });
    expect((await recovered).find((message) => message.type === "result")).toMatchObject({
      content: "recovered",
    });
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls.filter((call) => call[0] === "initialize")).toHaveLength(2);
    expect(requestMock).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: "thread-restart",
        dynamicTools: expect.arrayContaining([expect.objectContaining({ name: "execute_action" })]),
      }),
    );
    await session.close();
  });

  it("unblocks fork and source shutdown when the app-server dies mid exact-fork turn", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "source-thread" } });
      }
      if (method === "turn/start") {
        captured.onNotification?.("turn/started", {
          threadId: "source-thread",
          turn: { id: "fork-turn" },
        });
        captured.onExit?.(137);
      }
      // The real client rejects post-exit requests immediately instead of
      // leaving them pending (see AppServerClient.request).
      if (method === "thread/rollback") throw new Error("codex app-server exited");
      return {};
    });

    const provider = new CodexAppServerProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const fork = await source.fork({
      sessionId: "fork-session",
      mode: "ephemeral",
      configurationMode: "exact",
    });
    const forkSession = await fork.open(buildForkOpenParams());
    const collected = collectUntilTerminal(forkSession);
    await forkSession.sendUserInput({ text: "feedback" });
    const msgs = await collected;

    expect(msgs.find((m) => m.type === "result")).toBeUndefined();
    expect(msgs.find((m) => m.type === "error")).toMatchObject({
      error: expect.stringContaining("exited"),
    });
    // Neither close hangs on the dead turn.
    await forkSession.close();
    await source.close();
  });

  it("poisons the source session when exact-fork rollback fails", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "source-thread" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "source-thread", turn: { id: "fork-turn" } });
        n("item/completed", {
          item: { type: "agentMessage", id: "m1", text: "fork answer", phase: "final_answer" },
          threadId: "source-thread",
          turnId: "fork-turn",
          completedAtMs: 0,
        });
        n("turn/completed", {
          threadId: "source-thread",
          turn: { id: "fork-turn", status: "completed" },
        });
      }
      if (method === "thread/rollback") throw new Error("rollback rejected");
      return {};
    });

    const provider = new CodexAppServerProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const sourceEvents = source.events[Symbol.asyncIterator]();
    const fork = await source.fork({
      sessionId: "fork-session",
      mode: "ephemeral",
      configurationMode: "exact",
    });
    const forkSession = await fork.open(buildForkOpenParams());
    const collected = collectUntilTerminal(forkSession);
    await forkSession.sendUserInput({ text: "feedback" });
    const msgs = await collected;

    // Retried once, then gave up.
    expect(requestMock.mock.calls.filter((c) => c[0] === "thread/rollback")).toHaveLength(2);
    // The fork never observes success while its turn is still in the source.
    expect(msgs.find((m) => m.type === "result")).toBeUndefined();
    expect(msgs.find((m) => m.type === "error")).toMatchObject({
      error: expect.stringContaining("rollback failed"),
    });
    // The source stream carries the contamination error…
    await expect(sourceEvents.next()).resolves.toMatchObject({
      value: { type: "error", error: expect.stringContaining("rollback failed") },
    });
    // …and nothing may resume from the contaminated thread.
    await expect(source.sendUserInput({ text: "next real turn" })).rejects.toThrow(
      /rollback failed/,
    );
    await expect(source.fork({ sessionId: "fork-2", mode: "ephemeral" })).rejects.toThrow(
      /rollback failed/,
    );
    expect(requestMock.mock.calls.filter((c) => c[0] === "turn/start")).toHaveLength(1);

    await forkSession.close();
    await source.close();
  });

  it("serializes a native thread/fork behind an in-flight borrowed exact-fork turn", async () => {
    // Deliver turn/completed manually so the borrowed turn stays mid-flight
    // while a native fork tries to snapshot the source thread. Snapshotting
    // then would copy the not-yet-rolled-back borrowed turn into the child.
    let finishBorrowedTurn!: () => void;
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "source-thread" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "source-thread", turn: { id: "borrowed-turn" } });
        finishBorrowedTurn = () =>
          n("turn/completed", {
            threadId: "source-thread",
            turn: { id: "borrowed-turn", status: "completed" },
          });
      }
      if (method === "thread/fork") {
        captured.onNotification?.("thread/started", { thread: { id: "fork-thread" } });
        return { thread: { id: "fork-thread" } };
      }
      return {};
    });

    const provider = new CodexAppServerProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    const exactFork = await source.fork({
      sessionId: "exact-fork",
      mode: "ephemeral",
      configurationMode: "exact",
    });
    const exactSession = await exactFork.open(buildForkOpenParams());
    const exactCollected = collectUntilTerminal(exactSession);
    await exactSession.sendUserInput({ text: "feedback" });
    await rs.waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("turn/start", expect.anything()),
    );
    expect(
      await source.steerUserInput!({ text: "not for the fork", inputId: "source-input" }),
    ).toBe("deferred");
    await source.interrupt("source-only");
    expect(requestMock).not.toHaveBeenCalledWith("turn/steer", expect.anything());
    expect(requestMock).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());

    // A model-changing fork (e.g. a recap turn on a smaller tier) arrives
    // while the borrowed turn holds the thread.
    const nativeFork = await source.fork({ sessionId: "native-fork", mode: "ephemeral" });
    const nativeOpen = nativeFork.open(buildForkOpenParams({ model: "gpt-5.4-mini" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requestMock).not.toHaveBeenCalledWith("thread/fork", expect.anything());

    finishBorrowedTurn();
    const nativeSession = await nativeOpen;
    await exactCollected;

    // The snapshot only ran after the borrowed turn was rolled back.
    const methods = requestMock.mock.calls.map((c) => c[0]);
    expect(methods.indexOf("thread/rollback")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("thread/fork")).toBeGreaterThan(methods.indexOf("thread/rollback"));

    await nativeSession.close();
    await exactSession.close();
    await source.close();
  });

  it("refuses a native fork snapshot opened after a failed exact-fork rollback", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "source-thread" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "source-thread", turn: { id: "fork-turn" } });
        n("turn/completed", {
          threadId: "source-thread",
          turn: { id: "fork-turn", status: "completed" },
        });
      }
      if (method === "thread/rollback") throw new Error("rollback rejected");
      return {};
    });

    const provider = new CodexAppServerProvider();
    const source = await provider.openSession(
      buildParams({ sessionId: "source-session", isNewSession: true }),
    );
    // The native fork handle is created while the source is still clean, so
    // the fork() contamination gate passes…
    const nativeFork = await source.fork({ sessionId: "native-fork", mode: "ephemeral" });

    const exactFork = await source.fork({
      sessionId: "exact-fork",
      mode: "ephemeral",
      configurationMode: "exact",
    });
    const exactSession = await exactFork.open(buildForkOpenParams());
    const collected = collectUntilTerminal(exactSession);
    await exactSession.sendUserInput({ text: "feedback" });
    await collected;

    // …but open() re-checks inside the lane: the borrowed turn is now a
    // permanent part of the source history, so no child may snapshot it.
    await expect(nativeFork.open(buildForkOpenParams({ model: "gpt-5.4-mini" }))).rejects.toThrow(
      /rollback failed/,
    );
    expect(requestMock).not.toHaveBeenCalledWith("thread/fork", expect.anything());

    await exactSession.close();
    await source.close();
  });

  it("leaves login gating to ModelResolver instead of probing again on open", async () => {
    const provider = new CodexAppServerProvider();

    // ModelResolver has already selected this provider from AIToolState. A
    // second CLI status probe here would race that snapshot and duplicate the
    // expensive/error-prone provider checks on every session open.
    getCodexCliStatusMock.mockResolvedValueOnce({ loggedIn: false });
    await expect(provider.openSession(buildParams())).resolves.toBeDefined();
    expect(getCodexCliStatusMock).not.toHaveBeenCalled();
  });

  it("uses dynamic tools so subagents receive the exact provider callId before execution", async () => {
    const executeSubagent = rs.fn(async () => ({
      status: "completed",
      sessionId: "child-1",
      turnId: "child-turn-1",
      output: "done",
    }));
    let dynamicResponse: unknown;
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        captured.onNotification?.("turn/started", {
          threadId: "thr-1",
          turn: { id: "provider-turn-1" },
        });
        dynamicResponse = await captured.onServerRequest?.("item/tool/call", {
          threadId: "thr-1",
          turnId: "provider-turn-1",
          callId: "call-subagent-1",
          namespace: null,
          tool: "researcher",
          arguments: { prompt: "inspect" },
        });
        captured.onNotification?.("turn/completed", {
          threadId: "thr-1",
          turn: { id: "provider-turn-1", status: "completed" },
        });
      }
      return {};
    });
    const provider = new CodexAppServerProvider();
    const session = await provider.openSession(
      buildParams({
        subagentTools: [
          {
            name: "researcher",
            description: "Research a topic",
            inputSchema: {
              type: "object",
              properties: { prompt: { type: "string" } },
              required: ["prompt"],
            },
          },
        ],
        executeSubagent,
      }),
    );

    const startCall = requestMock.mock.calls.find((call) => call[0] === "thread/start");
    expect(startCall?.[1]).toMatchObject({
      dynamicTools: expect.arrayContaining([expect.objectContaining({ name: "researcher" })]),
    });
    expect((startCall?.[1] as { config: Record<string, unknown> }).config).not.toHaveProperty(
      "mcp_servers",
    );

    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "inspect" });
    await collected;

    expect(dynamicResponse).toMatchObject({ success: true });
    expect(executeSubagent).toHaveBeenCalledWith(
      "researcher",
      { prompt: "inspect" },
      { toolUseId: "call-subagent-1" },
    );

    await session.close();
  });

  it("maps agentMessage phase → turnPhase and emits the final answer as the result", async () => {
    const provider = new CodexAppServerProvider();

    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        n("item/completed", {
          item: {
            type: "agentMessage",
            id: "m1",
            text: "Let me check the weather.",
            phase: "commentary",
          },
          threadId: "thr-1",
          turnId: "turn-1",
          completedAtMs: 0,
        });
        n("item/completed", {
          item: { type: "agentMessage", id: "m2", text: "It's sunny.", phase: "final_answer" },
          threadId: "thr-1",
          turnId: "turn-1",
          completedAtMs: 0,
        });
        n("thread/tokenUsage/updated", {
          threadId: "thr-1",
          turnId: "turn-1",
          tokenUsage: usage(),
        });
        n("turn/completed", { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "weather?" });
    const msgs = await collected;

    expect(msgs.filter((m) => m.type === "text")).toEqual([
      { type: "text", content: "Let me check the weather.", turnPhase: "commentary" },
      { type: "text", content: "It's sunny.", turnPhase: "final" },
    ]);
    const result = msgs.find((m) => m.type === "result");
    expect(result).toMatchObject({ type: "result", content: "It's sunny." });
    expect(session.lastCompletedTurnCheckpoint).toBe("turn-1");
    expect(result).toMatchObject({
      accounting: {
        usage: {
          inputTokens: 5,
          outputTokens: 4,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
        },
        rawUsage: {
          input_tokens: 6,
          uncached_input_tokens: 5,
          output_tokens: 4,
          cached_tokens: 1,
          reasoning_tokens: 0,
        },
      },
    });

    expect(requestMock).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "thr-1", effort: "high" }),
    );
    await session.close();
  });

  it("passes outputSchema on turn/start and publishes one parsed structured terminal", async () => {
    const provider = new CodexAppServerProvider();
    const schema = {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    };
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-structured" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", {
          threadId: "thr-structured",
          turn: { id: "turn-structured" },
        });
        n("item/agentMessage/delta", {
          threadId: "thr-structured",
          turnId: "turn-structured",
          itemId: "m1",
          delta: '{"value":',
        });
        n("item/completed", {
          item: {
            type: "agentMessage",
            id: "m1",
            text: '{"value":7}',
            phase: "final_answer",
          },
          threadId: "thr-structured",
          turnId: "turn-structured",
          completedAtMs: 0,
        });
        n("turn/completed", {
          threadId: "thr-structured",
          turn: { id: "turn-structured", status: "completed" },
        });
      }
      return {};
    });

    const session = await provider.openSession(buildParams({ outputSchema: schema }));
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "return seven" });
    const messages = await collected;

    expect(requestMock).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "thr-structured", outputSchema: schema }),
    );
    expect(
      messages.some((message) => message.type === "text" || message.type === "text_delta"),
    ).toBe(false);
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      content: '{"value":7}',
      structuredOutput: { value: 7 },
    });
    await session.close();
  });

  it("fails a structured turn when app-server completes with non-JSON final text", async () => {
    const provider = new CodexAppServerProvider();
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-invalid-json" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", {
          threadId: "thr-invalid-json",
          turn: { id: "turn-invalid-json" },
        });
        n("item/completed", {
          item: { type: "agentMessage", id: "m1", text: "not json", phase: "final_answer" },
          threadId: "thr-invalid-json",
          turnId: "turn-invalid-json",
          completedAtMs: 0,
        });
        n("turn/completed", {
          threadId: "thr-invalid-json",
          turn: { id: "turn-invalid-json", status: "completed" },
        });
      }
      return {};
    });
    const session = await provider.openSession(
      buildParams({
        outputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "return seven" });
    expect(await collected).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("invalid structured output"),
      }),
    );
    await session.close();
  });

  it("rejects parsed structured output that does not match outputSchema", async () => {
    const provider = new CodexAppServerProvider();
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-invalid-value" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", {
          threadId: "thr-invalid-value",
          turn: { id: "turn-invalid-value" },
        });
        n("item/completed", {
          item: {
            type: "agentMessage",
            id: "m1",
            text: '{"value":"seven"}',
            phase: "final_answer",
          },
          threadId: "thr-invalid-value",
          turnId: "turn-invalid-value",
          completedAtMs: 0,
        });
        n("turn/completed", {
          threadId: "thr-invalid-value",
          turn: { id: "turn-invalid-value", status: "completed" },
        });
      }
      return {};
    });
    const session = await provider.openSession(
      buildParams({
        outputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "return seven" });

    expect(await collected).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("failed validation"),
      }),
    );
    await session.close();
  });

  it("fails a structured turn when app-server reports interruption", async () => {
    const provider = new CodexAppServerProvider();
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-interrupted" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", {
          threadId: "thr-interrupted",
          turn: { id: "turn-interrupted" },
        });
        n("turn/completed", {
          threadId: "thr-interrupted",
          turn: { id: "turn-interrupted", status: "interrupted" },
        });
      }
      return {};
    });
    const session = await provider.openSession(
      buildParams({
        outputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    );
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "return seven" });

    expect(await collected).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("status interrupted"),
      }),
    );
    await session.close();
  });

  it("aggregates every model request in a turn without double-counting prior turns", async () => {
    const provider = new CodexAppServerProvider();
    let turnNumber = 0;

    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        turnNumber += 1;
        const turnId = `turn-${turnNumber}`;
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: turnId } });

        if (turnNumber === 1) {
          n("thread/tokenUsage/updated", {
            threadId: "thr-1",
            turnId,
            tokenUsage: usage({
              totalTokens: 110,
              inputTokens: 100,
              cachedInputTokens: 90,
              outputTokens: 10,
            }),
          });
        } else {
          // Rate-limit and compaction events can repeat the current usage
          // snapshot without completing another model request. This is the
          // unchanged snapshot from turn 1 and must not be counted again.
          n("thread/tokenUsage/updated", {
            threadId: "thr-1",
            turnId,
            tokenUsage: usage({
              totalTokens: 110,
              inputTokens: 100,
              cachedInputTokens: 90,
              outputTokens: 10,
            }),
          });
          // `total` is cumulative for the whole Codex thread, while `last` is
          // only the latest API request. Two updates make this Rome turn's
          // delta 400k input / 360k cached / 2k output tokens. Each request is
          // below the long-context pricing threshold even though their
          // aggregate is above it.
          const firstRequestUsage = usage(
            {
              totalTokens: 201_000,
              inputTokens: 200_000,
              cachedInputTokens: 180_000,
              outputTokens: 1_000,
            },
            {
              totalTokens: 201_110,
              inputTokens: 200_100,
              cachedInputTokens: 180_090,
              outputTokens: 1_010,
            },
          );
          n("thread/tokenUsage/updated", {
            threadId: "thr-1",
            turnId,
            tokenUsage: firstRequestUsage,
          });
          // A delayed turn-1 notification must not roll back the dedupe
          // baseline; otherwise this repeated turn-2 snapshot is counted as a
          // third request.
          n("thread/tokenUsage/updated", {
            threadId: "thr-1",
            turnId: "turn-1",
            tokenUsage: usage({
              totalTokens: 110,
              inputTokens: 100,
              cachedInputTokens: 90,
              outputTokens: 10,
            }),
          });
          n("thread/tokenUsage/updated", {
            threadId: "thr-1",
            turnId,
            tokenUsage: firstRequestUsage,
          });
          n("thread/tokenUsage/updated", {
            threadId: "thr-1",
            turnId,
            tokenUsage: usage(
              {
                totalTokens: 201_000,
                inputTokens: 200_000,
                cachedInputTokens: 180_000,
                outputTokens: 1_000,
              },
              {
                totalTokens: 402_110,
                inputTokens: 400_100,
                cachedInputTokens: 360_090,
                outputTokens: 2_010,
              },
            ),
          });
        }

        n("item/completed", {
          item: {
            type: "agentMessage",
            id: `m-${turnNumber}`,
            text: `answer ${turnNumber}`,
            phase: "final_answer",
          },
          threadId: "thr-1",
          turnId,
          completedAtMs: 0,
        });
        n("turn/completed", {
          threadId: "thr-1",
          turn: { id: turnId, status: "completed" },
        });
      }
      return {};
    });

    const session = await provider.openSession(buildParams({ model: "gpt-5.6-sol" }));

    const firstCollected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "first" });
    const firstResult = (await firstCollected).find((m) => m.type === "result");
    expect(firstResult).toMatchObject({
      accounting: {
        usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 10 },
      },
    });

    const secondCollected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "second" });
    const secondResult = (await secondCollected).find((m) => m.type === "result");
    expect(secondResult).toMatchObject({
      accounting: {
        usage: { inputTokens: 40_000, cacheReadTokens: 360_000, outputTokens: 2_000 },
      },
    });
    expect(
      (secondResult as { accounting?: { costUsd?: number } })?.accounting?.costUsd,
    ).toBeCloseTo(0.44);

    await session.close();
  });

  it("ignores delayed token usage updates from a previous turn", async () => {
    const provider = new CodexAppServerProvider();

    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-2" } });
        n("thread/tokenUsage/updated", {
          threadId: "thr-1",
          turnId: "turn-1",
          tokenUsage: usage({ totalTokens: 999, inputTokens: 999, outputTokens: 999 }),
        });
        n("item/completed", {
          item: { type: "agentMessage", id: "m1", text: "current answer", phase: "final_answer" },
          threadId: "thr-1",
          turnId: "turn-2",
          completedAtMs: 0,
        });
        n("turn/completed", { threadId: "thr-1", turn: { id: "turn-2", status: "completed" } });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "hi" });
    const msgs = await collected;

    const result = msgs.find((m) => m.type === "result") as
      | { accounting?: { rawUsage?: unknown; usage?: unknown } }
      | undefined;
    expect(result?.accounting?.rawUsage).toBeUndefined();
    expect(result?.accounting?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await session.close();
  });

  it("unwraps mcpToolCall result so suspensions/cards survive, and skips non-tool items", async () => {
    const provider = new CodexAppServerProvider();
    const mcpResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            pendingInteraction: true,
            appId: "core",
            render: { kind: "inline", componentId: "question-card", builtin: true },
          }),
        },
      ],
    };
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        // The user-message echo must NOT become a tool.
        n("item/completed", {
          item: { type: "userMessage", id: "u1", content: [] },
          threadId: "thr-1",
          turnId: "turn-1",
          completedAtMs: 0,
        });
        n("item/started", {
          item: {
            type: "mcpToolCall",
            id: "call_1",
            server: "rome_ask_user",
            tool: "ask_question",
            arguments: { questions: [] },
            result: null,
          },
          threadId: "thr-1",
          turnId: "turn-1",
          startedAtMs: 0,
        });
        n("item/completed", {
          item: {
            type: "mcpToolCall",
            id: "call_1",
            server: "rome_ask_user",
            tool: "ask_question",
            arguments: { questions: [] },
            result: mcpResult,
          },
          threadId: "thr-1",
          turnId: "turn-1",
          completedAtMs: 0,
        });
        n("item/completed", {
          item: { type: "agentMessage", id: "m1", text: "asked.", phase: "final_answer" },
          threadId: "thr-1",
          turnId: "turn-1",
          completedAtMs: 0,
        });
        n("turn/completed", { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "ask me something" });
    const msgs = await collected;

    // userMessage echo is not emitted as a tool.
    expect(msgs.some((m) => m.type === "tool_use" && m.tool === "userMessage")).toBe(false);
    // The tool_use surfaces the real args (not the wrapper item).
    const use = msgs.find((m) => m.type === "tool_use");
    expect(use).toMatchObject({ tool: "ask_question", input: { questions: [] } });
    // The tool_result output is the unwrapped MCP result, so the webchat drain
    // loop can read pendingInteraction off it.
    const result = msgs.find((m) => m.type === "tool_result");
    expect(result).toMatchObject({ tool: "ask_question", output: mcpResult });
    await session.close();
  });

  it("normalizes turn plan snapshots and ignores wrong-turn or malformed updates", async () => {
    const provider = new CodexAppServerProvider();
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        n("turn/plan/updated", {
          threadId: "thr-1",
          turnId: "turn-1",
          explanation: null,
          plan: [
            { step: "Inspect provider events", status: "completed" },
            { step: "Render the panel", status: "inProgress" },
            { step: "Verify reload", status: "pending" },
          ],
        });
        n("turn/plan/updated", {
          threadId: "thr-1",
          turnId: "turn-old",
          explanation: "wrong turn",
          plan: [{ step: "Must not appear", status: "pending" }],
        });
        n("turn/plan/updated", {
          threadId: "thr-1",
          turnId: "turn-1",
          explanation: "malformed",
          plan: [{ step: "Bad status", status: "mystery" }],
        });
        // Experimental Plan Mode prose is not the structured work Plan.
        n("item/plan/delta", { threadId: "thr-1", turnId: "turn-1", delta: "prose" });
        n("turn/plan/updated", {
          threadId: "thr-1",
          turnId: "turn-1",
          explanation: "  Ready to verify  ",
          plan: [
            { step: "Inspect provider events", status: "completed" },
            { step: "Render the panel", status: "completed" },
            { step: "Verify reload", status: "inProgress" },
          ],
        });
        n("turn/completed", {
          threadId: "thr-1",
          turn: { id: "turn-1", status: "completed" },
        });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "implement the feature" });
    const plans = (await collected).filter((message) => message.type === "plan_update");

    expect(plans).toEqual([
      {
        type: "plan_update",
        plan: {
          steps: [
            { text: "Inspect provider events", status: "completed" },
            { text: "Render the panel", status: "in_progress" },
            { text: "Verify reload", status: "pending" },
          ],
        },
      },
      {
        type: "plan_update",
        plan: {
          explanation: "Ready to verify",
          steps: [
            { text: "Inspect provider events", status: "completed" },
            { text: "Render the panel", status: "completed" },
            { text: "Verify reload", status: "in_progress" },
          ],
        },
      },
    ]);
    await session.close();
  });

  it("emits an ImageGeneration tool pair (with inline image data) before the result", async () => {
    const provider = new CodexAppServerProvider();
    // Canonical 1x1 PNG; arrives inline on the imageGeneration item's `result`.
    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        n("item/completed", {
          item: {
            type: "imageGeneration",
            id: "img-1",
            status: "completed",
            revisedPrompt: "a red square",
            result: pngDataUrl,
          },
          threadId: "thr-1",
          turnId: "turn-1",
          completedAtMs: 0,
        });
        n("item/completed", {
          item: {
            type: "agentMessage",
            id: "m1",
            text: "here's your image",
            phase: "final_answer",
          },
          threadId: "thr-1",
          turnId: "turn-1",
          completedAtMs: 0,
        });
        n("turn/completed", { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "draw a red square" });
    const msgs = await collected;

    const use = msgs.find((m) => m.type === "tool_use" && m.tool === "ImageGeneration");
    expect(use).toBeTruthy();
    const result = msgs.find((m) => m.type === "tool_result" && m.tool === "ImageGeneration") as
      | { output?: Record<string, unknown> }
      | undefined;
    expect(result?.output).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(typeof result?.output?.data).toBe("string");
    // The image trace lands before the turn-closing result (the agent session
    // closes the turn sink on the first terminal block).
    const imageIx = msgs.findIndex((m) => m.type === "tool_result" && m.tool === "ImageGeneration");
    const terminalIx = msgs.findIndex((m) => m.type === "result");
    expect(imageIx).toBeGreaterThanOrEqual(0);
    expect(terminalIx).toBeGreaterThan(imageIx);
    expect(msgs[terminalIx]).toMatchObject({ content: "here's your image" });
    await session.close();
  });

  it("leaves turnPhase unset when phase is null (legacy model)", async () => {
    const provider = new CodexAppServerProvider();
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        n("item/completed", {
          item: { type: "agentMessage", id: "m1", text: "plain answer", phase: null },
          threadId: "thr-1",
          turnId: "turn-1",
          completedAtMs: 0,
        });
        n("turn/completed", { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "hi" });
    const msgs = await collected;

    const text = msgs.find((m) => m.type === "text");
    expect(text).toEqual({ type: "text", content: "plain answer" });
    expect(msgs.find((m) => m.type === "result")).toMatchObject({ content: "plain answer" });
    await session.close();
  });

  it("tags a usage-limit turn failure with code:usage_limit (structured codexErrorInfo)", async () => {
    const onQuotaExhausted = rs.fn();
    const provider = new CodexAppServerProvider({ onQuotaExhausted });
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        // `turn.error` is a structured TurnError object (camelCase), not a string.
        n("turn/completed", {
          threadId: "thr-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message: "You've hit your usage limit. Try again in 3 hours.",
              codexErrorInfo: "usageLimitExceeded",
            },
          },
        });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "hi" });
    const msgs = await collected;

    expect(msgs.find((m) => m.type === "error")).toMatchObject({
      type: "error",
      error: "You've hit your usage limit. Try again in 3 hours.",
      code: "usage_limit",
    });
    expect(onQuotaExhausted).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it("tags revoked Codex credentials before the terminal", async () => {
    let markerPersisted = false;
    let authStateMarked = false;
    markCodexAuthRevokedMock.mockImplementationOnce(async () => {
      markerPersisted = true;
    });
    const provider = new CodexAppServerProvider({
      onAuthRevoked: async () => {
        expect(markerPersisted).toBe(true);
        authStateMarked = true;
      },
    });
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        n("turn/completed", {
          threadId: "thr-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message:
                "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
            },
          },
        });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "hi" });
    const msgs = await collected;

    expect(markCodexAuthRevokedMock).toHaveBeenCalledTimes(1);
    expect(authStateMarked).toBe(true);
    expect(msgs.find((m) => m.type === "error")).toMatchObject({
      type: "error",
      error:
        "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      code: "auth_revoked",
    });
    await session.close();
  });

  it("does not tag a non-usage-limit turn failure", async () => {
    const provider = new CodexAppServerProvider();
    requestMock.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        captured.onNotification?.("thread/started", { thread: { id: "thr-1" } });
      }
      if (method === "turn/start") {
        const n = captured.onNotification!;
        n("turn/started", { threadId: "thr-1", turn: { id: "turn-1" } });
        n("turn/completed", {
          threadId: "thr-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: "stream disconnected", codexErrorInfo: "internalServerError" },
          },
        });
      }
      return {};
    });

    const session = await provider.openSession(buildParams());
    const collected = collectUntilTerminal(session);
    await session.sendUserInput({ text: "hi" });
    const msgs = await collected;

    const err = msgs.find((m) => m.type === "error");
    expect(err).toMatchObject({ type: "error", error: "stream disconnected" });
    expect((err as { code?: string }).code).toBeUndefined();
    await session.close();
  });
});
