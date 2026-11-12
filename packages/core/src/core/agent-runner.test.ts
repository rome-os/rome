import { createBackendTurnRunner } from "../app-host/backend-turn.js";
import { ChatSessionSettings } from "../webchat/chat-session-settings.js";
import { AgentRecordedSessions } from "../sessions/agent-recorded-sessions.js";
import type { Channel } from "../chats/connected-accounts/connected-account.js";
import { romeToolPorts } from "./rome-tool-ports.js";
import { startAfter, testReceipt, testTurnHandle } from "../test/turn-handle.js";
import { createLogger } from "../logger.js";
import { sessionOpeningFor } from "./session-opening.js";
import { chatPromptFacts } from "./chat-prompt-facts.js";
import type { PromptFacts } from "../agent/index.js";
import type { AgentDefinition } from "../agent/index.js";
import { claudeStoppedTurnResult, readAnswerShape, romeSessionTracing } from "../agent/index.js";
import { TurnUsageReporter } from "../app-host/turn-usage-reporter.js";
import { agentFolders } from "../paths.js";
import { canOpenChat } from "../webchat/privacy.js";
import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { version as uuidVersion } from "uuid";
import { AgentRunner } from "./agent-runner.js";
import { runDefer } from "../routines/defer.js";
import { createSubagentCalls } from "../agent/index.js";
import { AgentLoader } from "../app-host/agent-loader.js";
import { DrizzleSessionRepository, Session, type SessionRepository } from "../agent/index.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { ActionEngine } from "../apps/actions/engine.js";
import {
  MockModelProvider,
  createTestDb,
  installTestSpanHarness,
  type SpanHarness,
  type TestDb,
  createActionEngineRepos,
} from "../test/helpers.js";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { eq } from "drizzle-orm";
import { romeAgentTraceBlocks, sessions } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { openedInChat } from "./session-conversation.js";
import type { ForkRunParams } from "./types.js";
import { subagentLiveTurns, subagentSessions, subagentTurnLog } from "./subagent-call-ports.js";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import * as telemetry from "../telemetry.js" with { rstest: "importActual" };

const recordMetrics = rs.hoisted(() => rs.fn());
rs.mock("../telemetry.js", () => ({ ...telemetry, recordModelTurnMetrics: recordMetrics }));

import type { ModelSessionEvent, RenewalHandoffs, RomeTools } from "../agent/index.js";
import { ROME_TOOL_GROUPS } from "../agent/index.js";
import {
  executeActionTool,
  executeSubagentTool,
  listActionNames,
  noRomeTools,
  parseToolText,
  toolNames,
} from "../test/tool-calls.js";
import type { AgentEvent } from "../types.js";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { actionExecutionContext } from "../apps/actions/context.js";
import type { AppCatalog } from "../apps/catalog.js";
import {
  claimLegacyArtifactName,
  createEmptyLegacyArtifactBindings,
  formatArtifactId,
  type ArtifactIdentityContext,
} from "../apps/artifact-id.js";
import * as pathsModule from "../paths.js" with { rstest: "importActual" };

rs.mock("../paths.js", () => ({
  ...pathsModule,
  getProjectRoot: rs.fn(() => "/tmp/agent-runner-test"),
  getDefaultAgentWorkingDir: rs.fn(() => "/tmp/default-project"),
  getProfileDir: rs.fn(() => "/tmp/agent-runner-test/profile"),
  getProfileMemoryDir: rs.fn(() => "/tmp/agent-runner-test/memory"),
  getProfileInstalledAppsDir: rs.fn(() => "/tmp/agent-runner-test/installed-apps"),
}));

import {
  createSystemPrompts,
  type PromptSources,
  type RomeTool,
  type SystemPrompts,
} from "../agent/index.js";
import { createTestSystemPrompts } from "../test/system-prompts.js";
import { createSessionFromRun } from "./agent-runner.js";
import type {
  ModelProvider,
  ModelSession,
  ModelSessionParams,
  ProviderId,
  ThreadStart,
} from "./agent-runner.js";
import {
  createModelResolver,
  createTierModelsSetting,
  type ModelResolver,
  subagentToolName,
} from "../agent/index.js";
import {
  createSessions,
  type AgentSession,
  type SessionOpening,
  type AgentSessionKey,
  type Sessions,
  type AgentTurnHandle,
} from "../agent/index.js";
import { SkillLoader } from "../app-host/skill-loader.js";
import { TurnListeners, type TurnLifecycle, type TurnMiddleware } from "../agent/index.js";
import { AppTurnHooks } from "../app-host/app-turn-hooks.js";
import { AppTurnMiddleware } from "../app-host/app-turn-middleware.js";
import type {
  AgentTurnFinishedEvent,
  AgentTurnStartedEvent,
  ProviderSessionResetPolicy,
} from "@rome-os/app-runtime";
import type { TurnUsageFacts } from "../agent/index.js";
import { testChannelSurface } from "../test/channel-surface.js";
import type { TurnLinks, UnseenLine } from "../sessions/turn-links.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import {
  reportOf,
  bothAvailable,
  fakeAccounts,
  RESTRICTED_PLAN,
} from "../test/kit/model-accounts.js";

function createTestModelResolver({ providers }: { providers: ModelProvider[] }) {
  return createModelResolver({
    providers,
    accounts: fakeAccounts(bothAvailable()),
  });
}

function makeOpenSessionFromRun(
  providerId: ProviderId,
  run: (params: import("./agent-runner.js").ModelRunParams) => AsyncIterable<AgentEvent>,
): (params: ModelSessionParams) => Promise<import("./agent-runner.js").ModelSession> {
  return async (params) => createSessionFromRun(providerId, run, params);
}

const FIXTURES_DIR = join(import.meta.dirname, "..", "test", "fixtures", "agents");
const EXPLORE_TOOL = subagentToolName("core:test-explore");

/** Collect all messages from an async iterable into an array. */
async function collectMessages(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const messages: AgentEvent[] = [];
  for await (const msg of iterable) {
    messages.push(msg);
  }
  return messages;
}

const MOCK_ACCOUNTING = {
  provider: "mock",
  model: "mock-model",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
} as const;

/** The prompt and session a `defer` wake-up fires with, as runDefer stores them. */
async function deferredWake(sessionId: string, channel: string, threadId: string) {
  let args: Record<string, unknown> = {};
  await runDefer(
    {
      kind: "time",
      name: "Check CI",
      note: "Read CI run 42 for PR #7 and tell the guardian whether it passed.",
      fireAtMs: Date.now() + 5 * 60_000,
    },
    {
      context: {
        agentName: "main",
        sessionId,
        channelContext: { channel, threadId, channelUserId: "guardian" },
        turnId: "turn-that-deferred",
        scheduledAt: new Date("2026-11-09T12:00:00Z"),
      },
      createRoutine: async (created) => {
        args = created.args as Record<string, unknown>;
        return { routineId: "r-1" };
      },
    },
  );
  return { sessionId: args.sessionId as string, prompt: args.text as string };
}

describe("AgentRunner", () => {
  let testDb: TestDb;
  let agentLoader: AgentLoader;
  let artifactIdentity: ArtifactIdentityContext;
  let sessionRepository: SessionRepository;
  let systemPrompts: SystemPrompts;
  let actionRegistry: ActionRegistryImpl;
  let actionEngine: ActionEngine;
  let mockProvider: MockModelProvider;

  beforeEach(async () => {
    // Default: providers are healthy (not revoked) so the auth-revoked
    // short-circuit never fires unless a test opts in.

    testDb = createTestDb();

    artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    agentLoader = new AgentLoader(artifactIdentity);
    await agentLoader.loadAll(FIXTURES_DIR);

    sessionRepository = new DrizzleSessionRepository(testDb.db);
    systemPrompts = createTestSystemPrompts();
    actionRegistry = new ActionRegistryImpl();
    actionEngine = new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db));
    mockProvider = new MockModelProvider();
  });

  afterEach(() => {
    testDb.close();
  });

  it("mock sessions reject a branch with a clear unsupported error", () => {
    expect(() =>
      createSessionFromRun("mock", async function* () {}, {
        config: { model: "mock-model", systemPrompt: "system", builtinTools: [] },
        tools: noRomeTools(),
        thread: {
          kind: "branch",
          at: { provider: "mock", modelThreadId: "thread", checkpointId: "turn" },
          lifetime: "ephemeral",
        },
      }),
    ).toThrow("Branching a thread is not supported by this provider");
  });

  it("reuses a code-backed session across acquires without resolving a provider", async () => {
    // A code-backed session's null model session reports providerId "mock", but
    // the resolved active provider is real (here "anthropic"). The reuse check
    // must NOT compare those — otherwise webchat (which reacquires on every send)
    // would close + reopen the session every turn, churning the session id and a
    // DB row each time. Regression guard for the canReuseProviderSnapshot
    // code-backed short-circuit.
    const anthropic: ModelProvider = {
      id: "anthropic",
      builtinTools: new Set<string>(),
      // A code-backed agent never opens a provider query; if reuse breaks and the
      // session is reopened, this would still not run (null session), so the only
      // observable symptom is a new session instance/id — which we assert against.
      openSession: async () => {
        throw new Error("code-backed agent must not open a provider session");
      },
    };
    const modelResolver = createTestModelResolver({
      providers: [anthropic],
    });
    const manager = createSessions(managerDeps(modelResolver));

    // Webchat retains long-lived conversation semantics across reacquires.
    const key = {
      agentName: "test-code-backed",
      channelThreadKey: "webchat:session-reuse",
    };
    const first = await manager.open(key);
    const second = await manager.open(key);

    // Same live instance, same session id — not closed + reopened.
    expect(second).toBe(first);
    expect(second.sessionId).toBe(first.sessionId);

    await first.close("shutdown");
  });

  it("canonicalizes a legacy agent name before keying and persisting a session", async () => {
    const legacyBindings = createEmptyLegacyArtifactBindings();
    const namespacedLoader = new AgentLoader({ legacyBindings });
    await namespacedLoader.loadAll(FIXTURES_DIR);
    const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
    const modelResolver = createTestModelResolver({ providers: [provider] });
    const manager = createSessions({
      ...managerDeps(modelResolver),
      agentLoader: namespacedLoader,
      sessionRepository: new DrizzleSessionRepository(testDb.db),
    });

    const session = await manager.open({
      agentName: "test-main",
      channelThreadKey: "webchat:canonical-agent",
    });

    expect(session.key.agentName).toBe("core:test-main");
    const [row] = await testDb.db.select().from(sessions).where(eq(sessions.id, session.sessionId));
    expect(row?.agentName).toBe("core:test-main");

    await session.close("shutdown");
  });

  it("fills a re-entry's conversation id from its channel address", async () => {
    const webchatRepo = new ChatsWebChatRepository(testDb.db);
    await webchatRepo.createSession("chat-1", "Webchat chat");
    const stop = new Error("stop after open");
    const resume = rs.fn(async () => {
      throw stop;
    });
    const manager = { resume } as unknown as Sessions;
    const runner = new AgentRunner(manager, agentLoader, webchatRepo);

    await expect(
      collectMessages(
        runner.run({
          agentName: "test-main",
          sessionId: "agent-session-1",
          prompt: "continue",
          threadContext: { channel: "webchat", threadId: "chat-1" },
        }),
      ),
    ).rejects.toBe(stop);

    expect(resume).toHaveBeenCalledWith(
      { id: "agent-session-1", agent: "test-main" },
      expect.objectContaining({
        threadContext: { channel: "webchat", threadId: "chat-1", romeSessionId: "chat-1" },
      }),
    );
  });

  it.each([
    ["saves", true, ["trace"]],
    ["leaves", undefined, []],
  ])("%s a webchat turn's trace when the caller asks, without transcript rows", async (_label, persistTrace, roles) => {
    const webchatRepo = new ChatsWebChatRepository(testDb.db);
    await webchatRepo.createSession("chat-trace", "Webchat chat");
    const provider: ModelProvider = {
      id: "anthropic",
      builtinTools: new Set<string>(),
      openSession: makeOpenSessionFromRun("anthropic", async function* () {
        yield { type: "result", content: "Deferred check done." };
      }),
    };
    const manager = createSessions(managerDeps(createTestModelResolver({ providers: [provider] })));
    const runner = new AgentRunner(manager, agentLoader, webchatRepo);

    await collectMessages(
      runner.run({
        agentName: "test-main",
        channelThreadKey: "webchat:chat-trace",
        prompt: "continue",
        threadContext: { channel: "webchat", threadId: "chat-trace", romeSessionId: "chat-trace" },
        persistTrace,
        persistTranscript: false,
      }),
    );

    const messages = await webchatRepo.getMessages("chat-trace");
    expect(messages.map((message) => message.role)).toEqual(roles);
    await manager.shutdown();
  });

  it.each([
    ["writes", undefined, true],
    ["leaves out", false, false],
  ])("%s a turn's answer in its transcript as the caller asks, and keeps its trace", async (_label, persistAnswer, answered) => {
    const webchatRepo = new ChatsWebChatRepository(testDb.db);
    await webchatRepo.createSession("chat-answer", "Webchat chat");
    const provider: ModelProvider = {
      id: "anthropic",
      builtinTools: new Set<string>(),
      openSession: makeOpenSessionFromRun("anthropic", async function* () {
        yield { type: "result", content: "Deferred check done." };
      }),
    };
    const manager = createSessions(managerDeps(createTestModelResolver({ providers: [provider] })));
    const runner = new AgentRunner(manager, agentLoader, webchatRepo);

    await collectMessages(
      runner.run({
        agentName: "test-main",
        channelThreadKey: "webchat:chat-answer",
        prompt: "continue",
        threadContext: {
          channel: "webchat",
          threadId: "chat-answer",
          romeSessionId: "chat-answer",
        },
        persistTrace: true,
        persistAnswer,
      }),
    );

    const roles = (await webchatRepo.getMessages("chat-answer")).map((message) => message.role);
    expect(roles).toContain("trace");
    expect(roles.includes("assistant")).toBe(answered);
    await manager.shutdown();
  });

  it("records fresh runs that name one session into it, each in its own agent session", async () => {
    const webchatRepo = new ChatsWebChatRepository(testDb.db);
    await webchatRepo.ensureRomeSession({
      id: "shared-record",
      type: "action",
      name: "Shared record",
      agentName: "test-main",
    });
    const opened: ModelSessionParams["thread"][] = [];
    const provider: ModelProvider = {
      id: "anthropic",
      builtinTools: new Set<string>(),
      openSession: async (params) => {
        opened.push(params.thread);
        return createSessionFromRun(
          "anthropic",
          async function* () {
            yield { type: "result", content: "decided" };
          },
          params,
        );
      },
    };
    const manager = createSessions(managerDeps(createTestModelResolver({ providers: [provider] })));
    const runner = new AgentRunner(manager, agentLoader, webchatRepo);
    for (const prompt of ["batch one", "batch two"]) {
      await collectMessages(
        runner.run({ agentName: "test-main", prompt, romeSessionId: "shared-record" }),
      );
    }
    // No history carried: each run opened a session of its own, new to the provider.
    expect(opened).toHaveLength(2);
    expect(opened).toEqual([{ kind: "new" }, { kind: "new" }]);
    // Both runs are in the one session: a trace and an answer each.
    const roles = (await webchatRepo.getMessages("shared-record")).map((m) => m.role);
    expect(roles.filter((role) => role === "trace")).toHaveLength(2);
    expect(roles.filter((role) => role === "assistant")).toHaveLength(2);
    await manager.shutdown();
  });

  it.each([
    ["keeps", "Following · important (1)"],
    ["keeps no", undefined],
  ])("%s a system turn's input in its trace as the caller asks, never as a chat line", async (_label, inputLabel) => {
    const webchatRepo = new ChatsWebChatRepository(testDb.db);
    await webchatRepo.ensureRomeSession({
      id: "system-input",
      type: "action",
      name: "System input",
      agentName: "test-main",
    });
    const provider: ModelProvider = {
      id: "anthropic",
      builtinTools: new Set<string>(),
      openSession: makeOpenSessionFromRun("anthropic", async function* () {
        yield { type: "result", content: "" };
      }),
    };
    const manager = createSessions(managerDeps(createTestModelResolver({ providers: [provider] })));
    const runner = new AgentRunner(manager, agentLoader, webchatRepo);
    const prompt = '<external_events untrusted="true" delivery="important">…</external_events>';
    await collectMessages(
      runner.run({
        agentName: "test-main",
        prompt,
        romeSessionId: "system-input",
        persistTranscript: false,
        ...(inputLabel ? { inputLabel } : {}),
      }),
    );
    const blocks = testDb.db
      .select({ content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .where(eq(romeAgentTraceBlocks.sessionId, "system-input"))
      .all()
      .map((row) => JSON.parse(row.content) as { type: string; label?: string; content?: string });
    const inputs = blocks.filter((block) => block.type === "system_input");
    expect(inputs).toEqual(
      inputLabel ? [{ type: "system_input", label: inputLabel, content: prompt }] : [],
    );
    // It is the turn's input in the trace, not a line of the conversation.
    const roles = (await webchatRepo.getMessages("system-input")).map((m) => m.role);
    expect(roles.filter((role) => role === "user" || role === "assistant")).toEqual([]);
    await manager.shutdown();
  });

  it("runs a forked turn from the matching live source session", async () => {
    const inputs: Array<{ prompt: string; tier?: string }> = [];
    const source = {
      key: { agentName: "test-main", channelThreadKey: "webchat:sess-1" },
      sessionId: "source-session",
      status: "idle" as const,
      submit: rs.fn(),
      async *fork(input: { prompt: string; tier?: string }) {
        inputs.push(input);
        yield { type: "result", content: "Fork summary", agent: "test-main" } as const;
      },
      onStatusChange: rs.fn(() => () => undefined),
      stop: rs.fn(async () => undefined),
      close: rs.fn(async () => undefined),
    };
    const manager = {
      open: rs.fn(),
      find: rs.fn(() => source),
      shutdown: rs.fn(async () => undefined),
    } as unknown as Sessions;
    const runner = new AgentRunner(manager, agentLoader);

    const messages = await collectMessages(
      runner.runForked({
        agentName: "test-main",
        sourceSessionId: "source-session",
        channelThreadKey: "webchat:sess-1",
        prompt: "summarize",
        tier: "small",
      }),
    );

    expect(inputs).toEqual([{ prompt: "summarize", tier: "small" }]);
    expect(messages).toEqual([{ type: "result", content: "Fork summary", agent: "test-main" }]);
  });

  it("hands the forked turn the person who asked for the fork", async () => {
    const inputs: Array<{ actor?: object }> = [];
    const source = {
      key: { agentName: "test-main", channelThreadKey: "webchat:sess-1" },
      sessionId: "source-session",
      status: "idle" as const,
      submit: rs.fn(),
      async *fork(input: { actor?: object }) {
        inputs.push(input);
        yield { type: "result", content: "ok", agent: "test-main" } as const;
      },
      onStatusChange: rs.fn(() => () => undefined),
      stop: rs.fn(async () => undefined),
      close: rs.fn(async () => undefined),
    };
    const manager = {
      open: rs.fn(),
      find: rs.fn(() => source),
      shutdown: rs.fn(async () => undefined),
    } as unknown as Sessions;
    const visitor = { kind: "visitor", accountId: "acct-v", email: "v@example.com" } as const;
    await collectMessages(
      new AgentRunner(manager, agentLoader).runForked({
        agentName: "test-main",
        sourceSessionId: "source-session",
        channelThreadKey: "webchat:sess-1",
        prompt: "summarize",
        actor: visitor,
      }),
    );
    expect(inputs[0]?.actor).toBe(visitor);
  });

  it("records a forked run as a fork rome session with parent lineage", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      await repo.createSession("parent-chat", "Fixing the build");

      const source = {
        key: { agentName: "main", channelThreadKey: "webchat:parent-chat" },
        sessionId: "source-session",
        status: "idle" as const,
        submit: rs.fn(),
        async *fork(input: { prompt: string }) {
          yield {
            type: "turn_start",
            turnId: "fork-turn",
            sessionId: "fork-session",
            userPrompt: input.prompt,
            agent: "main",
          } as const;
          yield { type: "text", content: "thinking it over", agent: "main" } as const;
          yield { type: "result", content: "Fork summary", agent: "main" } as const;
          yield {
            type: "turn_end",
            turnId: "fork-turn",
            status: "completed",
            durationMs: 5,
            agent: "main",
          } as const;
        },
        onStatusChange: rs.fn(() => () => undefined),
        stop: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager = {
        open: rs.fn(),
        find: rs.fn(() => source),
        shutdown: rs.fn(async () => undefined),
      } as unknown as Sessions;
      const runner = new AgentRunner(manager, agentLoader, repo);

      const messages = await collectMessages(
        runner.runForked({
          agentName: "main",
          sourceSessionId: "source-session",
          channelThreadKey: "webchat:parent-chat",
          prompt: "summarize",
          threadContext: {
            channel: "webchat",
            threadId: "parent-chat",
            romeSessionId: "parent-chat",
            threadName: "Fixing the build",
            threadType: "private",
            deviceFolder: { deviceId: "mac", deviceName: "macbook", platform: "macos", path: "/w" },
          },
          parentTurnId: "parent-turn-1",
          label: "recap",
        }),
      );
      expect(messages.map((m) => m.type)).toEqual(["turn_start", "text", "result", "turn_end"]);

      const forkSession = await repo.getSession("fork-session");
      expect(forkSession).toMatchObject({
        type: "fork",
        name: "recap: Fixing the build",
        agentName: null,
        parentSessionId: "parent-chat",
        parentTurnId: "parent-turn-1",
        triggerKind: "fork",
        triggerName: "recap",
        // Follow-up turns of the fork chat rebuild their context from this row.
        deviceFolder: { deviceId: "mac", deviceName: "macbook", platform: "macos", path: "/w" },
      });

      const transcript = await repo.getMessages("fork-session");
      expect(transcript.map((m) => m.role)).toEqual(["user", "trace", "assistant"]);
      const trace = await repo.getTraceContentByTurn("fork-session", "fork-turn");
      expect(JSON.parse(trace?.content ?? "[]").map((b: { type: string }) => b.type)).toEqual([
        "turn_start",
        "text",
        "result",
        "turn_end",
      ]);
    } finally {
      testDb.close();
    }
  });

  it("records an agent an action starts from a private chat as that chat's owner's, and none once the chat is gone", async () => {
    const repo = new ChatsWebChatRepository(testDb.db);
    await repo.createSession(
      "visitor-task",
      "Task",
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      "webchat",
      null,
      { ownerKey: "visitor:a" },
    );
    await repo.setSessionTrigger("visitor-task", { triggerKind: "concierge", triggerName: "T" });
    const runner = createRunner(
      new MockModelProvider([
        [{ type: "result", content: "Found it" }],
        [{ type: "result", content: "Found it" }],
      ]),
    );
    const runFrom = (executionId: string, chatId: string) =>
      actionExecutionContext.run(
        {
          executionId,
          rootExecutionId: executionId,
          initiator: "agent:main",
          actionName: "some-app:research",
          channelContext: { channel: "webchat", threadId: chatId },
        },
        () => collectMessages(runner.run({ agentName: "test-main", prompt: "Look it up" })),
      );
    await runFrom("exec-private", "visitor-task");
    expect(await repo.getSession("action:exec-private:core:test-main")).toMatchObject({
      ownerKey: "visitor:a",
      triggerKind: "concierge_fork",
    });
    // Called from a chat that is gone: nothing is saved for the run.
    await runFrom("exec-orphan", "deleted-chat");
    expect(await repo.getSession("action:exec-orphan:core:test-main")).toBeNull();
  });

  it("does not run a fork of a chat that is gone, and publishes no stream for it", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      const turnStreams = createAgentTurnStreamRegistry();
      const source = {
        key: { agentName: "main", channelThreadKey: "webchat:task-chat" },
        sessionId: "source-session",
        status: "idle" as const,
        submit: rs.fn(),
        async *fork() {
          yield {
            type: "turn_start",
            turnId: "fork-turn",
            sessionId: "fork-session",
            userPrompt: "x",
            agent: "main",
          } as const;
          yield { type: "result", content: "Noted", agent: "main" } as const;
        },
        onStatusChange: rs.fn(() => () => undefined),
        stop: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager = {
        open: rs.fn(),
        find: rs.fn(() => source),
        shutdown: rs.fn(async () => undefined),
      } as unknown as Sessions;
      const runner = new AgentRunner(manager, agentLoader, repo, turnStreams);
      // The task chat the fork is of was deleted before the fork was saved.
      await expect(
        collectMessages(
          runner.runForked({
            agentName: "main",
            sourceSessionId: "source-session",
            channelThreadKey: "webchat:task-chat",
            prompt: "a note",
            threadContext: {
              channel: "webchat",
              threadId: "task-chat",
              romeSessionId: "task-chat",
            },
            label: "feedback",
          }),
        ),
      ).rejects.toThrow("was not found");
      expect(await repo.getSession("fork-session")).toBeNull();
      expect(turnStreams.get("fork-turn")).toBeUndefined();
    } finally {
      testDb.close();
    }
  });

  it("stamps a fork of a visitor's task chat private to them when it is made", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      await repo.createSession(
        "task-chat",
        "Task",
        undefined,
        undefined,
        undefined,
        undefined,
        null,
        "webchat",
        null,
        { ownerKey: "visitor:a" },
      );
      await repo.setSessionTrigger("task-chat", { triggerKind: "concierge", triggerName: "Task" });
      const source = {
        key: { agentName: "main", channelThreadKey: "webchat:task-chat" },
        sessionId: "source-session",
        status: "idle" as const,
        submit: rs.fn(),
        async *fork(input: { prompt: string }) {
          yield {
            type: "turn_start",
            turnId: "fork-turn",
            sessionId: "fork-session",
            userPrompt: input.prompt,
            agent: "main",
          } as const;
          yield { type: "result", content: "Noted", agent: "main" } as const;
          yield {
            type: "turn_end",
            turnId: "fork-turn",
            status: "completed",
            durationMs: 5,
            agent: "main",
          } as const;
        },
        onStatusChange: rs.fn(() => () => undefined),
        stop: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager = {
        open: rs.fn(),
        find: rs.fn(() => source),
        shutdown: rs.fn(async () => undefined),
      } as unknown as Sessions;
      const runner = new AgentRunner(manager, agentLoader, repo);
      await collectMessages(
        runner.runForked({
          agentName: "main",
          sourceSessionId: "source-session",
          channelThreadKey: "webchat:task-chat",
          prompt: "a note on this answer",
          threadContext: { channel: "webchat", threadId: "task-chat", romeSessionId: "task-chat" },
          label: "feedback",
        }),
      );
      // Never promoted, it is private from the start, so deleting the task
      // chat does not open it.
      expect(await repo.getSession("fork-session")).toMatchObject({
        type: "fork",
        ownerKey: "visitor:a",
        triggerKind: "concierge_fork",
        triggerName: "feedback",
      });
      await repo.deleteSession("task-chat");
      const canOpen = (owner: string) =>
        canOpenChat((id) => repo.getSession(id), "fork-session", owner);
      expect(await canOpen("visitor:a")).toBe(true);
      expect(await canOpen("guardian")).toBe(false);
    } finally {
      testDb.close();
    }
  });

  describe("a resumed session whose caller names no conversation", () => {
    async function resumedSession(db: DrizzleDb, chatId: string) {
      // The chat that has the session is read from the session's stored row.
      const now = new Date();
      await db.insert(sessions).values({
        id: "agent-session",
        agentName: "main",
        channelThreadKey: "telegram:t1",
        chatId,
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      });
      type TurnRef = { romeSessionId?: string; romeSessionType?: string };
      const turns: TurnRef[] = [];
      const session = {
        key: { agentName: "main", channelThreadKey: "telegram:t1" },
        sessionId: "agent-session",
        status: "idle" as const,
        submit: rs.fn((input: { prompt: string }, options?: TurnRef) => {
          turns.push({ romeSessionId: options?.romeSessionId });
          return testReceipt(
            testTurnHandle({
              turnId: "resumed-turn",
              turnContext: context.active(),
              events: (async function* () {
                yield {
                  type: "session_init",
                  sessionId: "agent-session",
                  systemPrompt: "",
                  userPrompt: input.prompt,
                } as const;
                yield {
                  type: "turn_start",
                  turnId: "resumed-turn",
                  sessionId: "agent-session",
                  userPrompt: input.prompt,
                  agent: "main",
                } as const;
                yield { type: "result", content: "Done", agent: "main" } as const;
              })(),
            }),
          );
        }),
        onStatusChange: rs.fn(() => () => undefined),
        stop: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager = {
        open: rs.fn(async () => session),
        resume: rs.fn(async () => session),
        find: rs.fn(),
        shutdown: rs.fn(async () => undefined),
      } as unknown as Sessions;
      // The chat type a turn records under, as its runner names it on the
      // session's start.
      const see = (messages: { type: string; romeSession?: { _type: string } }[]) => {
        const types = messages.flatMap((m) =>
          m.type === "session_init" ? [m.romeSession?._type] : [],
        );
        types.forEach((type, ix) => {
          if (turns[ix]) turns[ix].romeSessionType = type;
        });
      };
      return { manager, turns, session, see };
    }

    it("leaves a recorded channel conversation to the inbox", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        await repo.ensureRomeSession({
          id: "channel:telegram:t1",
          type: "channel",
          name: "Telegram thread",
          agentName: null,
        });
        const { manager, turns, see } = await resumedSession(testDb.db, "channel:telegram:t1");
        const runner = new AgentRunner(manager, agentLoader, repo);

        see(
          await collectMessages(
            runner.run({ agentName: "main", sessionId: "agent-session", prompt: "continue" }),
          ),
        );

        expect(turns[0]?.romeSessionId).toMatch(/^action:/);
        expect(turns[0]?.romeSessionType).toBe("action");
        await expect(repo.getMessages("channel:telegram:t1")).resolves.toEqual([]);
      } finally {
        testDb.close();
      }
    });

    it("writes the prompt into a recorded subagent conversation it alone records", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        await repo.ensureRomeSession({
          id: "child-chat",
          type: "subagent",
          name: "researcher: Parent",
          agentName: "researcher",
        });
        const { manager, turns, see } = await resumedSession(testDb.db, "child-chat");
        const runner = new AgentRunner(manager, agentLoader, repo);

        see(
          await collectMessages(
            runner.run({ agentName: "main", sessionId: "agent-session", prompt: "continue" }),
          ),
        );

        expect(turns).toEqual([{ romeSessionId: "child-chat", romeSessionType: "subagent" }]);
        const roles = (await repo.getMessages("child-chat")).map((m) => m.role);
        expect(roles).toContain("user");
      } finally {
        testDb.close();
      }
    });

    it("leaves a turn under a webchat thread to that chat", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        await repo.ensureRomeSession({
          id: "child-chat",
          type: "subagent",
          name: "researcher: Parent",
          agentName: "researcher",
        });
        const { manager, turns, see } = await resumedSession(testDb.db, "child-chat");
        const runner = new AgentRunner(manager, agentLoader, repo);

        see(
          await collectMessages(
            runner.run({
              agentName: "main",
              sessionId: "agent-session",
              prompt: "continue",
              threadContext: {
                channel: "webchat",
                threadId: "parent-chat",
                threadName: "Parent",
                threadType: "private",
                romeSessionId: "parent-chat",
              },
            }),
          ),
        );

        expect(turns).toEqual([{ romeSessionId: "parent-chat", romeSessionType: "webchat" }]);
        await expect(repo.getMessages("child-chat")).resolves.toEqual([]);
      } finally {
        testDb.close();
      }
    });

    it("leaves a turn under a messaging thread to that thread", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        await repo.ensureRomeSession({
          id: "child-chat",
          type: "subagent",
          name: "researcher: Telegram thread",
          agentName: "researcher",
        });
        const { manager, turns, see } = await resumedSession(testDb.db, "child-chat");
        const runner = new AgentRunner(manager, agentLoader, repo);

        // A backend turn delivers its reply to the thread and records it in the
        // thread's conversation under this turn, so the trace stays there too.
        see(
          await collectMessages(
            runner.run({
              agentName: "main",
              sessionId: "agent-session",
              prompt: "continue",
              threadContext: { channel: "telegram", threadId: "t1", threadType: "private" },
            }),
          ),
        );

        expect(turns).toEqual([
          { romeSessionId: "channel:telegram:t1", romeSessionType: "channel" },
        ]);
        await expect(repo.getMessages("child-chat")).resolves.toEqual([]);
      } finally {
        testDb.close();
      }
    });

    it("writes a recorded subagent transcript when the caller keeps its own", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        await repo.ensureRomeSession({
          id: "child-chat",
          type: "subagent",
          name: "researcher: Parent",
          agentName: "researcher",
        });
        const { manager, turns, see } = await resumedSession(testDb.db, "child-chat");
        const runner = new AgentRunner(manager, agentLoader, repo);

        // A caller that keeps its own transcript keeps it for its channel,
        // not for this conversation.
        see(
          await collectMessages(
            runner.run({
              agentName: "main",
              sessionId: "agent-session",
              prompt: "continue",
              persistTrace: true,
              persistTranscript: false,
            }),
          ),
        );

        expect(turns).toEqual([{ romeSessionId: "child-chat", romeSessionType: "subagent" }]);
        const roles = (await repo.getMessages("child-chat")).map((m) => m.role);
        expect(roles).toEqual(expect.arrayContaining(["user", "assistant"]));
      } finally {
        testDb.close();
      }
    });

    it("leaves a saved fork chat to the webchat route on a backend turn", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        await repo.ensureRomeSession({
          id: "fork-chat",
          type: "fork",
          name: "Fork chat",
          agentName: "main",
        });
        const { manager, turns, see } = await resumedSession(testDb.db, "fork-chat");
        const runner = new AgentRunner(manager, agentLoader, repo);

        see(
          await collectMessages(
            runner.run({
              agentName: "main",
              sessionId: "agent-session",
              prompt: "continue",
              threadContext: {
                channel: "webchat",
                threadId: "fork-chat",
                threadName: "Fork chat",
                threadType: "private",
                romeSessionId: "fork-chat",
              },
              persistTrace: true,
              persistTranscript: false,
            }),
          ),
        );

        expect(turns).toEqual([{ romeSessionId: "fork-chat", romeSessionType: "webchat" }]);
        const roles = (await repo.getMessages("fork-chat")).map((m) => m.role);
        expect(roles).not.toContain("user");
        expect(roles).not.toContain("assistant");
      } finally {
        testDb.close();
      }
    });

    it("leaves a recorded webchat conversation to the webchat route", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        await repo.createSession("user-chat", "User chat");
        const { manager, turns, see } = await resumedSession(testDb.db, "user-chat");
        const runner = new AgentRunner(manager, agentLoader, repo);

        see(
          await collectMessages(
            runner.run({ agentName: "main", sessionId: "agent-session", prompt: "continue" }),
          ),
        );

        expect(turns[0]?.romeSessionId).toMatch(/^action:/);
        await expect(repo.getMessages("user-chat")).resolves.toEqual([]);
      } finally {
        testDb.close();
      }
    });

    it("records into the chat an open session's opener named, until it is reopened", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        await repo.createSession("user-chat", "User chat");
        const { manager, turns, see, session } = await resumedSession(testDb.db, "user-chat");
        // The session is still open from a caller that named the chat. A
        // reopened one is the case above, which leaves the chat alone.
        await openedInChat(undefined, session, "user-chat");
        const runner = new AgentRunner(manager, agentLoader, repo);

        see(
          await collectMessages(
            runner.run({ agentName: "main", sessionId: "agent-session", prompt: "continue" }),
          ),
        );

        expect(turns[0]?.romeSessionId).toBe("user-chat");
      } finally {
        testDb.close();
      }
    });

    it("does not recreate a recorded conversation that was deleted", async () => {
      const testDb = createTestDb();
      try {
        const repo = new ChatsWebChatRepository(testDb.db);
        // The session's row still names the chat, which no longer exists.
        const { manager, turns, see } = await resumedSession(testDb.db, "deleted-chat");
        const runner = new AgentRunner(manager, agentLoader, repo);

        see(
          await collectMessages(
            runner.run({ agentName: "main", sessionId: "agent-session", prompt: "continue" }),
          ),
        );

        expect(turns[0]?.romeSessionId).toMatch(/^action:/);
        expect(turns[0]?.romeSessionType).toBe("action");
        await expect(repo.getSession("deleted-chat")).resolves.toBeNull();
      } finally {
        testDb.close();
      }
    });
  });

  it("links a fork to the chat that has its source session when no thread names one", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      await repo.createSession("stored-chat", "Stored chat");
      const now = new Date();
      await testDb.db.insert(sessions).values({
        id: "source-session",
        agentName: "main",
        channelThreadKey: "webchat:stored-chat",
        chatId: "stored-chat",
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      });

      const source = {
        key: { agentName: "main", channelThreadKey: "webchat:stored-chat" },
        sessionId: "source-session",
        status: "idle" as const,
        submit: rs.fn(),
        async *fork(input: { prompt: string }) {
          yield {
            type: "turn_start",
            turnId: "fork-turn",
            sessionId: "fork-session",
            userPrompt: input.prompt,
            agent: "main",
          } as const;
          yield { type: "result", content: "Fork summary", agent: "main" } as const;
        },
        onStatusChange: rs.fn(() => () => undefined),
        stop: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager = {
        open: rs.fn(),
        find: rs.fn(() => source),
        shutdown: rs.fn(async () => undefined),
      } as unknown as Sessions;
      const runner = new AgentRunner(manager, agentLoader, repo);

      await collectMessages(
        runner.runForked({
          agentName: "main",
          sourceSessionId: "source-session",
          channelThreadKey: "webchat:stored-chat",
          prompt: "summarize",
          label: "recap",
        }),
      );

      await expect(repo.getSession("fork-session")).resolves.toMatchObject({
        type: "fork",
        name: "recap: Stored chat",
        parentSessionId: "stored-chat",
      });
    } finally {
      testDb.close();
    }
  });

  it("records the chat that has a stored fork when its consumer stops early", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      const recordSessionInChat = rs.spyOn(repo, "recordSessionInChat");
      const source = {
        key: { agentName: "main", channelThreadKey: "webchat:stored-chat" },
        sessionId: "source-session",
        status: "idle" as const,
        submit: rs.fn(),
        async *fork(input: { prompt: string }) {
          yield {
            type: "turn_start",
            turnId: "fork-turn",
            sessionId: "fork-session",
            userPrompt: input.prompt,
            agent: "main",
          } as const;
          yield { type: "result", content: "Fork summary", agent: "main" } as const;
        },
        onStatusChange: rs.fn(() => () => undefined),
        stop: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager = {
        open: rs.fn(),
        find: rs.fn(() => source),
        shutdown: rs.fn(async () => undefined),
      } as unknown as Sessions;
      const runner = new AgentRunner(manager, agentLoader, repo);

      for await (const message of runner.runForked({
        agentName: "main",
        sourceSessionId: "source-session",
        channelThreadKey: "webchat:stored-chat",
        prompt: "summarize",
      })) {
        if (message.type === "turn_start") break;
      }

      expect(recordSessionInChat).toHaveBeenCalledWith("fork-session", "fork-session");
    } finally {
      testDb.close();
    }
  });

  it("lists a forked run as a live turn of its own session", async () => {
    const source = {
      key: { agentName: "main", channelThreadKey: "webchat:parent-chat" },
      sessionId: "source-session",
      status: "idle" as const,
      submit: rs.fn(),
      async *fork(input: { prompt: string }) {
        yield {
          type: "turn_start",
          turnId: "fork-turn",
          sessionId: "fork-session",
          userPrompt: input.prompt,
          agent: "main",
        } as const;
        yield { type: "text_delta", content: "Learning", agent: "main" } as const;
        yield { type: "result", content: "Preference saved", agent: "main" } as const;
        yield {
          type: "turn_end",
          turnId: "fork-turn",
          status: "completed",
          durationMs: 5,
          agent: "main",
        } as const;
      },
      onStatusChange: rs.fn(() => () => undefined),
      stop: rs.fn(async () => undefined),
      close: rs.fn(async () => undefined),
    };
    const manager = {
      open: rs.fn(),
      find: rs.fn(() => source),
      shutdown: rs.fn(async () => undefined),
    } as unknown as Sessions;
    const turnStreams = createAgentTurnStreamRegistry();
    const runner = new AgentRunner(manager, agentLoader, undefined, turnStreams);
    const iterator = runner
      .runForked({
        agentName: "main",
        sourceSessionId: "source-session",
        channelThreadKey: "webchat:parent-chat",
        prompt: "learn from this feedback",
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "turn_start", sessionId: "fork-session", turnId: "fork-turn" },
    });
    const active = turnStreams.get("fork-turn");
    expect(active).toMatchObject({
      sessionId: "fork-session",
      chatId: "fork-session",
      finished: false,
    });
    expect(turnStreams.listBySession("fork-session")).toHaveLength(1);
    while (!(await iterator.next()).done) {
      // Drain the remainder so AgentRunner closes the live stream in `finally`.
    }

    expect(active?.finished).toBe(true);
    expect(turnStreams.listBySession("fork-session")).toEqual([]);
  });

  type BranchStart = Extract<ThreadStart, { kind: "branch" }>;

  /** Provider that opens a `branch` thread start on the session produced by
   *  `makeForkSession`, which receives the open params so tests can inspect
   *  the fork's tool surface. */
  function withForkSupport(
    provider: MockModelProvider,
    makeForkSession: (openParams: ModelSessionParams) => ModelSession,
    options: {
      modelThreadId?: string;
      onBranch?: (branch: BranchStart) => void;
    } = {},
  ): MockModelProvider {
    const baseOpen = provider.openSession.bind(provider);
    provider.openSession = async (params: ModelSessionParams) => {
      if (params.thread.kind === "branch") {
        options.onBranch?.(params.thread);
        return makeForkSession(params);
      }
      const session = await baseOpen(params);
      return { ...session, modelThreadId: options.modelThreadId ?? "mock-source-thread" };
    };
    return provider;
  }

  function forkSessionStub(overrides: Partial<ModelSession>): ModelSession {
    return {
      providerId: "mock",
      model: "mock-model",
      events: (async function* (): AsyncIterable<ModelSessionEvent> {})(),
      async sendUserInput() {},
      async interrupt() {},
      async close() {},
      ...overrides,
    };
  }

  /** Run one normal turn to make the source session live, then fork it. */
  async function runForkAgainstLiveSession(
    makeForkSession: (openParams: ModelSessionParams) => ModelSession,
    opts: {
      provider?: MockModelProvider;
      agentName?: string;
      fork?: Partial<Omit<ForkRunParams, "agentName" | "sourceSessionId" | "channelThreadKey">>;
      sourceModelThreadId?: string;
      onBranch?: (branch: BranchStart) => void;
      appCatalog?: Pick<AppCatalog, "get">;
    } = {},
  ): Promise<AgentEvent[]> {
    const agentName = opts.agentName ?? "test-main";
    const provider = withForkSupport(
      opts.provider ?? new MockModelProvider([[{ type: "result", content: "Done" }]]),
      makeForkSession,
      { modelThreadId: opts.sourceModelThreadId, onBranch: opts.onBranch },
    );
    const runner = createRunner(provider, undefined, {
      keepAliveAcrossTurns: true,
      appCatalog: opts.appCatalog,
    });
    const first = await collectMessages(
      runner.run({
        agentName,
        prompt: "Hi",
        channelThreadKey: "webchat:fork-1",
        threadContext: { channel: "webchat", threadId: "fork-1" },
      }),
    );
    const start = first.find((m) => m.type === "turn_start") as { sessionId: string };
    return collectMessages(
      runner.runForked({
        agentName,
        sourceSessionId: start.sessionId,
        channelThreadKey: "webchat:fork-1",
        prompt: "fork it",
        sourceCheckpoint: {
          providerId: "mock",
          providerThreadId: opts.sourceModelThreadId ?? "mock-source-thread",
          checkpointId: "source-turn",
        },
        ...opts.fork,
      }),
    );
  }

  describe("forked turn bracketing", () => {
    it("drops an exact fork's tool input previews for subagent calls", async () => {
      // Only an exact fork keeps the source's subagent tools.
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield {
                type: "tool_input_delta",
                toolUseId: "tu-explore-1",
                tool: EXPLORE_TOOL,
                content: "{",
              };
              yield {
                type: "tool_input_delta",
                toolUseId: "tu-lookup-1",
                tool: "lookup",
                content: "{",
              };
              yield { type: "result", reasoningEffort: "high", content: "Fork complete" };
            })(),
          }),
        {
          sourceModelThreadId: "model-thread",
          fork: {
            mode: "exact",
            sourceCheckpoint: {
              providerId: "mock",
              providerThreadId: "model-thread",
              checkpointId: "provider-turn-t2",
            },
          },
        },
      );

      expect(messages.filter((m) => m.type === "tool_input_delta")).toEqual([
        expect.objectContaining({ toolUseId: "tu-lookup-1" }),
      ]);
    });

    it("validates and forwards the selected provider checkpoint", async () => {
      let branch: BranchStart | undefined;
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", reasoningEffort: "high", content: "Fork complete" };
            })(),
          }),
        {
          sourceModelThreadId: "model-thread",
          onBranch: (start) => {
            branch = start;
          },
          fork: {
            mode: "exact",
            sourceCheckpoint: {
              providerId: "mock",
              providerThreadId: "model-thread",
              checkpointId: "provider-turn-t2",
            },
          },
        },
      );

      expect(messages.map((message) => message.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(branch).toEqual({
        kind: "branch",
        at: { provider: "mock", modelThreadId: "model-thread", checkpointId: "provider-turn-t2" },
        lifetime: "ephemeral",
      });
    });

    it("rejects a checkpoint from a different model thread", async () => {
      const onBranch = rs.fn();
      const messages = await runForkAgainstLiveSession(() => forkSessionStub({}), {
        sourceModelThreadId: "live-model-thread",
        onBranch,
        fork: {
          sourceCheckpoint: {
            providerId: "mock",
            providerThreadId: "different-model-thread",
            checkpointId: "provider-turn-t2",
          },
        },
      });

      expect(messages.map((message) => message.type)).toEqual(["turn_start", "error", "turn_end"]);
      expect(messages[1]).toMatchObject({
        type: "error",
        error: "Fork checkpoint belongs to a different model thread",
      });
      expect(onBranch).not.toHaveBeenCalled();
    });

    it("keeps fork sources leased and resumes them after idle eviction", async () => {
      rs.useFakeTimers();
      const provider = withForkSupport(
        new MockModelProvider([[{ type: "result", content: "Source ready" }]]),
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", reasoningEffort: "high", content: "Fork complete" };
            })(),
          }),
      );
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true, idleTtlMs: 100 },
      );
      const runner = new AgentRunner(manager, agentLoader);
      const key = { agentName: "test-main", channelThreadKey: "webchat:fork-idle-lease" };
      let firstFork: AsyncIterator<AgentEvent> | undefined;
      let secondFork: AsyncIterator<AgentEvent> | undefined;
      let resumedFork: AsyncIterator<AgentEvent> | undefined;

      try {
        const sourceMessages = await collectMessages(
          runner.run({ ...key, prompt: "Open the source conversation" }),
        );
        const sourceStart = sourceMessages.find((message) => message.type === "turn_start");
        expect(sourceStart).toBeDefined();
        const sourceSessionId = sourceStart!.sessionId;

        firstFork = runner
          .runForked({
            ...key,
            sourceSessionId,
            prompt: "First fork chat",
            mode: "exact",
          })
          [Symbol.asyncIterator]();
        await expect(firstFork.next()).resolves.toMatchObject({
          done: false,
          value: { type: "turn_start" },
        });

        // Production evicts otherwise-idle source sessions after 15 seconds.
        // Cross several sweeper intervals while the first fork is leased: the
        // source must remain available for another fork chat.
        await rs.advanceTimersByTimeAsync(500);
        expect(manager.find(key)?.sessionId).toBe(sourceSessionId);

        secondFork = runner
          .runForked({
            ...key,
            sourceSessionId,
            prompt: "Second fork chat",
            mode: "exact",
          })
          [Symbol.asyncIterator]();
        await expect(secondFork.next()).resolves.toMatchObject({
          done: false,
          value: { type: "turn_start" },
        });

        await secondFork.return?.();
        await firstFork.return?.();
        await rs.advanceTimersByTimeAsync(200);
        expect(manager.find(key)).toBeUndefined();

        // The webchat route reacquires before every fork. Webchat's persisted
        // provider-session reuse does not expire, so a later fork chat resumes
        // the same source identity after the short in-memory lease is evicted.
        const resumedSource = await manager.open(key);
        expect(resumedSource.sessionId).toBe(sourceSessionId);
        resumedFork = runner
          .runForked({
            ...key,
            sourceSessionId,
            prompt: "Fork chat after eviction",
            mode: "exact",
          })
          [Symbol.asyncIterator]();
        await expect(resumedFork.next()).resolves.toMatchObject({
          done: false,
          value: { type: "turn_start" },
        });
      } finally {
        await resumedFork?.return?.();
        await secondFork?.return?.();
        await firstFork?.return?.();
        rs.useRealTimers();
        await manager.shutdown();
      }
    });

    it("opens a fork with an explicitly requested model tier", async () => {
      const openParams: ModelSessionParams[] = [];
      await runForkAgainstLiveSession(
        (params) => {
          openParams.push(params);
          return forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", reasoningEffort: "high", content: "Fork summary" };
            })(),
          });
        },
        { fork: { tier: "small" } },
      );

      expect(openParams).toHaveLength(1);
      expect(openParams[0].config.model).toBe("claude-haiku-5-5");
      // Forks never write pins: the source session keeps the pin of
      // its own live model even after a tier-overridden forked turn ran.
      const row = await sessionRepository.current("webchat:fork-1", "core:test-main");
      expect(row).toMatchObject({ model: "claude-opus-5-5[1m]" });
    });

    it("leaves a resumable thread behind for a fork that ran on its own model thread", async () => {
      let forkLifetime: string | undefined;
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            modelThreadId: "fork-model-thread",
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", content: "Fork answer", reasoningEffort: "max" };
            })(),
          }),
        {
          sourceModelThreadId: "source-model-thread",
          onBranch: (start) => {
            forkLifetime = start.lifetime;
          },
          fork: { persistThreadKey: (id: string) => `webchat:${id}` },
        },
      );

      // A fork that wants to be continuable must ask for a thread of its own.
      expect(forkLifetime).toBe("kept");
      const start = messages.find((m) => m.type === "turn_start") as { sessionId: string };
      await expect(
        sessionRepository.current(`webchat:${start.sessionId}`, "core:test-main"),
      ).resolves.toMatchObject({
        id: start.sessionId,
        provider: "mock",
        modelThreadId: "fork-model-thread",
        model: "mock-model",
        // The branch header shows the effort its provider ran at, not the model alone.
        reasoningEffort: "max",
        status: "active",
      });
      // A fork never rewrites its parent: the source keeps its own pin.
      await expect(
        sessionRepository.current("webchat:fork-1", "core:test-main"),
      ).resolves.toMatchObject({
        model: "claude-opus-5-5[1m]",
      });
    });

    it("withholds defer from a continuable fork's own turn", async () => {
      // The first branch turn still carries the source's thread context, so a
      // wake-up scheduled here would resume the fork session and deliver into
      // the parent transcript. A one-shot fork keeps defer: it cannot be
      // resumed at all, so nothing can answer into the wrong place.
      const openParams: ModelSessionParams[] = [];
      const runFork = (fork: Partial<ForkRunParams>) =>
        runForkAgainstLiveSession(
          (params) => {
            openParams.push(params);
            return forkSessionStub({
              modelThreadId: "fork-model-thread",
              events: (async function* (): AsyncIterable<ModelSessionEvent> {
                yield { type: "result", reasoningEffort: "high", content: "Fork answer" };
              })(),
            });
          },
          { sourceModelThreadId: "source-model-thread", fork: { mode: "exact", ...fork } },
        );

      await runFork({ persistThreadKey: (id: string) => `webchat:${id}` });
      await runFork({});

      expect(openParams).toHaveLength(2);
      expect(toolNames(openParams[0].tools, "ask_user")).not.toContain("defer");
      expect(toolNames(openParams[1].tools, "ask_user")).toContain("defer");
    });

    it("stays one-shot when the fork borrowed the source's thread", async () => {
      // Codex's borrowed exact fork reports the SOURCE thread id: it runs the
      // turn in the parent conversation and reverts it out. Persisting that
      // would append every follow-up to the parent chat.
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            modelThreadId: "shared-source-thread",
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", reasoningEffort: "high", content: "Fork answer" };
            })(),
          }),
        {
          sourceModelThreadId: "shared-source-thread",
          fork: { persistThreadKey: (id: string) => `webchat:${id}` },
        },
      );

      const start = messages.find((m) => m.type === "turn_start") as { sessionId: string };
      // `current` answers null for a miss.
      await expect(
        sessionRepository.current(`webchat:${start.sessionId}`, "core:test-main"),
      ).resolves.toBeNull();
    });

    it("stays one-shot and ephemeral with no thread key, no model thread, or a failed fork", async () => {
      let defaultLifetime: string | undefined;
      const noKey = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            modelThreadId: "fork-model-thread",
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", reasoningEffort: "high", content: "Fork answer" };
            })(),
          }),
        {
          onBranch: (start) => {
            defaultLifetime = start.lifetime;
          },
        },
      );
      const noThread = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", reasoningEffort: "high", content: "Fork answer" };
            })(),
          }),
        { fork: { persistThreadKey: (id: string) => `webchat:${id}` } },
      );
      const failed = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            modelThreadId: "fork-model-thread",
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "error", error: "the branch blew up" };
            })(),
          }),
        {
          sourceModelThreadId: "source-model-thread",
          fork: { persistThreadKey: (id: string) => `webchat:${id}` },
        },
      );

      // Every other fork in Rome (recap, feedback) keeps today's cheap path.
      expect(defaultLifetime).toBe("ephemeral");
      for (const messages of [noKey, noThread, failed]) {
        const start = messages.find((m) => m.type === "turn_start") as { sessionId: string };
        await expect(
          sessionRepository.current(`webchat:${start.sessionId}`, "core:test-main"),
        ).resolves.toBeNull();
      }
    });

    it("synthesizes error + turn_end when the fork stream ends without a terminal", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          events: (async function* (): AsyncIterable<ModelSessionEvent> {
            yield { type: "text", content: "partial fork output" };
          })(),
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "text", "error", "turn_end"]);
      expect(messages[2]).toMatchObject({
        type: "error",
        error: expect.stringContaining("without a terminal"),
      });
      expect(messages[3]).toMatchObject({
        type: "turn_end",
        status: "error",
        turnId: (messages[0] as { turnId: string }).turnId,
        durationMs: expect.any(Number),
      });
    });

    it("synthesizes error + turn_end when sendUserInput on the fork throws", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          async sendUserInput() {
            throw new Error("fork transport exploded");
          },
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "error", "turn_end"]);
      expect(messages[1]).toMatchObject({
        type: "error",
        error: "fork transport exploded",
      });
      expect(messages[2]).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("brackets fork setup failures with turn_start + error + turn_end", async () => {
      const messages = await runForkAgainstLiveSession(() => {
        throw new Error("fork backend unavailable");
      });

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "error", "turn_end"]);
      expect(messages[1]).toMatchObject({ type: "error", error: "fork backend unavailable" });
      expect(messages[2]).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("a close-time fork error does not escape after turn_end", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          events: (async function* (): AsyncIterable<ModelSessionEvent> {
            yield { type: "result", reasoningEffort: "high", content: "Fork summary" };
          })(),
          async close() {
            throw new Error("close exploded");
          },
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(messages[2]).toMatchObject({ type: "turn_end", status: "completed" });
    });

    it("brackets a user-stopped forked turn with status=interrupted", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          events: (async function* (): AsyncIterable<ModelSessionEvent> {
            yield {
              type: "result",
              reasoningEffort: "high",
              content: "",
              accounting: {
                provider: "mock",
                model: "mock-model",
                usage: {
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                },
                stopReason: "interrupted",
              },
            };
          })(),
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(messages[2]).toMatchObject({ type: "turn_end", status: "interrupted" });
    });

    it("brackets a successful forked turn with status=completed", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          events: (async function* (): AsyncIterable<ModelSessionEvent> {
            yield { type: "text", content: "fork output" };
            yield { type: "result", reasoningEffort: "high", content: "Fork summary" };
          })(),
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "text", "result", "turn_end"]);
      expect(messages[3]).toMatchObject({ type: "turn_end", status: "completed" });
    });
  });

  describe("forked turn modes", () => {
    function registerDemoAction(
      execute?: (
        args: Record<string, unknown>,
      ) => Promise<import("../apps/actions/types.js").ActionResult>,
    ): void {
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Demo action for fork-mode tests",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "read-only",
        },
        inputSchema: {},
        execute: execute ?? (async () => ({ status: "ok" })),
      });
    }

    it("default forks open an isolated tool surface with execution disabled", async () => {
      registerDemoAction();
      let forkOpen: ModelSessionParams | undefined;
      const messages = await runForkAgainstLiveSession((openParams) => {
        forkOpen = openParams;
        return forkSessionStub({
          events: (async function* (): AsyncIterable<ModelSessionEvent> {
            yield { type: "result", reasoningEffort: "high", content: "Fork summary" };
          })(),
        });
      });

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(forkOpen).toBeDefined();
      // An empty tool surface: nothing to list in any group, and no builtins.
      for (const group of ["actions", "subagents", "skills", "ask_user"] as const) {
        expect(toolNames(forkOpen!.tools, group)).toEqual([]);
      }
      expect(forkOpen!.config.builtinTools).toEqual([]);
      expect(forkOpen!.config.reasoningEffort).toBe("high");
      await expect(
        executeActionTool(forkOpen!.tools, "demo_action", {}, { toolUseId: "isolated-action" }),
      ).rejects.toThrow("Unknown tool: execute_action");
    });

    it("preserves App Store attribution on isolated forks", async () => {
      const find = agentLoader.find.bind(agentLoader);
      const recordSpy = rs.spyOn(agentLoader, "find").mockImplementation((name) => {
        const agent = find(name);
        if (agent?.localName !== "test-main") return agent;
        return { ...agent, ownerType: "app", ownerId: "test-app" };
      });

      try {
        await runForkAgainstLiveSession(
          () => {
            return forkSessionStub({
              events: (async function* (): AsyncIterable<ModelSessionEvent> {
                yield {
                  type: "result",
                  reasoningEffort: "high",
                  content: "Fork summary",
                  accounting: MOCK_ACCOUNTING,
                };
              })(),
            });
          },
          {
            appCatalog: {
              get: rs.fn((appId: string) =>
                appId === "test-app"
                  ? {
                      source: {
                        mode: "appstore",
                        listingId: "@publisher/test-app",
                        version: "1.0.0",
                      },
                    }
                  : null,
              ),
            } as unknown as Pick<AppCatalog, "get">,
          },
        );

        expect(recordMetrics).toHaveBeenCalledWith(MOCK_ACCOUNTING, {
          agentName: "core:test-main",
          appStoreListingId: "@publisher/test-app",
        });
      } finally {
        recordSpy.mockRestore();
      }
    });

    it("exact forks mirror the source session's open configuration", async () => {
      registerDemoAction();
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      provider.builtinTools = new Set(["Read", "Edit", "Bash"]);
      let forkOpen: ModelSessionParams | undefined;
      await runForkAgainstLiveSession(
        (openParams) => {
          forkOpen = openParams;
          return forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", reasoningEffort: "high", content: "Fork summary" };
            })(),
          });
        },
        { provider, fork: { mode: "exact" } },
      );

      const sourceOpen = provider.sessions[0];
      expect(forkOpen).toBeDefined();
      expect(forkOpen!.config.systemPrompt).toBe(sourceOpen.config.systemPrompt);
      // The same catalog as the source: both sessions serialize the same tool
      // block.
      expect(await listActionNames(forkOpen!.tools)).toEqual(["demo_action"]);
      expect(toolNames(forkOpen!.tools, "subagents")).toEqual(
        toolNames(sourceOpen.tools, "subagents"),
      );
      expect(toolNames(forkOpen!.tools, "subagents")).toContain(EXPLORE_TOOL);
      // test-main declares Read + Edit; Bash stays provider-only in both.
      expect(forkOpen!.config.builtinTools).toBe(sourceOpen.config.builtinTools);
      expect(forkOpen!.config.builtinTools).toEqual(["Read", "Edit"]);
      // The advertised surface stays identical (prefix identity with the
      // source); only the interactive *runtime* is detached, since no webchat
      // drain reads a fork stream: ask_question relays prose there instead of
      // parking the turn on a card.
      expect(toolNames(forkOpen!.tools, "ask_user")).toEqual(
        toolNames(sourceOpen.tools, "ask_user"),
      );
      const askQuestion = (tools: RomeTools) =>
        tools.listTools("ask_user").find((tool) => tool.name === "ask_question");
      expect(askQuestion(sourceOpen.tools)?.endsTurn).toBe(true);
      expect(askQuestion(forkOpen!.tools)?.endsTurn).toBe(false);
      expect(forkOpen!.config.maxTurns).toBe(sourceOpen.config.maxTurns);
      expect(forkOpen!.config.workingDir).toBe(sourceOpen.config.workingDir);
      expect(forkOpen!.config.externalMcpServers).toBe(sourceOpen.config.externalMcpServers);
      expect(forkOpen!.config.reasoningEffort).toBe(sourceOpen.config.reasoningEffort);
      // Model follows the source's live model when no tier override is given.
      expect(forkOpen!.config.model).toBe(sourceOpen.config.model);
      // The fork's tools run through fresh fork-bound callbacks, never the
      // source's.
      expect(forkOpen!.tools).not.toBe(sourceOpen.tools);
    });

    it("exact forks execute actions attributed to the fork session, not the source", async () => {
      const observed: Array<{ sessionId?: string; channelUserId?: string }> = [];
      registerDemoAction(async () => {
        const store = actionExecutionContext.getStore();
        observed.push({
          sessionId: store?.sessionId,
          channelUserId: store?.channelContext?.channelUserId,
        });
        return { status: "ok" };
      });

      const messages = await runForkAgainstLiveSession(
        (openParams) =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              await executeActionTool(openParams.tools, "demo_action", {});
              yield { type: "result", reasoningEffort: "high", content: "acted" };
            })(),
          }),
        {
          fork: {
            mode: "exact",
            threadContext: {
              channel: "webchat",
              threadId: "fork-1",
              channelUserId: "guardian-fork",
            },
          },
        },
      );

      const forkStart = messages.find((m) => m.type === "turn_start") as { sessionId: string };
      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(observed).toHaveLength(1);
      expect(observed[0].sessionId).toBe(forkStart.sessionId);
      expect(observed[0].channelUserId).toBe("guardian-fork");
    });

    it("exact forks project subagents as first-class lifecycle events", async () => {
      const provider = new MockModelProvider([
        // Source turn, then the fork's subagent (test-explore) turn.
        [{ type: "result", content: "Done" }],
        [
          { type: "text", content: "child thinking" },
          { type: "result", content: "child answer" },
        ],
      ]);

      const messages = await runForkAgainstLiveSession(
        (openParams) =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield {
                type: "tool_use",
                id: "fork-subagent-1",
                tool: EXPLORE_TOOL,
                input: { prompt: "dig" },
              };
              const completion = (await executeSubagentTool(
                openParams.tools,
                EXPLORE_TOOL,
                { prompt: "dig" },
                { toolUseId: "fork-subagent-1" },
              )) as { output: string };
              yield {
                type: "tool_result",
                toolUseId: "fork-subagent-1",
                tool: EXPLORE_TOOL,
                output: completion,
              };
              yield { type: "result", reasoningEffort: "high", content: completion.output };
            })(),
          }),
        { provider, fork: { mode: "exact" } },
      );

      const start = messages.find((m) => m.type === "subagent_start");
      expect(start).toMatchObject({
        toolUseId: "fork-subagent-1",
        agentName: "core:test-explore",
      });
      const childResult = messages.find((m) => m.type === "subagent_result");
      expect(childResult).toMatchObject({
        toolUseId: "fork-subagent-1",
        status: "completed",
        output: "child answer",
      });
      expect(
        messages.some(
          (m) =>
            m.type === "text" &&
            (m as AgentEvent & { agent?: string }).agent === "core:test-explore",
        ),
      ).toBe(false);
      const terminal = messages.find((m) => m.type === "result");
      expect(terminal).toMatchObject({ content: "child answer" });
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
      expect(messages.indexOf(start!)).toBeLessThan(messages.indexOf(terminal!));
    });

    it("exact forks preserve provider-native structured results without a side-channel event", async () => {
      const payload = { decision: "REPLY", reason: "all good" };
      let forkOpen: ModelSessionParams | undefined;

      const messages = await runForkAgainstLiveSession(
        (openParams) => {
          forkOpen = openParams;
          return forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield {
                type: "result",
                reasoningEffort: "high",
                content: JSON.stringify(payload),
                structuredOutput: payload,
              };
            })(),
          });
        },
        { agentName: "test-structured", fork: { mode: "exact" } },
      );

      expect(forkOpen!.config.outputSchema).toEqual(
        expect.objectContaining({ type: "object", required: ["decision", "reason"] }),
      );
      expect(messages.some((message) => message.type === "structured_output")).toBe(false);
      expect(messages.find((message) => message.type === "result")).toMatchObject({
        content: JSON.stringify(payload),
        structuredOutput: payload,
      });
    });
    it("exact forks fail closed when a provider omits structured output", async () => {
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield { type: "result", reasoningEffort: "high", content: "forgot to submit" };
            })(),
          }),
        { agentName: "test-structured", fork: { mode: "exact" } },
      );

      // The same terminal assertion applies to live and forked turns.
      expect(messages.map((m) => m.type)).toEqual(["turn_start", "error", "turn_end"]);
      expect(messages[1]).toMatchObject({
        type: "error",
        error: expect.stringContaining("without structured output"),
      });
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("does not exempt a suspended outputSchema turn from the native result contract", async () => {
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield {
                type: "tool_result",
                toolUseId: "tu-fork-park",
                tool: "demo_action",
                output: { pendingApproval: true },
              };
              yield {
                type: "result",
                reasoningEffort: "high",
                content: JSON.stringify({ decision: "REPLY", reason: "after approval" }),
                structuredOutput: { decision: "REPLY", reason: "after approval" },
              };
            })(),
          }),
        { agentName: "test-structured", fork: { mode: "exact" } },
      );

      // outputSchema is per provider turn. A suspension makes the contract
      // invalid even if the provider subsequently emits a schema-valid value.
      expect(messages.map((m) => m.type)).toEqual([
        "turn_start",
        "tool_result",
        "error",
        "turn_end",
      ]);
      expect(messages[2]).toMatchObject({
        type: "error",
        error: expect.stringContaining("cannot suspend"),
      });
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("exact fork actions take the non-interactive fallback for interactive results", async () => {
      registerDemoAction(async () => ({
        status: "pending_interaction",
        interaction: {
          appId: "demo-app",
          promptText: "Pick a time slot",
          render: { kind: "inline", componentId: "slot-picker" },
        },
      }));

      let actionResult: unknown;
      const messages = await runForkAgainstLiveSession(
        (openParams) =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              actionResult = await executeActionTool(openParams.tools, "demo_action", {});
              yield { type: "result", reasoningEffort: "high", content: "done" };
            })(),
          }),
        { fork: { mode: "exact" } },
      );

      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
      // No webchat drain reads a fork stream, so the tool_result must not
      // claim a card was mounted — the prose fallback relays the prompt text.
      expect(actionResult).toMatchObject({
        message: expect.stringContaining("cannot render an interactive UI"),
      });
      expect((actionResult as { pendingInteraction?: boolean }).pendingInteraction).toBeUndefined();
      expect((actionResult as { message: string }).message).toContain("Pick a time slot");
    });

    it("exact fork subagents run in fresh fork-owned child sessions", async () => {
      const provider = withForkSupport(
        new MockModelProvider([
          [{ type: "result", content: "Done" }], // source turn
          [{ type: "result", content: "fork child answer" }], // fork's subagent turn
        ]),
        (openParams) =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<ModelSessionEvent> {
              yield {
                type: "tool_use",
                id: "fork-subagent-2",
                tool: EXPLORE_TOOL,
                input: { prompt: "fork dig" },
              };
              const completion = (await executeSubagentTool(
                openParams.tools,
                EXPLORE_TOOL,
                { prompt: "fork dig" },
                { toolUseId: "fork-subagent-2" },
              )) as { output: string };
              yield {
                type: "tool_result",
                toolUseId: "fork-subagent-2",
                tool: EXPLORE_TOOL,
                output: completion,
              };
              yield { type: "result", reasoningEffort: "high", content: completion.output };
            })(),
          }),
      );
      const modelResolver = createTestModelResolver({ providers: [provider] });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const repo = new ChatsWebChatRepository(testDb.db);
      await repo.createSession("fork-iso", "Fork source");
      const runner = new AgentRunner(manager, agentLoader, repo);
      const first = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hi", channelThreadKey: "webchat:fork-iso" }),
      );
      const start = first.find((m) => m.type === "turn_start") as { sessionId: string };

      const messages = await collectMessages(
        runner.runForked({
          agentName: "test-main",
          sourceSessionId: start.sessionId,
          channelThreadKey: "webchat:fork-iso",
          prompt: "fork it",
          mode: "exact",
          sourceCheckpoint: {
            providerId: "mock",
            providerThreadId: "mock-source-thread",
            checkpointId: "source-turn",
          },
        }),
      );

      // The fork's subagent is always a fresh session owned by the fork.
      const childOpens = provider.sessions.slice(1);
      expect(childOpens).toHaveLength(1);
      expect(childOpens[0].thread).toEqual({ kind: "new" });
      const terminal = messages.find((m) => m.type === "result");
      expect(terminal).toMatchObject({ content: "fork child answer" });
    });
  });

  function createLifecycleRecorder(): TurnLifecycle & {
    startedEvents: AgentTurnStartedEvent[];
    finishedEvents: AgentTurnFinishedEvent[];
  } {
    const startedEvents: AgentTurnStartedEvent[] = [];
    const finishedEvents: AgentTurnFinishedEvent[] = [];
    return {
      startedEvents,
      finishedEvents,
      started(event) {
        startedEvents.push(event);
      },
      ended(event) {
        finishedEvents.push(event);
      },
      couldNotStart() {},
    };
  }

  // Full ManagerDeps over the suite's shared collaborators. No network MCP
  // servers are found, and the default dispatcher has no hooks loaded.
  function managerDeps(
    modelResolver: ModelResolver,
    turnLifecycle?: TurnLifecycle,
    appCatalog?: Pick<AppCatalog, "get">,
  ) {
    const webchatRepo = new ChatsWebChatRepository(testDb.db);
    const subagentCalls = createSubagentCalls({
      recorded: new AgentRecordedSessions(webchatRepo),
      turnLog: subagentTurnLog(webchatRepo),
      liveTurns: subagentLiveTurns(createAgentTurnStreamRegistry()),
    });
    return {
      agentLoader,
      sessionRepository,
      systemPrompts,
      modelResolver,
      sessionSettings: new ChatSessionSettings({
        webchatRepo: new ChatsWebChatRepository(testDb.db),
      }),
      networkMcpServers: () => ({}),
      skillCatalog: new SkillLoader(artifactIdentity),
      turnLifecycle: turnLifecycle ?? new TurnListeners(new AppTurnHooks()),
      readAnswerShape,
      sessionTracing: romeSessionTracing,
      turnUsage: new TurnUsageReporter({ apps: appCatalog }),
      folders: { ...agentFolders(), defaultWorkingDir: "/tmp/default-project" },
      log: createLogger("agent-session"),
      subagentCalls,
      subagentSessions: (
        manager: Sessions,
        parentLink: string,
        inherited: Pick<SessionOpening, "toolEnv" | "spanAttributes">,
      ) => subagentSessions(manager, parentLink, webchatRepo, inherited),
      ...romeToolPorts({
        actionRegistry,
        actionEngine,
        webchatRepo: new ChatsWebChatRepository(testDb.db),
      }),
    };
  }

  function createRunner(
    provider?: ModelProvider,
    turnLifecycle?: TurnLifecycle,
    options: {
      keepAliveAcrossTurns?: boolean;
      appCatalog?: Pick<AppCatalog, "get">;
      resetPolicy?: ProviderSessionResetPolicy;
      turnLinks?: PromptFacts;
    } = {},
  ): AgentRunner {
    const active = provider ?? mockProvider;
    const modelResolver = createTestModelResolver({
      providers: [active],
    });
    const manager = createSessions(
      {
        ...managerDeps(modelResolver, turnLifecycle, options.appCatalog),
        ...(options.turnLinks ? { promptFacts: options.turnLinks } : {}),
      },
      { keepAliveAcrossTurns: options.keepAliveAcrossTurns },
    );
    const resetPolicy = options.resetPolicy;
    // A recorded run has its conversation's row, which its subagents need.
    return new AgentRunner(
      manager,
      agentLoader,
      new ChatsWebChatRepository(testDb.db),
      undefined,
      undefined,
      undefined,
      resetPolicy ? async () => resetPolicy : undefined,
      sessionOpeningFor({ channelSurface: testChannelSurface }),
    );
  }

  function createClosableModelSession(params: ModelSessionParams): ModelSession {
    let closed = false;
    const resolvers: Array<(item: IteratorResult<ModelSessionEvent>) => void> = [];
    const finish = (): IteratorResult<ModelSessionEvent> => ({
      value: undefined as never,
      done: true,
    });

    return {
      providerId: "mock",
      model: params.config.model,
      events: {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<ModelSessionEvent>> {
              if (closed) return finish();
              return await new Promise((resolve) => {
                resolvers.push(resolve);
              });
            },
          };
        },
      },
      async sendUserInput(): Promise<void> {},
      async interrupt(): Promise<void> {},
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        while (resolvers.length > 0) {
          resolvers.shift()!(finish());
        }
      },
    };
  }

  describe("turn middleware terminal", () => {
    let manager: Sessions | undefined;
    let recorded: TurnUsageFacts[];

    afterEach(async () => {
      await manager?.shutdown();
      manager = undefined;
    });

    async function openMiddlewareSession(
      middleware:
        | TurnMiddleware
        | ((
            turn: Parameters<TurnMiddleware["run"]>[0],
            next: () => Promise<void>,
          ) => Promise<void>),
      agentName = "test-main",
    ): Promise<AgentSession> {
      let turnMiddleware: TurnMiddleware;
      if (typeof middleware === "function") {
        turnMiddleware = new AppTurnMiddleware();
        rs.spyOn(turnMiddleware, "run").mockImplementation(middleware);
      } else {
        turnMiddleware = middleware;
      }
      recorded = [];
      manager = createSessions(
        {
          ...managerDeps(createTestModelResolver({ providers: [mockProvider] })),
          turnMiddleware,
          sessionTracing: romeSessionTracing,
          turnUsage: new TurnUsageReporter({
            usage: { recordTurn: (facts) => recorded.push(facts) },
          }),
        },
        { keepAliveAcrossTurns: true },
      );
      return await manager.open({
        agentName,
        channelThreadKey: "webchat:middleware-terminal",
      });
    }

    const terminalsOf = (events: AgentEvent[]) =>
      events.filter((event) => event.type === "result" || event.type === "error");

    it("publishes only the first terminal a middleware emits", async () => {
      const session = await openMiddlewareSession(async (ctx) => {
        ctx.emit({ type: "result", content: "first" });
        ctx.emit({ type: "text", content: "late" });
        ctx.emit({ type: "error", error: "second" });
      });

      const events = await collectMessages((await startAfter(session, { prompt: "hi" })).events());

      expect(terminalsOf(events)).toEqual([expect.objectContaining({ content: "first" })]);
      expect(events.some((event) => event.type === "text")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
      expect(recorded.map((facts) => facts.status)).toEqual(["completed"]);
    });

    it("gives a turn's late reader every event from its start, and ends with how it ended", async () => {
      const session = await openMiddlewareSession(async (ctx) => {
        ctx.emit({ type: "result", content: "first" });
      });

      const turn = await startAfter(session, { prompt: "hi" });
      const early = await collectMessages(turn.events());
      const late = await collectMessages(turn.events());

      expect(late).toEqual(early);
      expect(turn.hasEnded).toBe(true);
      expect(await turn.ended()).toMatchObject({
        terminal: { type: "result", content: "first" },
        stoppedByRome: false,
      });
      expect(await turn.stop("user-stop")).toBe("ended");
    });

    it("does not run the model when a middleware continues after its terminal", async () => {
      mockProvider = new MockModelProvider([[{ type: "result", content: "from the model" }]]);
      const session = await openMiddlewareSession(async (ctx, next) => {
        ctx.emit({ type: "result", content: "scripted" });
        await next();
      });

      const events = await collectMessages((await startAfter(session, { prompt: "hi" })).events());

      expect(mockProvider.calls).toHaveLength(0);
      expect(terminalsOf(events)).toEqual([expect.objectContaining({ content: "scripted" })]);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
    });

    it("ends on the model's terminal when a middleware does not await next()", async () => {
      mockProvider = new MockModelProvider([[{ type: "result", content: "from the model" }]]);
      const session = await openMiddlewareSession(async (ctx, next) => {
        void next();
        ctx.emit({ type: "result", content: "scripted" });
      });

      const events = await collectMessages((await startAfter(session, { prompt: "hi" })).events());

      expect(mockProvider.calls).toHaveLength(1);
      expect(terminalsOf(events)).toEqual([expect.objectContaining({ content: "from the model" })]);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
    });

    it("ends on the model's terminal when a fail-closed middleware throws after next()", async () => {
      mockProvider = new MockModelProvider([[{ type: "result", content: "from the model" }]]);
      const session = await openMiddlewareSession(async (_ctx, next) => {
        void next();
        throw new Error("post-processing failed");
      });

      const events = await collectMessages((await startAfter(session, { prompt: "hi" })).events());

      expect(mockProvider.calls).toHaveLength(1);
      expect(terminalsOf(events)).toEqual([expect.objectContaining({ content: "from the model" })]);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
      expect(recorded.map((facts) => facts.status)).toEqual(["completed"]);
    });

    it("skips the model when a fail-open middleware throws after its terminal", async () => {
      // Runs the real chain, whose fail-open handling calls next() for the
      // middleware that threw.
      mockProvider = new MockModelProvider([[{ type: "result", content: "from the model" }]]);
      const dir = await mkdtemp(join(tmpdir(), "rome-turnmw-fail-open-"));
      try {
        await writeFile(
          join(dir, "index.js"),
          `export function createHook() {
            return {
              order: 0,
              async handle(ctx) {
                ctx.emit({ type: "result", content: "scripted" });
                throw new Error("post-processing failed");
              },
            };
          }\n`,
          "utf-8",
        );
        const chain = new AppTurnMiddleware();
        const failures = await chain.loadFromCatalog({
          get: () => null,
          listArtifacts: (kind: string) =>
            kind === "hook"
              ? [
                  {
                    kind: "hook",
                    publicName: "turn-middleware",
                    aliases: [],
                    ownerType: "app",
                    ownerId: "app.fail-open",
                    absolutePath: dir,
                  },
                ]
              : [],
        } as unknown as AppCatalog);
        expect(failures).toEqual([]);
        const session = await openMiddlewareSession(chain);

        const events = await collectMessages(
          (await startAfter(session, { prompt: "hi" })).events(),
        );

        expect(mockProvider.calls).toHaveLength(0);
        expect(terminalsOf(events)).toEqual([expect.objectContaining({ content: "scripted" })]);
        expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("ends on the emitted terminal when a fail-closed middleware throws after it", async () => {
      const harness = installTestSpanHarness();
      try {
        const session = await openMiddlewareSession(async (ctx) => {
          ctx.emit({ type: "result", content: "scripted" });
          throw new Error("post-processing failed");
        });

        const events = await collectMessages(
          (await startAfter(session, { prompt: "hi" })).events(),
        );

        expect(terminalsOf(events)).toEqual([expect.objectContaining({ content: "scripted" })]);
        expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
        expect(recorded.map((facts) => facts.status)).toEqual(["completed"]);
        const spans = await harness.finishedSpans();
        const agentSpan = spans.find((s) => s.name.startsWith("agent:"));
        expect(agentSpan?.events).toContainEqual(
          expect.objectContaining({
            name: "exception",
            attributes: expect.objectContaining({ "exception.message": "post-processing failed" }),
          }),
        );
      } finally {
        await harness.shutdown();
      }
    });

    it("publishes an empty result for a middleware turn that emits no terminal", async () => {
      // A scripted conversation parks a turn on a question card this way.
      const session = await openMiddlewareSession(async (ctx) => {
        ctx.emit({ type: "text", content: "Pick one" });
      });

      const events = await collectMessages((await startAfter(session, { prompt: "hi" })).events());

      expect(terminalsOf(events)).toEqual([
        expect.objectContaining({ type: "result", content: "" }),
      ]);
      expect(events.at(-2)).toMatchObject({ type: "result" });
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
    });

    it("publishes one validation error for an output-schema middleware turn that emits no terminal", async () => {
      const session = await openMiddlewareSession(async (ctx) => {
        ctx.emit({ type: "text", content: "Pick one" });
      }, "test-structured");

      const events = await collectMessages((await startAfter(session, { prompt: "hi" })).events());

      expect(terminalsOf(events)).toEqual([
        expect.objectContaining({
          type: "error",
          error: expect.stringContaining("without structured output"),
        }),
      ]);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it.each([
      "test-main",
      "test-structured",
    ])("publishes no terminal for a middleware turn the user stops (%s)", async (agentName) => {
      let releaseMiddleware!: () => void;
      const middlewareGate = new Promise<void>((resolve) => {
        releaseMiddleware = resolve;
      });
      let entered!: () => void;
      const middlewareEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const session = await openMiddlewareSession(async () => {
        entered();
        await middlewareGate;
      }, agentName);

      const turn = await startAfter(session, { prompt: "hi" });
      const messages = collectMessages(turn.events());
      await middlewareEntered;
      const stopping = turn.stop!("user-stop");
      releaseMiddleware();
      await stopping;
      const events = await messages;

      expect(terminalsOf(events)).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "interrupted" });
      expect(await turn.ended()).toEqual({ terminal: undefined, stoppedByRome: true });
    });
  });

  describe("session management", () => {
    it("waits for cancellation before ending a turn stopped during middleware", async () => {
      let releaseMiddleware!: () => void;
      const middlewareGate = new Promise<void>((resolve) => {
        releaseMiddleware = resolve;
      });
      let confirmExit!: () => void;
      const exit = new Promise<void>((resolve) => {
        confirmExit = resolve;
      });
      const turnMiddleware = new AppTurnMiddleware();
      rs.spyOn(turnMiddleware, "run").mockImplementation(async (_ctx, next) => {
        await middlewareGate;
        await next();
      });
      const interrupt = rs.fn(() => exit);
      const sendUserInput = rs.fn(async () => {});
      rs.spyOn(mockProvider, "openSession").mockImplementation(async (params) => ({
        ...createClosableModelSession(params),
        interrupt,
        sendUserInput,
      }));
      const manager = createSessions(
        {
          ...managerDeps(createTestModelResolver({ providers: [mockProvider] })),
          turnMiddleware,
        },
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:stop-middleware",
      });
      const turn = await startAfter(session, { prompt: "Do not dispatch" });
      let finished = false;
      const messages = collectMessages(turn.events()).then((value) => {
        finished = true;
        return value;
      });
      await rs.waitFor(() => expect(turnMiddleware.run).toHaveBeenCalled());
      const stopping = turn.stop!("user-stop");
      releaseMiddleware();
      await rs.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(2));
      expect(finished).toBe(false);
      expect(sendUserInput).not.toHaveBeenCalled();
      confirmExit();
      await stopping;
      expect(await messages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );
      await manager.shutdown();
    });

    it("cancels a turn before dispatch without sending its input", async () => {
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [mockProvider] })),
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:early-stop",
      });
      const turn = await startAfter(session, { prompt: "Do not dispatch" });
      await turn.stop!("user-stop");
      const messages = await collectMessages(turn.events());
      expect(mockProvider.calls).toHaveLength(0);
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );
      await manager.shutdown();
    });

    it("starts each after input's turn of its own behind the running turn, which a now input supersedes", async () => {
      const prompts: string[] = [];
      const cancels = rs.fn();
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const provider: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set(),
        async openSession(params) {
          const model = createSessionFromRun(
            "anthropic",
            async function* ({ prompt }) {
              prompts.push(prompt);
              if (prompts.length === 1) await firstGate;
              yield { type: "result", content: `answer:${prompt}` };
            },
            params,
          );
          return {
            ...model,
            async interrupt() {
              cancels();
              releaseFirst();
            },
          };
        },
      };
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:after-inputs",
      });

      const backend = session.submit({ prompt: "backend" }, { priority: "after" });
      expect(backend.landed).toBe("started");
      const backendMessages = collectMessages((await backend.turn).events());
      await rs.waitFor(() => expect(prompts).toEqual(["backend"]));
      const behind = session.submit({ prompt: "behind" }, { priority: "after" });
      expect(behind.landed).toBe("queued");
      expect(behind.turnId).not.toBe(backend.turnId);

      const urgent = session.submit({ inputId: "urgent", prompt: "urgent" }, { priority: "now" });
      expect(await backendMessages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );
      expect(cancels).toHaveBeenCalledOnce();
      await collectMessages((await urgent.turn).events());
      expect(await collectMessages((await behind.turn).events())).toContainEqual(
        expect.objectContaining({ type: "result", content: "answer:behind" }),
      );
      // A conversational input's turn goes ahead of an `after` turn still waiting.
      expect(prompts).toEqual(["backend", "urgent", "behind"]);
      expect(cancels).toHaveBeenCalledOnce();
      await manager.shutdown();
    });

    describe("a Claude turn a now input follows", () => {
      // A Claude stop ends with the adapter's own result, which marks the turn
      // stopped; a turn the model finished first ends with its real result.
      // Only a turn a `now` input superseded hands its read request on.
      type Ending = "superseded" | "finished first" | "stopped by the guardian";
      const follow = async (ending: Ending) => {
        const prompts: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const provider: ModelProvider = {
          id: "anthropic",
          builtinTools: new Set(),
          async openSession(params) {
            const model = createSessionFromRun(
              "anthropic",
              async function* ({ prompt }) {
                prompts.push(prompt);
                if (prompts.length > 1) {
                  yield { type: "result", content: `answer:${prompt}` };
                  return;
                }
                // Claude has read the request when the stop comes.
                yield { type: "input_status", inputId: "first", state: "consumed" };
                await firstGate;
                yield ending === "finished first"
                  ? { type: "result", content: "done" }
                  : claudeStoppedTurnResult({
                      provider: "anthropic",
                      model: "claude-test",
                      content: "",
                      reasoningEffort: "high",
                    });
              },
              params,
            );
            return {
              ...model,
              async interrupt() {
                // The guardian's Stop ends the turn only once the next input is in.
                if (ending !== "stopped by the guardian") releaseFirst();
              },
            };
          },
        };
        const lifecycle = createLifecycleRecorder();
        const manager = createSessions(
          managerDeps(createTestModelResolver({ providers: [provider] }), lifecycle),
          { keepAliveAcrossTurns: true },
        );
        const session = await manager.open({
          agentName: "test-main",
          channelThreadKey: `webchat:claude-${ending.replaceAll(" ", "-")}`,
        });
        const first = session.submit(
          { inputId: "first", prompt: "Start a task" },
          { priority: "now" },
        );
        const firstTurn = await first.turn;
        const firstMessages = collectMessages(firstTurn.events());
        await rs.waitFor(() => expect(prompts).toHaveLength(1));
        if (ending === "stopped by the guardian") await firstTurn.stop!("user-stop");
        const second = session.submit({ prompt: "What is 6 times 9?" }, { priority: "now" });
        releaseFirst();
        await firstMessages;
        await collectMessages((await second.turn).events());
        await manager.shutdown();
        const firstEnd = lifecycle.finishedEvents.find(
          (event) => event.turn.turnId === firstTurn.id,
        );
        handedOn = (firstEnd as { handedOn?: boolean } | undefined)?.handedOn ?? false;
        return prompts[1];
      };
      let handedOn = false;

      it("carries a superseded turn's request into the next prompt", async () => {
        const next = await follow("superseded");
        // The input queue's note that names interrupted work.
        expect(next).toMatch(/previous turn was stopped before it finished/);
        expect(next).toContain("Start a task");
        expect(next).toContain("What is 6 times 9?");
        // Rome hears that the work went on, so marks that follow it stay.
        expect(handedOn).toBe(true);
      });

      it("carries nothing from a turn that completed before the stop reached it", async () => {
        expect(await follow("finished first")).toBe("What is 6 times 9?");
      });

      it("carries nothing from a turn the guardian stopped", async () => {
        expect(await follow("stopped by the guardian")).toBe("What is 6 times 9?");
        expect(handedOn).toBe(false);
      });
    });

    it("takes the next input on the same model session after an interrupt", async () => {
      const opens: ModelSessionParams[] = [];
      const prompts: string[] = [];
      const cancels = rs.fn();
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const provider: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set(),
        async openSession(params) {
          opens.push(params);
          const model = createSessionFromRun(
            "anthropic",
            async function* ({ prompt }) {
              prompts.push(prompt);
              if (prompts.length === 1) {
                yield {
                  type: "tool_use",
                  id: "edit-1",
                  tool: "Edit",
                  input: { file_path: "test.txt" },
                };
                await firstGate;
                yield {
                  type: "result",
                  content: "Work before cancellation",
                  position: {
                    provider: "anthropic",
                    modelThreadId: "persisted-claude-thread",
                    checkpointId: "assistant-current",
                  },
                };
              } else {
                await secondGate;
                yield { type: "result", content: "Next turn" };
              }
            },
            params,
          );
          return {
            ...model,
            modelThreadId: "persisted-claude-thread",
            async interrupt() {
              cancels();
              releaseFirst();
            },
          };
        },
      };
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:abort-resume",
      });
      const firstInput = session.submit({ inputId: "input-first", prompt: "first" });
      expect(firstInput.landed).toBe("started");
      const first = await firstInput.turn;
      const firstMessages = collectMessages(first.events());
      await rs.waitFor(() => expect(prompts).toEqual(["first"]));
      await first.stop!("user-stop");
      expect(await firstMessages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );

      const secondInput = session.submit({ inputId: "input-second", prompt: "second" });
      expect(secondInput.landed).toBe("started");
      const second = await secondInput.turn;
      const secondMessages = collectMessages(second.events());
      await rs.waitFor(() => expect(prompts).toEqual(["first", "second"]));
      await first.stop!("late-repeat");
      expect(cancels).toHaveBeenCalledTimes(1);
      releaseSecond();
      expect(await secondMessages).toContainEqual(
        expect.objectContaining({ type: "result", content: "Next turn" }),
      );
      expect(opens).toHaveLength(1);
      expect(session.status).toBe("idle");
      await manager.shutdown();
    });

    it("branches an interrupted source at its current checkpoint", async () => {
      const opens: ModelSessionParams[] = [];
      let releaseInterrupted!: () => void;
      const interruptedGate = new Promise<void>((resolve) => {
        releaseInterrupted = resolve;
      });
      let beginInterrupted!: () => void;
      const interruptedBegun = new Promise<void>((resolve) => {
        beginInterrupted = resolve;
      });
      const provider: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set(),
        async openSession(params) {
          opens.push(params);
          if (params.thread.kind === "branch") {
            return forkSessionStub({
              providerId: "anthropic",
              model: "claude-fork",
              events: (async function* (): AsyncIterable<ModelSessionEvent> {
                yield { type: "result", reasoningEffort: "high", content: "Fork complete" };
              })(),
            });
          }
          const model = createSessionFromRun(
            "anthropic",
            async function* () {
              beginInterrupted();
              await interruptedGate;
              yield {
                type: "result",
                content: "Work before cancellation",
                position: {
                  provider: "anthropic",
                  modelThreadId: "persisted-claude-thread",
                  checkpointId: "assistant-current",
                },
              };
            },
            params,
          );
          return {
            ...model,
            modelThreadId: "persisted-claude-thread",
            async interrupt() {
              releaseInterrupted();
            },
          };
        },
      };
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true },
      );
      const runner = new AgentRunner(manager, agentLoader);
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:abort-fork",
      });
      const interrupted = await startAfter(session, { prompt: "first" });
      const interruptedMessages = collectMessages(interrupted.events());
      await interruptedBegun;
      await interrupted.stop!("user-stop");
      expect(await interruptedMessages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );

      const forkMessages = await collectMessages(
        runner.runForked({
          agentName: "test-main",
          sourceSessionId: session.sessionId,
          channelThreadKey: "webchat:abort-fork",
          prompt: "fork it",
          mode: "exact",
          sourceCheckpoint: {
            providerId: "anthropic",
            providerThreadId: "persisted-claude-thread",
            checkpointId: "assistant-current",
          },
        }),
      );

      expect(forkMessages.map((message) => message.type)).toEqual([
        "turn_start",
        "result",
        "turn_end",
      ]);
      expect(forkMessages[1]).toMatchObject({ type: "result", content: "Fork complete" });
      expect(opens).toHaveLength(2);
      expect(opens[1]?.thread).toEqual({
        kind: "branch",
        at: {
          provider: "anthropic",
          modelThreadId: "persisted-claude-thread",
          checkpointId: "assistant-current",
        },
        lifetime: "ephemeral",
      });
      await manager.shutdown();
    });

    it.each([
      true,
      false,
    ])("cold recovery acquisition: newer guardian input = %s", async (newerInput) => {
      const repo = new ChatsWebChatRepository(testDb.db);
      const chatId = "cold-recovery-chat";
      const key = { agentName: "core:test-main", channelThreadKey: `webchat:${chatId}` };
      await repo.createSession(
        chatId,
        "Recovery",
        undefined,
        "default",
        null,
        "default",
        key.agentName,
      );
      const stored = Session.create(key.agentName, { continuityKey: key.channelThreadKey });
      await sessionRepository.add(stored);
      await repo.recordSessionInChat(stored.id, chatId);
      await repo.recordUserInput("original-input", chatId, "[]");
      await repo.updateUserInput(chatId, {
        type: "input_status",
        inputId: "original-input",
        turnId: "cut-off",
        state: "consumed",
      });
      await repo.appendTraceBlocks({
        messageId: "cut-off-trace",
        sessionId: chatId,
        turnId: "cut-off",
        startSeq: 0,
        blocks: [
          {
            type: "turn_start",
            turnId: "cut-off",
            sessionId: stored.id,
            userPrompt: "Continue work",
          },
        ],
      });
      const [cutOff] = await repo.endInterruptedTurns(24 * 60 * 60 * 1000);
      const beforeTrace = await repo.getTraceContents(chatId);
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const resume = manager.resume.bind(manager) as (...args: unknown[]) => Promise<AgentSession>;
      let notifyEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        notifyEntered = resolve;
      });
      let releaseAcquire!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseAcquire = resolve;
      });
      let acquired!: AgentSession;
      let submit!: ReturnType<typeof rs.spyOn<AgentSession, "submit">>;
      rs.spyOn(manager, "resume").mockImplementation((async (...args: unknown[]) => {
        notifyEntered();
        await release;
        acquired = await resume(...args);
        submit = rs.spyOn(acquired, "submit");
        return acquired;
      }) as Sessions["resume"]);
      const agentRunner = new AgentRunner(manager, agentLoader, repo);
      const send = rs.fn(async () => ({ messageId: "reply", chatId }));
      const emit = rs.fn(async () => {});
      const backend = createBackendTurnRunner({
        agentRunner,
        channel: () => ({ name: "webchat", send: { send } }) as unknown as Channel,
      });
      backend.setWebchatRuntime({
        enqueueSessionTask: async (_id, task) => {
          await task({ emit });
        },
      });
      const shouldRun = rs.fn(() => repo.canContinueAfterRestart(cutOff!));
      try {
        const running = backend.runAndReport(
          {
            agentName: key.agentName,
            sessionId: stored.id,
            channel: "webchat",
            threadId: chatId,
            prompt: "Recover interrupted work",
          },
          { shouldRun },
        );
        await entered;
        expect(shouldRun).toHaveBeenCalledTimes(1);
        if (newerInput) await repo.recordUserInput("new-guardian-input", chatId, "[]");
        expect(shouldRun()).toBe(!newerInput);
        releaseAcquire();
        const outcome = await running;
        if (newerInput) {
          expect(submit).not.toHaveBeenCalled();
          expect(outcome).toBe("failed");
          expect(emit).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
          expect(await repo.getTraceContents(chatId)).toEqual(beforeTrace);
          expect(acquired.status).toBe("idle");
          expect(acquired.runningTurn).toBeUndefined();
          expect(await manager.open(key)).toBe(acquired);
          const followUp = await collectMessages(
            (await startAfter(acquired, { prompt: "Guardian follow-up" })).events(),
          );
          expect(followUp.some((event) => event.type === "result")).toBe(true);
        } else {
          expect(submit).toHaveBeenCalledTimes(1);
          expect(outcome).toBe("completed");
          expect(send).toHaveBeenCalledTimes(1);
        }
      } finally {
        releaseAcquire();
        await manager.shutdown();
      }
    });

    it("resumes an explicit sessionId without a caller-provided channelThreadKey", async () => {
      const submit: AgentSession["submit"] = rs.fn(() =>
        testReceipt(
          testTurnHandle({
            turnId: "turn-1",
            events: (async function* () {
              yield { type: "result", content: "resumed", agent: "test-main" } as const;
            })(),
            turnContext: context.active(),
          }),
        ),
      );
      const session: AgentSession = {
        selectModel: () => {},
        release: () => {},
        key: { agentName: "test-main", channelThreadKey: "telegram:t-1" },
        sessionId: "sess-1",
        status: "idle",
        submit,
        fork: rs.fn(),
        onStatusChange: rs.fn(() => () => undefined),
        stop: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager: Sessions = {
        open: rs.fn(async () => {
          throw new Error("implicit open should not be used");
        }),
        resume: rs.fn(async () => session),
        find: rs.fn(() => undefined),
        findWorkingDirBySessionId: rs.fn(),
        turn: rs.fn(),
        shutdown: rs.fn(async () => undefined),
      };
      const runner = new AgentRunner(manager, agentLoader);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue approval",
          sessionId: "sess-1",
        }),
      );

      expect(manager.resume).toHaveBeenCalledTimes(1);
      expect(manager.resume).toHaveBeenCalledWith(
        { id: "sess-1", agent: "test-main" },
        expect.objectContaining({}),
      );
      expect(submit).toHaveBeenCalledWith(
        { prompt: "Continue approval" },
        expect.objectContaining({ priority: "after", initiatedBy: "user" }),
      );
    });

    it("hands a turn's push level to the session turn", async () => {
      const submit: AgentSession["submit"] = rs.fn(() =>
        testReceipt(
          testTurnHandle({
            turnId: "turn-1",
            events: (async function* () {
              yield { type: "result", content: "resumed", agent: "test-main" } as const;
            })(),
            turnContext: context.active(),
          }),
        ),
      );
      const session: AgentSession = {
        selectModel: () => {},
        release: () => {},
        key: { agentName: "test-main", channelThreadKey: "telegram:t-1" },
        sessionId: "sess-1",
        status: "idle",
        submit,
        fork: rs.fn(),
        onStatusChange: rs.fn(() => () => undefined),
        stop: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager: Sessions = {
        open: rs.fn(async () => {
          throw new Error("implicit open should not be used");
        }),
        resume: rs.fn(async () => session),
        find: rs.fn(() => undefined),
        findWorkingDirBySessionId: rs.fn(),
        turn: rs.fn(),
        shutdown: rs.fn(async () => undefined),
      };
      const runner = new AgentRunner(manager, agentLoader);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "<task_events/>",
          sessionId: "sess-1",
          initiatedBy: "system",
          pushLevel: "active",
        }),
      );

      expect(submit).toHaveBeenCalledWith(
        { prompt: "<task_events/>" },
        expect.objectContaining({ priority: "after", initiatedBy: "system", pushLevel: "active" }),
      );
    });

    it("creates new session when no existing session found", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Hello" },
          { type: "result", content: "Hello" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Hi",
          channelThreadKey: "telegram:thread-new",
        }),
      );

      const sessionInit = messages.find((m) => m.type === "session_init") as {
        type: "session_init";
        sessionId: string;
      };
      const stored = await sessionRepository.current("telegram:thread-new", "core:test-main");
      expect(stored?.id).toBe(sessionInit.sessionId);
      expect(stored?.agentName).toBe("core:test-main");
      // New session ids are UUIDv7, which sort by when they were minted.
      expect(uuidVersion(sessionInit.sessionId)).toBe(7);
    });

    it("reuses an active session for the same key", async () => {
      const seeded = Session.create("core:test-main", { continuityKey: "telegram:thread-reuse" });
      await sessionRepository.add(seeded);
      const existingId = seeded.id;

      const provider = new MockModelProvider([
        [
          { type: "text", content: "Reused" },
          { type: "result", content: "Reused" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue",
          channelThreadKey: "telegram:thread-reuse",
        }),
      );

      const sessionInit = messages.find((m) => m.type === "session_init") as {
        type: "session_init";
        sessionId: string;
      };
      expect(sessionInit.sessionId).toBe(existingId);
    });

    it("rotates an expired external-IM provider generation before running the turn", async () => {
      const seeded = Session.create("core:test-main", {
        deprecatedId: "expired-generation",
        continuityKey: "telegram:thread-reset",
      });
      await sessionRepository.add(seeded);
      const existingId = seeded.id;
      await testDb.db
        .update(sessions)
        .set({ lastActiveAt: new Date("2026-07-01T00:00:00Z") })
        .where(eq(sessions.id, existingId));

      const provider = new MockModelProvider([
        [
          { type: "text", content: "Fresh context" },
          { type: "result", content: "Fresh context" },
        ],
      ]);
      const runner = createRunner(provider, undefined, {
        resetPolicy: { mode: "idle", idleMinutes: 10_080 },
      });
      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue",
          channelThreadKey: "telegram:thread-reset",
          romeSessionId: "channel:telegram:thread-reset",
          platformMessageId: "message-reset",
          threadContext: {
            channel: "telegram",
            connectionId: "telegram-1",
            threadId: "thread-reset",
          },
        }),
      );

      const sessionInit = messages.find((message) => message.type === "session_init");
      expect(sessionInit?.type === "session_init" ? sessionInit.sessionId : undefined).not.toBe(
        existingId,
      );
      expect(uuidVersion(sessionInit?.type === "session_init" ? sessionInit.sessionId : "")).toBe(
        7,
      );
      expect((await sessionRepository.session(existingId))?.status).toBe("completed");
      expect(
        await sessionRepository.current("telegram:thread-reset", "core:test-main"),
      ).toMatchObject({
        id: sessionInit?.type === "session_init" ? sessionInit.sessionId : undefined,
        status: "active",
      });
    });

    describe("a session whose agent renews it when its setup changes", () => {
      const key = "webchat:renewing-chat";
      const identity = { text: "**Agent Name:** Yo" };
      const charter = { text: "Be kind." };
      const instance = {
        apps: [] as { appId: string; description: string }[],
        publicOrigin: undefined as string | undefined,
      };
      let sessionTools: RomeTool[];
      const managers: Sessions[] = [];
      /** Sessions an approval waits to resume mid-turn. */
      const held = new Set<string>();

      afterEach(async () => {
        await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
      });

      function renewingRunner(
        provider: MockModelProvider,
        /** Runs each time a model is resolved, as a turn prepares its model session. */
        onResolve?: () => Promise<void>,
        extraDeps: Partial<Parameters<typeof createSessions>[0]> = {},
      ): AgentRunner {
        const resolver = createTestModelResolver({ providers: [provider] });
        const resolve = resolver.resolve.bind(resolver);
        resolver.resolve = async (request) => {
          await onResolve?.();
          return resolve(request);
        };
        const sources: PromptSources = {
          material: () => ({
            charter: charter.text,
            identity: identity.text,
            runtime: {
              profileDir: "/profile",
              profileMemoryDir: "/profile/memory",
              customAppAuthoringDir: "/profile/projects/apps",
              installedAppsDir: "/profile/apps/installed",
              repoAppsDir: "/repo/rome_apps",
              internalApiBaseUrl: "http://127.0.0.1:4141",
              docsDir: null,
              ...(instance.publicOrigin ? { publicOrigin: instance.publicOrigin } : {}),
            },
            installedApps: instance.apps,
          }),
          // Memory is not part of the setup.
          memory: () => ({ index: `Memory read at ${Math.random()}`, projects: [] }),
          onChanged: () => {},
        };
        const manager = createSessions(
          {
            ...managerDeps(resolver),
            systemPrompts: createSystemPrompts({ sources }),
            sessionTools: { forTurn: async () => sessionTools },
            heldMidTurn: async (sessionId: string) => held.has(sessionId),
            ...extraDeps,
          },
          // As in production, a session stays open between turns until it
          // is evicted (`evict`).
          { keepAliveAcrossTurns: true },
        );
        managers.push(manager);
        const runner = new AgentRunner(
          manager,
          agentLoader,
          new ChatsWebChatRepository(testDb.db),
          undefined,
          undefined,
          undefined,
          undefined,
          sessionOpeningFor({ channelSurface: testChannelSurface }),
        );
        managerOf.set(runner, manager);
        return runner;
      }

      const tool = (description: string): RomeTool => ({
        name: "say",
        description,
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      });

      const managerOf = new WeakMap<AgentRunner, Sessions>();
      /** Closes the chat's live session, as its idle eviction does, so the
       *  next turn opens it cold. */
      async function evict(runner: AgentRunner) {
        await managerOf
          .get(runner)
          ?.find({ agentName: "test-renewing", channelThreadKey: key })
          ?.close("idle");
      }

      /** One turn of the chat, opened cold unless `live`. */
      async function turn(
        runner: AgentRunner,
        params: { sessionId?: string; contextSuffix?: string; live?: boolean } = {},
      ) {
        if (!params.live) await evict(runner);
        const messages = await collectMessages(
          runner.run({
            agentName: "test-renewing",
            prompt: "Hello",
            ...(params.contextSuffix ? { contextSuffix: params.contextSuffix } : {}),
            ...(params.sessionId ? { sessionId: params.sessionId } : { channelThreadKey: key }),
          }),
        );
        const init = messages.find((message) => message.type === "session_init");
        return init?.type === "session_init" ? init.sessionId : undefined;
      }

      const replies = (count: number) =>
        Array.from({ length: count }, () => [{ type: "result" as const, content: "ok" }]);

      beforeEach(() => {
        identity.text = "**Agent Name:** Yo";
        charter.text = "Be kind.";
        instance.apps = [];
        instance.publicOrigin = undefined;
        sessionTools = [tool("Send one message.")];
        held.clear();
      });

      it("keeps the session while the setup is unchanged", async () => {
        const runner = renewingRunner(new MockModelProvider(replies(2)));
        const first = await turn(runner);
        const second = await turn(runner);

        expect(second).toBe(first);
        expect((await sessionRepository.current(key, "core:test-renewing"))?.setup).toMatch(
          /^[0-9a-f]{64}$/,
        );
      });

      it("keeps the session when only the guardian's profile in the context changes", async () => {
        const runner = renewingRunner(new MockModelProvider(replies(2)));
        const first = await turn(runner, { contextSuffix: "## Guardian\n\nLikes tea." });
        const second = await turn(runner, { contextSuffix: "## Guardian\n\nLikes coffee." });

        expect(second).toBe(first);
      });

      it("renews the session when a declared MCP server's command or arguments change", async () => {
        const definition = agentLoader.find("test-renewing")!.definition as {
          mcpServers?: Record<string, { command: string; args: string[] }>;
        };
        const declared = definition.mcpServers;
        try {
          definition.mcpServers = { notes: { command: "node", args: ["notes.js"] } };
          const runner = renewingRunner(new MockModelProvider(replies(4)));
          const first = await turn(runner);
          const unchanged = await turn(runner);
          definition.mcpServers = { notes: { command: "node", args: ["notes.js", "--v2"] } };
          const newArgs = await turn(runner);
          definition.mcpServers = { notes: { command: "deno", args: ["notes.js", "--v2"] } };
          const newCommand = await turn(runner);

          expect(unchanged).toBe(first);
          expect(newArgs).not.toBe(first);
          expect(newCommand).not.toBe(newArgs);
        } finally {
          definition.mcpServers = declared;
        }
      });

      it.each([
        [
          "an added builtin tool",
          (definition: AgentDefinition) => {
            definition.tools = [...definition.tools, "Bash"];
          },
          (params: ModelSessionParams) => expect(params.config.builtinTools).toContain("Bash"),
        ],
        [
          "a changed MCP server",
          (definition: AgentDefinition) => {
            definition.mcpServers = { notes: { command: "node", args: ["notes.js", "--v2"] } };
          },
          (params: ModelSessionParams) =>
            expect(params.config.externalMcpServers?.notes).toMatchObject({
              args: ["notes.js", "--v2"],
            }),
        ],
        [
          "a changed output schema",
          (definition: AgentDefinition) => {
            definition.outputSchema = {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            };
          },
          (params: ModelSessionParams) =>
            expect(params.config.outputSchema).toMatchObject({
              properties: { answer: { type: "string" } },
            }),
        ],
      ])("renews on %s, and the fresh backend opens with it", async (_change, change, check) => {
        // A reload gives the agent a new definition; the open-time one stays as it was.
        const agent = agentLoader.find("test-renewing")! as { definition: AgentDefinition };
        const original = agent.definition;
        try {
          // Declared servers reach the provider with the discovered ones.
          agent.definition = {
            ...original,
            networkDiscovery: true,
            mcpServers: { notes: { command: "node", args: ["notes.js"] } },
          };
          const provider = new MockModelProvider(replies(2));
          provider.builtinTools = new Set(["Bash"]);
          const runner = renewingRunner(provider, undefined, {
            networkMcpServers: () => ({ found: { command: "found", args: [] } }),
          });
          const first = await turn(runner);
          const setupBefore = (await sessionRepository.session(first!))?.setup;
          const reloaded = structuredClone(agent.definition);
          change(reloaded);
          agent.definition = reloaded;
          const renewed = await turn(runner);

          expect(renewed).not.toBe(first);
          const setupAfter = (await sessionRepository.session(renewed!))?.setup;
          expect(setupAfter).toMatch(/^[0-9a-f]{64}$/);
          expect(setupAfter).not.toBe(setupBefore);
          expect(provider.sessions).toHaveLength(2);
          check(provider.sessions[1]!);
          expect(provider.sessions[1]!.thread).toEqual({ kind: "new" });
        } finally {
          agent.definition = original;
        }
      });

      it("records nothing when a cold renewal's fresh open fails, and retries fresh on the next cold open", async () => {
        const provider = new MockModelProvider(replies(3));
        const open = provider.openSession.bind(provider);
        let failNext = false;
        provider.openSession = async (params) => {
          if (failNext) {
            failNext = false;
            provider.sessions.push(params);
            throw new Error("provider down");
          }
          // The provider names a thread the session could resume.
          return Object.assign(await open(params), { modelThreadId: "thread-1" });
        };
        const runner = renewingRunner(provider);
        const first = await turn(runner);
        identity.text = "**Agent Name:** YoYo";
        failNext = true;

        await evict(runner);
        await expect(
          collectMessages(
            runner.run({ agentName: "test-renewing", prompt: "Hi", channelThreadKey: key }),
          ),
        ).rejects.toThrow("provider down");
        expect((await sessionRepository.session(first!))?.supersededBy).toBeFalsy();
        expect((await sessionRepository.current(key, "core:test-renewing"))?.id).toBe(first);

        const retried = await turn(runner);
        expect(retried).not.toBe(first);
        expect((await sessionRepository.session(first!))?.supersededBy).toBe(retried);
        expect(provider.calls.at(-1)?.prompt).toContain("<continuation>");
        // Every open after the first starts a fresh thread: none resumes the retired one.
        expect(provider.sessions.slice(1).map((params) => params.thread)).toEqual([
          { kind: "new" },
          { kind: "new" },
        ]);
      });

      it("keeps the working folder on the successor, across an eviction and a resume by id", async () => {
        const folder = await mkdtemp(join(tmpdir(), "rome-renew-dir-"));
        try {
          const provider = new MockModelProvider(replies(3));
          const runner = renewingRunner(provider);
          await collectMessages(
            runner.run({
              agentName: "test-renewing",
              prompt: "Hi",
              channelThreadKey: key,
              workingDir: folder,
            }),
          );
          identity.text = "**Agent Name:** YoYo";
          const renewed = await turn(runner);
          expect((await sessionRepository.session(renewed!))?.workingDir).toBe(folder);

          // Evicted: a fresh manager has nothing in memory and resumes the row.
          await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
          const resumed = await turn(renewingRunner(provider), { sessionId: renewed });

          expect(resumed).toBe(renewed);
          expect(provider.sessions.at(-1)?.config.workingDir).toBe(folder);
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      });

      it("keeps the session when an app is installed or the instance's address changes", async () => {
        const runner = renewingRunner(new MockModelProvider(replies(3)));
        const first = await turn(runner);
        instance.apps = [{ appId: "notes", description: "Takes notes." }];
        const afterInstall = await turn(runner);
        instance.publicOrigin = "https://rome.example.com";
        const afterAddress = await turn(runner);

        expect([afterInstall, afterAddress]).toEqual([first, first]);
      });

      it.each([
        ["a rename", () => (identity.text = "**Agent Name:** YoYo")],
        ["a tool change", () => (sessionTools = [tool("Send one message, in a thread.")])],
        [
          "a new tool",
          () => (sessionTools = [tool("Send one message."), { ...tool("x"), name: "x" }]),
        ],
      ])("starts a fresh session in the same chat after %s", async (_change, change) => {
        const provider = new MockModelProvider(replies(2));
        const runner = renewingRunner(provider);
        const first = await turn(runner);
        change();
        const second = await turn(runner);

        expect(second).not.toBe(first);
        expect((await sessionRepository.session(first!))?.status).toBe("completed");
        expect(await sessionRepository.current(key, "core:test-renewing")).toMatchObject({
          id: second,
          status: "active",
        });
        // The fresh session continues the chat, so it reads the earlier messages.
        expect(provider.calls[1]?.prompt).toContain("<continuation>");
        expect(provider.calls[0]?.prompt).not.toContain("<continuation>");
      });

      /** A provider whose every open names a thread of its own, as real ones do. */
      function threadedProvider(count: number) {
        const provider = new MockModelProvider(replies(count));
        const open = provider.openSession.bind(provider);
        provider.openSession = async (params) =>
          Object.assign(await open(params), {
            modelThreadId:
              params.thread.kind === "resume"
                ? params.thread.modelThreadId
                : `thread-${provider.sessions.length}`,
          });
        return provider;
      }

      it("opens fresh on a cold open after a setup change, with the continuation and the renewal line on its first turn only", async () => {
        const provider = threadedProvider(3);
        const runner = renewingRunner(provider);
        const starts: unknown[] = [];
        const run = async () => {
          await evict(runner);
          const messages = await collectMessages(
            runner.run({ agentName: "test-renewing", prompt: "Hi", channelThreadKey: key }),
          );
          const start = messages.find((message) => message.type === "turn_start");
          starts.push(start && "sessionRenewal" in start ? start.sessionRenewal : undefined);
          return start?.type === "turn_start" ? start.sessionId : undefined;
        };
        const first = await run();
        identity.text = "**Agent Name:** YoYo";
        const renewed = await run();
        const after = await run();

        expect(renewed).not.toBe(first);
        expect(after).toBe(renewed);
        expect(starts).toEqual([undefined, { reason: "setup", sessionId: renewed }, undefined]);
        expect(provider.sessions.map((params) => params.thread)).toEqual([
          { kind: "new" },
          { kind: "new" },
          { kind: "resume", modelThreadId: "thread-2" },
        ]);
        expect(provider.calls[1]?.prompt).toContain("<continuation>");
        expect(provider.calls[2]?.prompt).not.toContain("<continuation>");
      });

      it("sends a header block again only when it changed, or to a thread that has not read it", async () => {
        const provider = threadedProvider(5);
        const runner = renewingRunner(provider, undefined, { stickyHeaders: ["concierge_chat"] });
        const say = (name: string, text: string) =>
          collectMessages(
            runner.run({
              agentName: "test-renewing",
              prompt: `<concierge_chat id="c1" name="${name}"/>\n\n${text}`,
              channelThreadKey: key,
            }),
          );
        await say("Main", "one");
        await say("Main", "two");
        await say("Home", "three");
        // Reopened on the same thread, which already read it.
        await evict(runner);
        await say("Home", "four");
        // A setup change starts a new thread, which reads it from its first input.
        identity.text = "**Agent Name:** YoYo";
        await evict(runner);
        await say("Home", "five");

        const prompts = provider.calls.map((call) => call.prompt);
        expect(prompts[0]).toContain('<concierge_chat id="c1" name="Main"/>');
        expect(prompts[1]).not.toContain("<concierge_chat");
        expect(prompts[1]).toContain("two");
        expect(prompts[2]).toContain('<concierge_chat id="c1" name="Home"/>');
        expect(provider.sessions[1]?.thread).toEqual({ kind: "resume", modelThreadId: "thread-1" });
        expect(prompts[3]).not.toContain("<concierge_chat");
        expect(prompts[4]).toContain('<concierge_chat id="c1" name="Home"/>');
      });

      it("sends the headers again after the provider compacted the thread", async () => {
        const provider = threadedProvider(4);
        const withContext = (usedTokens: number) =>
          [
            {
              type: "result" as const,
              content: "ok",
              accounting: {
                provider: "mock",
                model: "mock",
                usage: {
                  inputTokens: usedTokens,
                  outputTokens: 1,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
                context: { usedTokens },
                costUsd: 0,
              },
            },
          ] as AgentEvent[];
        provider["responses"][0] = withContext(9_000);
        provider["responses"][1] = withContext(10_000);
        // Compacted: the thread holds less than it did a turn ago.
        provider["responses"][2] = withContext(3_000);
        const runner = renewingRunner(provider, undefined, { stickyHeaders: ["concierge_chat"] });
        for (const text of ["one", "two", "three", "four"]) {
          await collectMessages(
            runner.run({
              agentName: "test-renewing",
              prompt: `<concierge_chat id="c1" name="Main"/>\n\n${text}`,
              channelThreadKey: key,
            }),
          );
        }
        const prompts = provider.calls.map((call) => call.prompt);
        expect(prompts.map((prompt) => prompt.includes("<concierge_chat"))).toEqual([
          true,
          false,
          false,
          true,
        ]);
      });

      describe("with a handoff", () => {
        const HANDOFF = "- Agreed: dinner at 7 on Friday, task t-1.";
        let handoffAgent: { definition: AgentDefinition };
        let original: AgentDefinition;
        beforeEach(() => {
          handoffAgent = agentLoader.find("test-renewing")! as { definition: AgentDefinition };
          original = handoffAgent.definition;
          handoffAgent.definition = {
            ...original,
            policy: { ...original.policy, handoffOnRenewal: true },
          };
        });
        afterEach(() => {
          handoffAgent.definition = original;
        });

        /** The handoff port, recording what it was asked. */
        function fakeHandoffs(overrides: Partial<RenewalHandoffs> = {}) {
          const asked = { tidying: [] as (string | undefined)[], fallback: 0, context: 0 };
          const handoffs: RenewalHandoffs = {
            timeoutMs: 1_000,
            tidying: async (chatId, work) => {
              asked.tidying.push(chatId);
              return work();
            },
            fallback: async () => {
              asked.fallback += 1;
              return "- Fallback note.";
            },
            context: async () => {
              asked.context += 1;
              return {
                openTasks: "- t-1 · Book dinner · active",
                recent: [{ senderName: "Guardian", text: "Friday at 7 then", at: new Date(0) }],
              };
            },
            ...overrides,
          };
          return { handoffs, asked };
        }

        /** One cold turn, and every event it streamed. */
        async function coldTurn(runner: AgentRunner) {
          await evict(runner);
          return collectMessages(
            runner.run({ agentName: "test-renewing", prompt: "Hi", channelThreadKey: key }),
          );
        }

        it("asks the retired session for a handoff, stores it, and opens the successor with it", async () => {
          const provider = threadedProvider(4);
          // The second call is the handoff turn: it answers with the note.
          provider["responses"][1] = [{ type: "result", content: HANDOFF }];
          const { handoffs, asked } = fakeHandoffs();
          // Every turn the chat, its status marks, pushes and task events hear of.
          const lifecycle = { started: 0, ended: 0, couldNotStart: 0 };
          const turnLifecycle = {
            started: () => void lifecycle.started++,
            ended: () => void lifecycle.ended++,
            couldNotStart: () => void lifecycle.couldNotStart++,
          };
          const runner = renewingRunner(provider, undefined, { handoffs, turnLifecycle });
          await coldTurn(runner);
          identity.text = "**Agent Name:** YoYo";
          const renewedEvents = await coldTurn(runner);
          // Two messages, two turns: the handoff turn is none of them.
          expect(lifecycle).toEqual({ started: 2, ended: 2, couldNotStart: 0 });
          // It could not say anything: it served no tool in any group, and refuses `say`.
          const handoffTools = provider.sessions[1]!.tools;
          for (const group of ROME_TOOL_GROUPS) expect(handoffTools.listTools(group)).toEqual([]);
          expect((await handoffTools.callTool("actions", "say", { text: "hi" })).isError).toBe(
            true,
          );
          const renewed = await sessionRepository.current(key, "core:test-renewing");

          // The handoff turn resumed the retired thread with no tools.
          expect(provider.sessions[1]?.thread).toEqual({
            kind: "resume",
            modelThreadId: "thread-1",
          });
          expect(provider.sessions[1]?.tools.listTools("actions")).toEqual([]);
          expect(provider.calls[1]?.prompt).toContain("<handoff_request>");
          expect(renewed?.handoff).toBe(HANDOFF);
          expect(asked.tidying).toHaveLength(1);
          expect(asked.fallback).toBe(0);
          // The successor's first turn carries it, with the open tasks and recent messages.
          const firstPrompt = provider.calls[2]?.prompt ?? "";
          expect(firstPrompt).toContain(`<handoff>\n${HANDOFF}\n</handoff>`);
          expect(firstPrompt).toContain("<open_tasks>\n- t-1 · Book dinner · active");
          expect(firstPrompt).toContain("Guardian: Friday at 7 then");
          // Nothing of the handoff turn reached the chat: one turn, answered by the successor.
          expect(renewedEvents.filter((event) => event.type === "turn_start")).toHaveLength(1);
          expect(
            renewedEvents.some(
              (event) => event.type === "result" && event.content.includes("dinner"),
            ),
          ).toBe(false);
          expect(renewedEvents.find((event) => event.type === "turn_start")?.sessionId).toBe(
            renewed?.id,
          );

          // A later turn of the successor carries it no more.
          await coldTurn(runner);
          expect(provider.calls[3]?.prompt).not.toContain("<handoff>");
        });

        it("writes it with the fallback when the retired session does not answer in time", async () => {
          const provider = threadedProvider(3);
          const open = provider.openSession.bind(provider);
          provider.openSession = async (params) => {
            if (params.thread.kind !== "resume") return open(params);
            provider.sessions.push(params);
            // A thread that never answers.
            return {
              providerId: "mock",
              model: params.config.model,
              events: (async function* () {
                await new Promise(() => {});
              })(),
              sendUserInput: async () => {},
              interrupt: async () => {},
              close: async () => {},
            } as ModelSession;
          };
          const { handoffs, asked } = fakeHandoffs({ timeoutMs: 20 });
          const runner = renewingRunner(provider, undefined, { handoffs });
          await coldTurn(runner);
          identity.text = "**Agent Name:** YoYo";
          await coldTurn(runner);

          expect(asked.fallback).toBe(1);
          expect((await sessionRepository.current(key, "core:test-renewing"))?.handoff).toBe(
            "- Fallback note.",
          );
          expect(provider.calls.at(-1)?.prompt).toContain("- Fallback note.");
        });

        it("renews without a handoff when neither the session nor the fallback writes one", async () => {
          const provider = threadedProvider(3);
          provider["responses"][1] = [{ type: "error", error: "thread gone" }];
          const { handoffs, asked } = fakeHandoffs({ fallback: async () => null });
          const runner = renewingRunner(provider, undefined, { handoffs });
          const first = await coldTurn(runner);
          identity.text = "**Agent Name:** YoYo";
          await coldTurn(runner);

          const renewed = await sessionRepository.current(key, "core:test-renewing");
          expect(renewed?.id).not.toBe(
            first.find((event) => event.type === "turn_start")?.sessionId,
          );
          expect(renewed?.handoff).toBeNull();
          expect(asked.context).toBe(0);
          expect(provider.calls.at(-1)?.prompt).toContain("<continuation>");
          expect(provider.calls.at(-1)?.prompt).not.toContain("<handoff>");
        });

        /** Lets a turn end's background renewal run, as a guardian's pause would. */
        const settleRenewal = () => new Promise((resolve) => setTimeout(resolve, 100));

        /** A result whose last model request read `usedTokens` of context. */
        const fullResult = (usedTokens: number, content = "ok") =>
          [
            {
              type: "result" as const,
              content,
              accounting: {
                provider: "mock",
                model: "mock",
                usage: {
                  inputTokens: usedTokens,
                  outputTokens: 1,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
                context: { usedTokens, windowTokens: 1_000, remainingTokens: 1_000 - usedTokens },
                costUsd: 0,
              },
            },
          ] as AgentEvent[];

        it("renews a session whose turn ended past the context limit, with a handoff, before the next message", async () => {
          const provider = threadedProvider(4);
          provider["responses"][0] = fullResult(900);
          provider["responses"][1] = [{ type: "result", content: HANDOFF }];
          const { handoffs, asked } = fakeHandoffs({ contextLimitTokens: 500 });
          const runner = renewingRunner(provider, undefined, { handoffs });
          const first = await turn(runner, { live: true });
          expect((await sessionRepository.session(first!))?.contextTokens).toBe(900);
          // The guardian answers a moment later, after the turn has settled.
          await settleRenewal();

          // The next message, with no eviction: the renewal ran when the turn ended.
          const events = await collectMessages(
            runner.run({ agentName: "test-renewing", prompt: "Hi", channelThreadKey: key }),
          );
          const start = events.find((event) => event.type === "turn_start");
          const renewed = await sessionRepository.current(key, "core:test-renewing");
          expect(renewed?.id).not.toBe(first);
          expect(renewed?.handoff).toBe(HANDOFF);
          expect((await sessionRepository.session(first!))?.supersededFor).toBe("context");
          expect(start && "sessionRenewal" in start ? start.sessionRenewal : undefined).toEqual({
            reason: "context",
            sessionId: renewed?.id,
          });
          expect(provider.sessions.map((params) => params.thread)).toEqual([
            { kind: "new" },
            { kind: "resume", modelThreadId: "thread-1" },
            { kind: "new" },
          ]);
          expect(provider.calls[2]?.prompt).toContain(`<handoff>\n${HANDOFF}\n</handoff>`);
          expect(asked.tidying).toHaveLength(1);
        });

        it("does not renew again a successor no turn ran on when the setup changes: it takes the new setup and keeps its handoff", async () => {
          const provider = threadedProvider(4);
          provider["responses"][0] = fullResult(900);
          provider["responses"][1] = [{ type: "result", content: HANDOFF }];
          const { handoffs, asked } = fakeHandoffs({ contextLimitTokens: 500 });
          const runner = renewingRunner(provider, undefined, { handoffs });
          const first = await turn(runner, { live: true });
          // The background renewal writes the successor on no thread.
          await settleRenewal();
          await evict(runner);
          const successor = await sessionRepository.current(key, "core:test-renewing");
          expect(successor?.id).not.toBe(first);
          expect(successor?.modelThreadId).toBeNull();
          const setupBefore = successor?.setup;

          identity.text = "**Agent Name:** YoYo";
          const events = await collectMessages(
            runner.run({ agentName: "test-renewing", prompt: "Hi", channelThreadKey: key }),
          );
          const after = await sessionRepository.current(key, "core:test-renewing");
          const start = events.find((event) => event.type === "turn_start");

          expect(after?.id).toBe(successor?.id);
          expect(after?.handoff).toBe(HANDOFF);
          expect(after?.setup).not.toBe(setupBefore);
          expect(asked.fallback).toBe(0);
          // One handoff turn in all: the retired thread was asked once.
          expect(
            provider.calls.filter((call) => call.prompt.includes("<handoff_request>")),
          ).toHaveLength(1);
          expect(start && "sessionRenewal" in start ? start.sessionRenewal : undefined).toEqual({
            reason: "context",
            sessionId: successor?.id,
          });
          expect(provider.calls.at(-1)?.prompt).toContain(`<handoff>\n${HANDOFF}\n</handoff>`);
        });

        it("reuses the handoff it wrote when the fresh session fails to open, and asks the retired thread once", async () => {
          const provider = threadedProvider(4);
          provider["responses"][1] = [{ type: "result", content: HANDOFF }];
          const open = provider.openSession.bind(provider);
          let failFresh = false;
          provider.openSession = async (params) => {
            if (failFresh && params.thread.kind === "new") {
              failFresh = false;
              throw new Error("provider down");
            }
            return open(params);
          };
          const { handoffs } = fakeHandoffs();
          const runner = renewingRunner(provider, undefined, { handoffs });
          await coldTurn(runner);
          identity.text = "**Agent Name:** YoYo";
          failFresh = true;
          await evict(runner);
          await expect(
            collectMessages(
              runner.run({ agentName: "test-renewing", prompt: "Hi", channelThreadKey: key }),
            ),
          ).rejects.toThrow("provider down");
          await coldTurn(runner);

          expect(
            provider.calls.filter((call) => call.prompt.includes("<handoff_request>")),
          ).toHaveLength(1);
          expect((await sessionRepository.current(key, "core:test-renewing"))?.handoff).toBe(
            HANDOFF,
          );
        });

        it("steps aside for a message that comes before the session settles, and renews at the next turn end", async () => {
          const provider = threadedProvider(4);
          provider["responses"][0] = fullResult(900);
          provider["responses"][1] = fullResult(950);
          provider["responses"][2] = [{ type: "result", content: HANDOFF }];
          const { handoffs } = fakeHandoffs({ contextLimitTokens: 500 });
          const runner = renewingRunner(provider, undefined, { handoffs });
          const first = await turn(runner, { live: true });
          // At once: the live session takes it, and nothing waits on a renewal.
          expect(await turn(runner, { live: true })).toBe(first);
          await settleRenewal();
          expect((await sessionRepository.session(first!))?.supersededFor).toBe("context");
        });

        it("keeps a session under the limit, or one an approval holds", async () => {
          const provider = threadedProvider(4);
          provider["responses"][0] = fullResult(400);
          provider["responses"][1] = fullResult(900);
          const { handoffs, asked } = fakeHandoffs({ contextLimitTokens: 500 });
          const runner = renewingRunner(provider, undefined, { handoffs });
          const first = await turn(runner, { live: true });
          held.add(first!);
          expect(await turn(runner, { live: true })).toBe(first);
          expect(await turn(runner, { live: true })).toBe(first);
          expect(asked.tidying).toEqual([]);
          expect((await sessionRepository.current(key, "core:test-renewing"))?.id).toBe(first);
        });

        it("writes none for an agent whose policy does not ask for one", async () => {
          handoffAgent.definition = original;
          const provider = threadedProvider(2);
          const { handoffs, asked } = fakeHandoffs();
          const runner = renewingRunner(provider, undefined, { handoffs });
          await coldTurn(runner);
          identity.text = "**Agent Name:** YoYo";
          await coldTurn(runner);

          expect(provider.sessions.map((params) => params.thread.kind)).toEqual(["new", "new"]);
          expect(asked).toEqual({ tidying: [], fallback: 0, context: 0 });
          expect(provider.calls[1]?.prompt).not.toContain("<handoff>");
        });
      });

      it("starts a fresh session after an instruction change", async () => {
        const provider = new MockModelProvider(replies(2));
        const runner = renewingRunner(provider);
        const first = await turn(runner);
        const before = provider.sessions[0]?.config.systemPrompt;
        charter.text = "Be kind. Always answer in one line.";
        const second = await turn(runner);

        expect(second).not.toBe(first);
        expect(provider.sessions.at(-1)?.config.systemPrompt).not.toBe(before);
        expect(provider.sessions.at(-1)?.config.systemPrompt).toContain(
          "Always answer in one line.",
        );
      });

      it("resumes the session a wake names as it is, and the next cold open by the chat renews it", async () => {
        const provider = new MockModelProvider(replies(3));
        const runner = renewingRunner(provider);
        const first = await turn(runner);
        identity.text = "**Agent Name:** YoYo";
        const woken = await turn(runner, { sessionId: first });
        const next = await turn(runner);

        expect(woken).toBe(first);
        expect(next).not.toBe(first);
        expect((await sessionRepository.session(first!))?.supersededBy).toBe(next);
      });

      it("routes a wake-up for a session a renewal replaced to the chat's current session", async () => {
        const runner = renewingRunner(new MockModelProvider(replies(3)));
        const scheduledFrom = await turn(runner);
        identity.text = "**Agent Name:** YoYo";
        const current = await turn(runner);

        const woken = await turn(runner, { sessionId: scheduledFrom });

        expect(current).not.toBe(scheduledFrom);
        expect(woken).toBe(current);
        expect((await sessionRepository.session(scheduledFrom!))?.supersededBy).toBe(current);
      });

      it("delivers a defer's note to the session that set it", async () => {
        const provider = new MockModelProvider(replies(2));
        const runner = renewingRunner(provider);
        const deferredFrom = await turn(runner);
        const wake = await deferredWake(deferredFrom!, "webchat", "renewing-chat");

        await collectMessages(
          runner.run({
            agentName: "test-renewing",
            prompt: wake.prompt,
            sessionId: wake.sessionId,
          }),
        );

        expect(provider.calls[1]?.prompt).toContain("Read CI run 42 for PR #7");
        expect(provider.calls[1]?.prompt).toContain('turn_id="turn-that-deferred"');
        expect(provider.calls[1]?.prompt).not.toContain("<continuation>");
      });

      it("delivers a defer's note, and the continuation, to the session that replaced its own", async () => {
        const provider = new MockModelProvider(replies(3));
        const runner = renewingRunner(provider);
        const deferredFrom = await turn(runner);
        const wake = await deferredWake(deferredFrom!, "webchat", "renewing-chat");
        identity.text = "**Agent Name:** YoYo";
        const current = await turn(runner);

        const woken = await collectMessages(
          runner.run({
            agentName: "test-renewing",
            prompt: wake.prompt,
            sessionId: wake.sessionId,
          }),
        );

        const start = woken.find((message) => message.type === "turn_start");
        expect(start?.type === "turn_start" ? start.sessionId : undefined).toBe(current);
        expect(provider.calls[2]?.prompt).toContain("<continuation>");
        expect(provider.calls[2]?.prompt).toContain("Read CI run 42 for PR #7");
      });

      it("never renews a live session: it keeps its setup until its next cold open", async () => {
        const provider = new MockModelProvider(replies(3));
        const runner = renewingRunner(provider);
        const first = await turn(runner);
        identity.text = "**Agent Name:** YoYo";

        // Live, between turns: the session keeps running as it opened.
        const live = await turn(runner, { live: true });
        expect(live).toBe(first);
        expect(provider.sessions).toHaveLength(1);
        expect((await sessionRepository.session(first!))?.supersededBy).toBeFalsy();

        // Evicted, the next open is cold and renews.
        const cold = await turn(runner);
        expect(cold).not.toBe(first);
        expect(provider.sessions.at(-1)?.config.systemPrompt).toContain("YoYo");
      });

      it("a resume racing a cold renewal runs on the chat's current session", async () => {
        const provider = new MockModelProvider(replies(3));
        const open = provider.openSession.bind(provider);
        provider.openSession = async (params) => {
          const session = await open(params);
          const close = session.close.bind(session);
          // A slow provider close widens the window between the two.
          session.close = async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            await close();
          };
          return session;
        };
        const runner = renewingRunner(provider);
        const first = await turn(runner);
        identity.text = "**Agent Name:** YoYo";

        const [incoming, woken] = await Promise.all([
          turn(runner),
          turn(runner, { sessionId: first }),
        ]);

        const current = (await sessionRepository.current(key, "core:test-renewing"))?.id;
        expect(incoming).toBe(current);
        expect(woken).toBe(current);
      });

      describe("a session in use is never closed or replaced", () => {
        const errorsOf = (messages: AgentEvent[]) =>
          messages.filter((message) => message.type === "error");
        const run = async (runner: AgentRunner, params: { sessionId?: string } = {}) => {
          const messages = await collectMessages(
            runner.run({
              agentName: "test-renewing",
              prompt: "Hi",
              ...(params.sessionId ? { sessionId: params.sessionId } : { channelThreadKey: key }),
            }),
          );
          const start = messages.find((message) => message.type === "turn_start");
          return {
            sessionId: start?.type === "turn_start" ? start.sessionId : undefined,
            errors: errorsOf(messages),
          };
        };

        it("a wake and a send at once both run, without errors, on the chat's current session", async () => {
          const runner = renewingRunner(new MockModelProvider(replies(3)));
          const first = (await run(runner)).sessionId;
          const wake = run(runner, { sessionId: first });
          identity.text = "**Agent Name:** YoYo";
          const incoming = run(runner);

          const [woken, sent] = await Promise.all([wake, incoming]);
          expect([woken.errors, sent.errors]).toEqual([[], []]);
          const current = (await sessionRepository.current(key, "core:test-renewing"))?.id;
          expect(sent.sessionId).toBe(current);
        });

        it("an acquire abandoned before its submit lets the session go", async () => {
          const runner = renewingRunner(new MockModelProvider(replies(2)));
          const first = (await run(runner)).sessionId;
          // A run whose caller decides not to run, after acquiring.
          await collectMessages(
            runner.run({
              agentName: "test-renewing",
              prompt: "Skip",
              channelThreadKey: key,
              shouldRun: () => false,
            }),
          );
          // Nothing holds it: its idle eviction may close it, and the next
          // cold open renews it.
          const live = managerOf
            .get(runner)
            ?.find({ agentName: "test-renewing", channelThreadKey: key }) as
            | { isQuiescentForRotation: boolean }
            | undefined;
          await rs.waitFor(() => expect(live?.isQuiescentForRotation).toBe(true));
          identity.text = "**Agent Name:** YoYo";
          await evict(runner);

          expect((await run(runner)).sessionId).not.toBe(first);
        });
      });

      it("an approval hold blocks a cold renewal, and the next cold open once it clears renews", async () => {
        const runner = renewingRunner(new MockModelProvider(replies(3)));
        const first = await turn(runner);
        identity.text = "**Agent Name:** YoYo";
        held.add(first!);

        const whileHeld = await turn(runner);
        held.clear();
        const after = await turn(runner);

        expect(whileHeld).toBe(first);
        expect(after).not.toBe(first);
      });

      it("opens a renewed session on the model the tier maps to now, not the retired session's pin", async () => {
        const provider = new MockModelProvider(replies(3));
        const tier = { model: "tier-model-1" };
        // Exact requests (a pin) get their model; a tier request gets the
        // model the tier maps to at that moment.
        const modelResolver = {
          resolve: async (request: { kind: string; model?: string }) => ({
            modelProvider: provider,
            model: request.kind === "exact" ? request.model! : tier.model,
          }),
        } as unknown as ModelResolver;
        const runner = renewingRunner(provider, undefined, { modelResolver });
        const first = await turn(runner);
        tier.model = "tier-model-2";

        // Unchanged, a cold open resumes on the model its history was made with.
        expect(await turn(runner)).toBe(first);
        expect(provider.sessions.at(-1)?.config.model).toBe("tier-model-1");

        identity.text = "**Agent Name:** YoYo";
        const renewed = await turn(runner);
        expect(renewed).not.toBe(first);
        expect(provider.sessions.at(-1)?.config.model).toBe("tier-model-2");
      });

      describe("a resume judges each session on the row it read", () => {
        /** What a renewal elsewhere does to `id`'s row: supersede it with a successor. */
        async function renewElsewhere(id: string): Promise<string> {
          const row = (await sessionRepository.session(id))!;
          const successor = row.replace({
            setup: row.setup ?? undefined,
            reason: "setup",
            workingDir: row.workingDir ?? undefined,
          });
          await sessionRepository.replace(row, successor);
          return successor.id;
        }

        /** The repository, with a hook that runs right after a read returns. */
        function racing(after: {
          session?: (id: string, read: number) => Promise<void>;
          current?: (read: number) => Promise<void>;
        }) {
          let sessionReads = 0;
          let currentReads = 0;
          return new Proxy(sessionRepository, {
            get(target, property) {
              if (property === "session") {
                return async (id: string) => {
                  const row = await target.session(id);
                  await after.session?.(id, ++sessionReads);
                  return row;
                };
              }
              if (property === "current") {
                return async (...args: Parameters<SessionRepository["current"]>) => {
                  const row = await target.current(...args);
                  await after.current?.(++currentReads);
                  return row;
                };
              }
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }

        it("resumes an active session it read, though a renewal superseded it right after", async () => {
          const provider = new MockModelProvider(replies(2));
          const first = (await turn(renewingRunner(provider)))!;
          let successor: string | undefined;
          const runner = renewingRunner(provider, undefined, {
            // Each read of the named session after the first races a renewal once.
            sessionRepository: racing({
              session: async (id, read) => {
                if (id === first && read === 2 && !successor)
                  successor = await renewElsewhere(first);
              },
            }),
          });

          const woken = await turn(runner, { sessionId: first });

          expect(successor).toBeDefined();
          expect(woken).toBe(successor);
        });

        it("resumes the chat's current session it read, though a renewal superseded it right after", async () => {
          const provider = new MockModelProvider(replies(2));
          const first = (await turn(renewingRunner(provider)))!;
          const second = await renewElsewhere(first);
          let third: string | undefined;
          const runner = renewingRunner(provider, undefined, {
            sessionRepository: racing({
              current: async (read) => {
                if (read === 1) third = await renewElsewhere(second);
              },
            }),
          });

          const woken = await turn(runner, { sessionId: first });

          expect(third).toBeDefined();
          expect(woken).toBe(third);
        });
      });

      it("hands no turn a session whose cold open finished after a shutdown", async () => {
        const provider = new MockModelProvider(replies(1));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const open = provider.openSession.bind(provider);
        provider.openSession = async (params) => {
          await gate;
          return open(params);
        };
        const runner = renewingRunner(provider);
        const running = collectMessages(
          runner.run({ agentName: "test-renewing", prompt: "Hi", channelThreadKey: key }),
        );
        // The cold open is waiting on the provider when the shutdown runs.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await managers.at(-1)!.shutdown();
        release();

        await expect(running).rejects.toThrow("shut down");
        expect(provider.calls).toEqual([]);
      });

      it("renews a session that opened before setups were recorded", async () => {
        const legacy = Session.create("core:test-renewing", { continuityKey: key });
        await sessionRepository.add(legacy);
        const runner = renewingRunner(new MockModelProvider(replies(1)));

        const renewed = await turn(runner);

        expect(renewed).not.toBe(legacy.id);
        expect((await sessionRepository.session(legacy.id))?.status).toBe("completed");
      });
    });

    it("resumes a session replaced 34 times in a row as its chat's current session", async () => {
      const first = Session.create("core:test-main", { continuityKey: "webchat:long-chain" });
      await sessionRepository.add(first);
      let latest = first;
      for (let i = 0; i < 34; i++) {
        const next = latest.replace({ reason: "setup" });
        await sessionRepository.replace(latest, next);
        latest = next;
      }
      const runner = createRunner(new MockModelProvider([[{ type: "result", content: "ok" }]]));

      const woken = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Wake", sessionId: first.id }),
      );

      const start = woken.find((message) => message.type === "turn_start");
      expect(start?.type === "turn_start" ? start.sessionId : undefined).toBe(latest.id);
    });

    it("delivers a defer's note when a common chat on the main agent wakes", async () => {
      const provider = new MockModelProvider([
        [{ type: "result", content: "Watching" }],
        [{ type: "result", content: "Checked" }],
      ]);
      const runner = createRunner(provider);
      const first = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Watch CI",
          channelThreadKey: "webchat:common-1",
        }),
      );
      const start = first.find((message) => message.type === "turn_start");
      const deferredFrom = start?.type === "turn_start" ? start.sessionId : "";
      const wake = await deferredWake(deferredFrom, "webchat", "common-1");

      await collectMessages(
        runner.run({ agentName: "test-main", prompt: wake.prompt, sessionId: wake.sessionId }),
      );

      expect(provider.calls.at(-1)?.prompt).toContain("Read CI run 42 for PR #7");
      expect(provider.calls.at(-1)?.prompt).not.toContain("<continuation>");
    });

    it("routes a main-agent defer past an idle reset of its chat, with the note and the continuation", async () => {
      const seeded = Session.create("core:test-main", { continuityKey: "telegram:thread-defer" });
      await sessionRepository.add(seeded);
      const wake = await deferredWake(seeded.id, "telegram", "thread-defer");
      await testDb.db
        .update(sessions)
        .set({ lastActiveAt: new Date("2026-07-01T00:00:00Z") })
        .where(eq(sessions.id, seeded.id));
      const provider = new MockModelProvider([
        [{ type: "result", content: "Fresh" }],
        [{ type: "result", content: "Checked" }],
      ]);
      const runner = createRunner(provider, undefined, {
        resetPolicy: { mode: "idle", idleMinutes: 10_080 },
      });
      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Hello again",
          channelThreadKey: "telegram:thread-defer",
          romeSessionId: "channel:telegram:thread-defer",
          platformMessageId: "message-defer",
          threadContext: {
            channel: "telegram",
            connectionId: "telegram-1",
            threadId: "thread-defer",
          },
        }),
      );
      const current = await sessionRepository.current("telegram:thread-defer", "core:test-main");

      const woken = await collectMessages(
        runner.run({ agentName: "test-main", prompt: wake.prompt, sessionId: wake.sessionId }),
      );

      expect(current?.id).not.toBe(seeded.id);
      const start = woken.find((message) => message.type === "turn_start");
      expect(start?.type === "turn_start" ? start.sessionId : undefined).toBe(current?.id);
      expect(provider.calls.at(-1)?.prompt).toContain("Read CI run 42 for PR #7");
      expect(provider.calls.at(-1)?.prompt).toContain("<continuation>");
    });

    it("resumes a keyless run by explicit sessionId", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "First" },
          { type: "result", content: "First" },
        ],
        [
          { type: "text", content: "Second" },
          { type: "result", content: "Second" },
        ],
      ]);
      const runner = createRunner(provider);

      const first = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Start ad-hoc session",
        }),
      );
      const firstSession = first.find((m) => m.type === "session_init") as {
        type: "session_init";
        sessionId: string;
      };

      const second = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Follow up",
          sessionId: firstSession.sessionId,
        }),
      );
      const secondSession = second.find((m) => m.type === "session_init") as {
        type: "session_init";
        sessionId: string;
      };

      expect(secondSession.sessionId).toBe(firstSession.sessionId);
      expect(provider.calls[1]).toMatchObject({ prompt: "Follow up" });
    });

    it("reopens the exact requested session instead of reusing a different cached session", async () => {
      const provider = new MockModelProvider();
      const modelResolver = createTestModelResolver({
        providers: [provider],
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const key = { agentName: "test-main", channelThreadKey: "telegram:t-1" };
      const cached = await manager.open(key);
      // Its caller lets it go without a turn, so another session may replace it.
      cached.release();
      // A second active row for the same key and agent, as rows written before
      // the one-active-session rule could be. The repository refuses to add one.
      const now = new Date();
      await testDb.db.insert(sessions).values({
        id: "sess-old",
        agentName: "core:test-main",
        channelThreadKey: "telegram:t-1",
        status: "active",
        createdAt: now,
        lastActiveAt: now,
      });

      expect(cached.sessionId).not.toBe("sess-old");
      expect(provider.sessions).toHaveLength(1);

      const resumed = await manager.resume({ id: "sess-old", agent: "test-main" });

      expect(resumed.sessionId).toBe("sess-old");
      expect(resumed).not.toBe(cached);
      expect(provider.sessions).toHaveLength(2);
      // The row has no stored provider identity, so its native thread is not
      // resumed into whichever provider happens to resolve now (#1045).
      expect(provider.sessions[1].thread).toEqual({ kind: "new" });

      await manager.shutdown();
    });
  });

  describe("message yielding", () => {
    it("yields session_init after turn_start, before any content", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );

      // turn_start opens the stream so consumers reset turn-scoped state
      // before anything of the new turn (including session_init) is visible.
      expect(messages[0].type).toBe("turn_start");
      expect(messages[1]).toMatchObject({
        type: "session_init",
        systemPrompt: expect.stringContaining("You are a test main agent."),
        userPrompt: "Hello",
      });
    });

    it("brackets every turn stream with turn_start and turn_end", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Working" },
          { type: "result", content: "Done" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );

      const starts = messages.filter((m) => m.type === "turn_start");
      const ends = messages.filter((m) => m.type === "turn_end");
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        type: "turn_start",
        turnId: expect.any(String),
        sessionId: expect.any(String),
        userPrompt: "Hello",
      });
      // turn_start is the first event of the stream; turn_end is the last.
      expect(messages[0].type).toBe("turn_start");
      expect(messages[messages.length - 1]).toMatchObject({
        type: "turn_end",
        turnId: (starts[0] as { turnId: string }).turnId,
        status: "completed",
        durationMs: expect.any(Number),
      });
    });

    it("persists the provider checkpoint for a completed Rome turn", async () => {
      const provider = new MockModelProvider();
      provider.openSession = rs.fn(async (params) => ({
        ...createSessionFromRun(
          "mock",
          async function* () {
            yield {
              type: "result",
              content: "Done",
              position: {
                provider: "mock",
                modelThreadId: "model-thread",
                checkpointId: "provider-turn-2",
              },
            };
          },
          params,
        ),
        modelThreadId: "model-thread",
      }));
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      expect(
        await sessionRepository.deprecatedCheckpoint(start.sessionId, start.turnId),
      ).toMatchObject({
        sessionId: start.sessionId,
        turnId: start.turnId,
        provider: "mock",
        modelThreadId: "model-thread",
        checkpointId: "provider-turn-2",
      });
    });

    it("does not persist a provider checkpoint for an interrupted turn", async () => {
      const provider: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set(),
        async openSession(params) {
          const session = createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "text", content: "partial output" };
              yield {
                type: "result",
                content: "partial output",
                accounting: {
                  provider: "anthropic",
                  model: params.config.model,
                  usage: {
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                  },
                  stopReason: "interrupted",
                },
                position: {
                  provider: "anthropic",
                  modelThreadId: "claude-thread",
                  checkpointId: "streamed-but-not-resumable-assistant-uuid",
                },
              };
            },
            params,
          );
          return { ...session, modelThreadId: "claude-thread" };
        },
      };
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      expect(
        await sessionRepository.deprecatedCheckpoint(start.sessionId, start.turnId),
      ).toBeNull();
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "interrupted" });
    });

    it("treats a provider-reported interrupt as interrupted and skips its checkpoint", async () => {
      // What CodexAppServerProvider emits when codex reports
      // `turn/completed { status: "interrupted" }` and Rome did not interrupt:
      // a result whose accounting stop is `interrupted` (the deprecated string
      // still says `end_turn`), with a checkpoint for that turn available.
      const lifecycle = createLifecycleRecorder();
      const provider: ModelProvider = {
        id: "openai",
        builtinTools: new Set(),
        async openSession(params) {
          const session = createSessionFromRun(
            "openai",
            async function* () {
              yield {
                type: "result",
                content: "partial answer",
                accounting: {
                  provider: "openai",
                  model: params.config.model,
                  usage: {
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                  },
                  stop: { reason: "interrupted", raw: "interrupted" },
                  stopReason: "end_turn",
                },
                position: {
                  provider: "openai",
                  modelThreadId: "codex-thread",
                  checkpointId: "codex-turn-1",
                },
              };
            },
            params,
          );
          return { ...session, modelThreadId: "codex-thread" };
        },
      };
      const runner = createRunner(provider, lifecycle);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "interrupted" });
      expect(
        await sessionRepository.deprecatedCheckpoint(start.sessionId, start.turnId),
      ).toBeNull();
      expect(lifecycle.finishedEvents[0]).toMatchObject({
        status: "interrupted",
        output: { state: "partial", stop: { reason: "interrupted", raw: "interrupted" } },
      });
    });

    it("persists the session model pin for a completed Rome turn", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      const row = await sessionRepository.session(start.sessionId);
      expect(row).toMatchObject({
        provider: "mock",
        // The concrete model that actually ran, not the tier name.
        model: "claude-opus-5-5[1m]",
      });
    });

    it("records the effort each successful turn ran with", async () => {
      const provider = new MockModelProvider([
        [{ type: "result", content: "One" }],
        [{ type: "result", content: "Two" }],
        [{ type: "result", content: "Three" }],
      ]);
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:effort-record",
      });

      // No per-turn effort falls back to the agent's configured effort.
      await collectMessages((await startAfter(session, { prompt: "One" })).events());
      expect((await sessionRepository.session(session.sessionId))?.reasoningEffort).toBe("high");

      await collectMessages(
        (await startAfter(session, { prompt: "Two", reasoningEffort: "xhigh" })).events(),
      );
      expect((await sessionRepository.session(session.sessionId))?.reasoningEffort).toBe("xhigh");

      await collectMessages(
        (await startAfter(session, { prompt: "Three", reasoningEffort: "low" })).events(),
      );
      expect(
        await sessionRepository.current("webchat:effort-record", "core:test-main"),
      ).toMatchObject({
        model: "claude-opus-5-5[1m]",
        reasoningEffort: "low",
      });
      await manager.shutdown();
    });

    it("records the effort the turn ran at, and keeps the provider's facts off what it publishes", async () => {
      // Claude runs a warm session at its open-time effort and calls it `max`.
      const provider = new MockModelProvider();
      provider.openSession = async (params) =>
        createSessionFromRun(
          "mock",
          async function* () {
            yield { type: "model_turn_started", modelTurnId: "provider-turn-1" };
            yield {
              type: "result",
              content: "Done",
              reasoningEffort: "max",
              position: { provider: "mock", modelThreadId: "t", checkpointId: "c" },
            };
          },
          params,
        );
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:effort-fixed",
      });

      const messages = await collectMessages(
        (await startAfter(session, { prompt: "Go", reasoningEffort: "xhigh" })).events(),
      );

      const row = await sessionRepository.session(session.sessionId);
      expect(row?.reasoningEffort).toBe("max");
      const result = messages.find((m) => m.type === "result");
      expect(messages.map((m) => m.type)).not.toContain("model_turn_started");
      expect(result).not.toHaveProperty("reasoningEffort");
      expect(result).not.toHaveProperty("position");
      await manager.shutdown();
    });

    it("keeps the model pin NULL for a session whose turns never succeed", async () => {
      const failingProvider: MockModelProvider = new MockModelProvider();
      failingProvider.run = async function* () {
        throw new Error("Model API failure");
      };
      const runner = createRunner(failingProvider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Fail" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      const row = await sessionRepository.session(start.sessionId);
      expect(row).toMatchObject({ provider: null, model: null, reasoningEffort: null });
    });

    it("ends a user-stopped turn with turn_end status=interrupted", async () => {
      // What AnthropicProvider yields when the user clicks Stop: the aborted
      // request still terminates with a result block whose accounting carries
      // `stopReason: "interrupted"`. The bracket must surface that as its own
      // status so consumers can tell a graceful stop from a true success.
      const provider = new MockModelProvider([
        [
          { type: "text", content: "partial output" },
          {
            type: "result",
            content: "",
            accounting: {
              provider: "mock",
              model: "mock-model",
              usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
              stopReason: "interrupted",
            },
          },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );

      expect(messages[messages.length - 1]).toMatchObject({
        type: "turn_end",
        status: "interrupted",
      });
    });

    it("yields the model failure as one error, then ends the turn with status=error", async () => {
      const failingProvider: MockModelProvider = new MockModelProvider();
      failingProvider.run = async function* () {
        throw new Error("Model API failure");
      };
      const runner = createRunner(failingProvider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Fail" }),
      );

      const errorMessages = messages.filter((m) => m.type === "error");
      expect(errorMessages).toHaveLength(1);
      expect((errorMessages[0] as { type: "error"; error: string }).error).toContain(
        "Model API failure",
      );
      expect(messages[messages.length - 1]).toMatchObject({
        type: "turn_end",
        status: "error",
      });
    });

    describe("turn span finalization", () => {
      let harness: SpanHarness;

      beforeEach(() => {
        harness = installTestSpanHarness();
      });

      afterEach(async () => {
        await harness.shutdown();
      });

      it("a turn that fails before reaching the events loop closes its spans with ERROR", async () => {
        // Synthetic-error exits (failTurn) must finalize spans the same way
        // provider terminals do; without it, runOneTurn's safety net closes
        // the agent span as OK on a turn that the consumer saw fail.
        const failingProvider: MockModelProvider = new MockModelProvider();
        failingProvider.run = async function* () {
          throw new Error("Model API failure");
        };
        const runner = createRunner(failingProvider);

        await collectMessages(runner.run({ agentName: "test-main", prompt: "Fail" }));

        const spans = await harness.finishedSpans();
        const agentSpan = spans.find((s) => s.name === "agent:core:test-main");
        const modelSpan = spans.find((s) => s.name === "model.turn");
        expect(agentSpan?.status.code).toBe(SpanStatusCode.ERROR);
        expect(modelSpan?.status.code).toBe(SpanStatusCode.ERROR);
      });

      it("a completed turn closes its spans with OK", async () => {
        const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
        const runner = createRunner(provider);

        await collectMessages(runner.run({ agentName: "test-main", prompt: "Hello" }));

        const spans = await harness.finishedSpans();
        const agentSpan = spans.find((s) => s.name === "agent:core:test-main");
        const modelSpan = spans.find((s) => s.name === "model.turn");
        expect(agentSpan?.status.code).toBe(SpanStatusCode.OK);
        expect(modelSpan?.status.code).toBe(SpanStatusCode.OK);
      });
    });

    it("yields text messages from model", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Hello there" },
          { type: "result", content: "Hello there" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(runner.run({ agentName: "test-main", prompt: "Hi" }));

      const textMessages = messages.filter((m) => m.type === "text");
      expect(textMessages).toHaveLength(1);
      expect((textMessages[0] as { type: "text"; content: string }).content).toBe("Hello there");
    });

    it("yields tool_use and tool_result messages", async () => {
      // Register a custom action
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: {},
        execute: async () => ({ status: "ok" }),
      });

      const provider = new MockModelProvider([
        [
          {
            type: "tool_use",
            id: "tu-standup-1",
            tool: "demo_action",
            input: { name: "standup" },
          },
          {
            type: "tool_result",
            toolUseId: "tu-standup-1",
            tool: "demo_action",
            output: { success: true },
          },
          { type: "result", content: "Scheduled" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Schedule standup" }),
      );

      const toolUse = messages.filter((m) => m.type === "tool_use");
      expect(toolUse).toHaveLength(1);

      const toolResult = messages.filter((m) => m.type === "tool_result");
      expect(toolResult).toHaveLength(1);
    });

    it("yields result message at end", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Final answer" }]]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Question" }),
      );

      const resultMessages = messages.filter((m) => m.type === "result");
      expect(resultMessages).toHaveLength(1);
      expect((resultMessages[0] as { type: "result"; content: string }).content).toBe(
        "Final answer",
      );
    });
  });

  describe("agent lifecycle", () => {
    it("dispatches turn start and finish events with thread context and final output", async () => {
      const lifecycle = createLifecycleRecorder();
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Working" },
          {
            type: "result",
            content: "Final answer",
            accounting: {
              provider: "mock",
              model: "mock-large",
              usage: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 10,
                outputTokens: 3,
              },
            },
          },
        ],
      ]);
      const runner = createRunner(provider, lifecycle);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Hello lifecycle",
          channelThreadKey: "webchat:session-1",
          threadContext: {
            channel: "webchat",
            threadId: "session-1",
            threadName: "Lifecycle",
            threadType: "private",
            projectName: "alpha",
            projectPath: "alpha/path",
          },
        }),
      );

      expect(lifecycle.startedEvents).toHaveLength(1);
      expect(lifecycle.startedEvents[0]).toMatchObject({
        type: "agent-turn-started",
        version: 1,
        turn: {
          sessionId: expect.any(String),
          turnId: expect.any(String),
          agentName: "core:test-main",
          channelThreadKey: "webchat:session-1",
          threadContext: {
            channel: "webchat",
            threadId: "session-1",
            threadName: "Lifecycle",
            threadType: "private",
            projectName: "alpha",
            projectPath: "alpha/path",
          },
        },
        input: { promptLength: "Hello lifecycle".length },
      });
      expect(lifecycle.startedEvents[0].input).not.toHaveProperty("prompt");

      expect(lifecycle.finishedEvents).toHaveLength(1);
      expect(lifecycle.finishedEvents[0]).toMatchObject({
        type: "agent-turn-finished",
        version: 1,
        turn: {
          sessionId: lifecycle.startedEvents[0].turn.sessionId,
          turnId: lifecycle.startedEvents[0].turn.turnId,
          agentName: "core:test-main",
          channelThreadKey: "webchat:session-1",
        },
        status: "completed",
        output: {
          text: "Final answer",
          state: "final",
          terminalKind: "result",
          accounting: expect.objectContaining({ provider: "mock", model: "mock-large" }),
        },
        metrics: {
          toolCallCount: 0,
          skillWritten: false,
        },
      });
      expect(lifecycle.finishedEvents[0].timing.startedAt).toBe(
        lifecycle.startedEvents[0].timing.startedAt,
      );
      expect(lifecycle.finishedEvents[0].timing.finishedAt).toEqual(expect.any(String));
      expect(lifecycle.finishedEvents[0].timing.durationMs).toEqual(expect.any(Number));
    });

    it("uses turn-scoped context when a session is reused", async () => {
      const lifecycle = createLifecycleRecorder();
      const observedContexts: Array<{
        channelUserId?: string;
        sharedRunId?: unknown;
      }> = [];
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Record context",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "read-only",
        },
        inputSchema: {},
        execute: async () => {
          const store = actionExecutionContext.getStore();
          observedContexts.push({
            channelUserId: store?.channelContext?.channelUserId,
            sharedRunId: store?.sharedContext?.run_id,
          });
          return { status: "ok" };
        },
      });

      const runImpl = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentEvent> {
        yield {
          type: "tool_use",
          id: `tu-${params.prompt}`,
          tool: "demo_action",
          input: {},
        };
        await executeActionTool(params.tools, "demo_action", {});
        yield {
          type: "tool_result",
          toolUseId: `tu-${params.prompt}`,
          tool: "demo_action",
          output: { ok: true },
        };
        yield { type: "result", content: `done ${params.prompt}` };
      };
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImpl),
      };
      const runner = createRunner(provider, lifecycle, { keepAliveAcrossTurns: true });

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "first",
          channelThreadKey: "webchat:reused-context",
          threadContext: {
            channel: "webchat",
            threadId: "reused-context",
            channelUserId: "guardian-one",
          },
          sharedContext: { run_id: "run-one" },
        }),
      );
      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "second",
          channelThreadKey: "webchat:reused-context",
          threadContext: {
            channel: "webchat",
            threadId: "reused-context",
            channelUserId: "guardian-two",
          },
          sharedContext: { run_id: "run-two" },
        }),
      );

      expect(
        lifecycle.startedEvents.map((event) => event.turn.threadContext?.channelUserId),
      ).toEqual(["guardian-one", "guardian-two"]);
      expect(
        lifecycle.finishedEvents.map((event) => event.turn.threadContext?.channelUserId),
      ).toEqual(["guardian-one", "guardian-two"]);
      expect(observedContexts).toEqual([
        { channelUserId: "guardian-one", sharedRunId: "run-one" },
        { channelUserId: "guardian-two", sharedRunId: "run-two" },
      ]);
    });

    it("opens a continuity key by its key even when it carries an id", async () => {
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: async (params) => createClosableModelSession(params),
      };
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true },
      );
      const continuityKey = { agentName: "test-main", channelThreadKey: "webchat:extra-id" };
      const opened = await manager.open(continuityKey);
      const withId = { ...continuityKey, id: "some-other-session" };
      expect(await manager.open(withId)).toBe(opened);
      await manager.shutdown();
    });

    it("does not dispatch finished lifecycle events for turns that never started", async () => {
      const lifecycle = createLifecycleRecorder();
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: async (params) => createClosableModelSession(params),
      };
      const modelResolver = createTestModelResolver({
        providers: [provider],
      });
      const manager = createSessions(managerDeps(modelResolver, lifecycle), {
        keepAliveAcrossTurns: true,
      });

      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:closed-before-start",
      });
      const first = await startAfter(session, { prompt: "first" });
      const second = await startAfter(session, { prompt: "second" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(lifecycle.startedEvents).toHaveLength(1);
      expect(lifecycle.startedEvents[0].turn.turnId).toBe(first.id);

      await session.close("user");
      await collectMessages(first.events());
      const secondMessages = await collectMessages(second.events());

      expect(secondMessages).toEqual([
        expect.objectContaining({ type: "turn_start", turnId: second.id }),
        expect.objectContaining({ type: "error", error: "AgentSession closed" }),
        expect.objectContaining({ type: "turn_end", turnId: second.id, status: "error" }),
      ]);
      expect(lifecycle.startedEvents).toHaveLength(1);
      expect(lifecycle.finishedEvents).toHaveLength(1);
      expect(lifecycle.finishedEvents[0].turn.turnId).toBe(first.id);
      await manager.shutdown();
    });

    it("dispatches subagent lifecycle events with a turn-scoped parent ref", async () => {
      const lifecycle = createLifecycleRecorder();
      const nestedCalls: import("./agent-runner.js").ModelRunParams[] = [];
      const runImplNested = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentEvent> {
        nestedCalls.push(params);

        if (nestedCalls.length === 1 || nestedCalls.length === 3) {
          const id = `tu-explore-${nestedCalls.length}`;
          yield {
            type: "tool_use",
            id,
            tool: EXPLORE_TOOL,
            input: { prompt: `Inspect ${nestedCalls.length}` },
          };
          const output = await executeSubagentTool(
            params.tools,
            EXPLORE_TOOL,
            { prompt: `Inspect ${nestedCalls.length}` },
            { toolUseId: id },
          );
          yield { type: "tool_result", toolUseId: id, tool: EXPLORE_TOOL, output };
          yield { type: "result", content: `Delegated ${nestedCalls.length}` };
          return;
        }

        yield {
          type: "tool_use",
          id: `tu-edit-${nestedCalls.length}`,
          tool: "Edit",
          input: { file_path: "/tmp/agent-runner-test/skills/review.md" },
        };
        yield { type: "result", content: `Explore complete ${nestedCalls.length}` };
      };
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImplNested),
      };
      const runner = createRunner(provider, lifecycle, { keepAliveAcrossTurns: true });
      await new ChatsWebChatRepository(testDb.db).createSession("session-subagents", "Chat");

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Delegate one",
          channelThreadKey: "webchat:session-subagents",
          threadContext: {
            channel: "webchat",
            threadId: "session-subagents",
            channelUserId: "guardian-one",
          },
        }),
      );
      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Delegate two",
          channelThreadKey: "webchat:session-subagents",
          threadContext: {
            channel: "webchat",
            threadId: "session-subagents",
            channelUserId: "guardian-two",
          },
        }),
      );

      const rootFinished = lifecycle.finishedEvents.filter(
        (e) => e.turn.agentName === "core:test-main",
      );
      const childFinished = lifecycle.finishedEvents.filter(
        (e) => e.turn.agentName === "core:test-explore",
      );

      expect(nestedCalls[0].systemPrompt).toContain("```mermaid");
      expect(nestedCalls[1].systemPrompt).not.toContain("```mermaid");
      expect(nestedCalls[3].systemPrompt).not.toContain("Mermaid fenced code blocks");
      expect(rootFinished).toHaveLength(2);
      expect(childFinished).toHaveLength(2);
      expect(childFinished[0].turn.parent).toEqual({
        sessionId: rootFinished[0].turn.sessionId,
        turnId: rootFinished[0].turn.turnId,
        agentName: "core:test-main",
      });
      expect(childFinished[1].turn.parent).toEqual({
        sessionId: rootFinished[1].turn.sessionId,
        turnId: rootFinished[1].turn.turnId,
        agentName: "core:test-main",
      });
      expect(childFinished[0].turn.parent?.turnId).not.toBe(childFinished[1].turn.parent?.turnId);
      expect(childFinished.map((e) => e.turn.threadContext?.channelUserId)).toEqual([
        "guardian-one",
        "guardian-two",
      ]);
      expect(rootFinished[0].metrics).toEqual({ toolCallCount: 1, skillWritten: false });
      expect(rootFinished[1].metrics).toEqual({ toolCallCount: 1, skillWritten: false });
      expect(childFinished[0].metrics).toEqual({ toolCallCount: 1, skillWritten: true });
      expect(childFinished[1].metrics).toEqual({ toolCallCount: 1, skillWritten: true });
    });

    it.each([
      ["anthropic", "Repeated 529 Overloaded errors", undefined, 529, "overloaded"],
      [
        "openai",
        "exceeded retry limit, last status: 429 Too Many Requests",
        "transient",
        429,
        undefined,
      ],
    ] as const)("carries %s failure details without replacing the output error", async (id, message, code, httpStatus, providerError) => {
      const lifecycle = createLifecycleRecorder();
      const provider: ModelProvider = {
        id,
        builtinTools: new Set(),
        openSession: makeOpenSessionFromRun(id, async function* () {
          yield { type: "error", error: message, code, httpStatus, providerError };
        }),
      };
      await collectMessages(
        createRunner(provider, lifecycle).run({ agentName: "test-main", prompt: "Continue" }),
      );
      expect(lifecycle.finishedEvents[0].output).toMatchObject({
        error: message,
        failure: {
          message,
          provider: id,
          ...(code ? { code } : {}),
          httpStatus,
          ...(providerError ? { providerError } : {}),
        },
      });
    });

    it("omits failure information on a successful turn", async () => {
      const lifecycle = createLifecycleRecorder();
      await collectMessages(
        createRunner(new MockModelProvider([[{ type: "result", content: "done" }]]), lifecycle).run(
          { agentName: "test-main", prompt: "Continue" },
        ),
      );
      expect(lifecycle.finishedEvents[0].output).not.toHaveProperty("failure");
    });

    it("classifies provider-interrupted terminal results separately from completions", async () => {
      const lifecycle = createLifecycleRecorder();
      const provider = new MockModelProvider([
        [
          {
            type: "result",
            content: "Partial answer",
            accounting: {
              provider: "mock",
              model: "mock-large",
              usage: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 4,
                outputTokens: 2,
              },
              stopReason: "interrupted",
            },
          },
        ],
      ]);
      const runner = createRunner(provider, lifecycle);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Stop soon" }));

      expect(lifecycle.finishedEvents).toHaveLength(1);
      expect(lifecycle.finishedEvents[0]).toMatchObject({
        status: "interrupted",
        output: {
          text: "Partial answer",
          state: "partial",
          terminalKind: "result",
          stop: { reason: "interrupted", raw: "interrupted" },
          stopReason: "interrupted",
        },
      });
    });

    it("reports the unified stop reason on a turn that ended at the output limit", async () => {
      const lifecycle = createLifecycleRecorder();
      const provider = new MockModelProvider([
        [
          {
            type: "result",
            content: "Cut off",
            accounting: {
              provider: "mock",
              model: "mock-large",
              usage: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 4,
                outputTokens: 2,
                reasoningTokens: 1,
              },
              stop: { reason: "max_tokens", raw: "max_tokens" },
              stopReason: "max_tokens",
            },
          },
        ],
      ]);
      const runner = createRunner(provider, lifecycle);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Go long" }));

      expect(lifecycle.finishedEvents[0]).toMatchObject({
        status: "completed",
        output: {
          state: "final",
          stop: { reason: "max_tokens", raw: "max_tokens" },
          stopReason: "max_tokens",
          accounting: { usage: { reasoningTokens: 1 } },
        },
      });
    });
    it("keeps the turn stop consistent with a completed status when the run reported an error", async () => {
      // A provider may end a turn with a `result` terminal whose accounting
      // says `error`. The turn completes, so its stop must not say `error`.
      const lifecycle = createLifecycleRecorder();
      const provider = new MockModelProvider([
        [
          {
            type: "result",
            content: "API Error: overloaded",
            accounting: {
              provider: "mock",
              model: "mock-large",
              usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 1, outputTokens: 1 },
              stop: { reason: "error", raw: "api_error" },
            },
          },
        ],
      ]);
      const runner = createRunner(provider, lifecycle);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Hi" }));

      expect(lifecycle.finishedEvents[0]).toMatchObject({
        status: "completed",
        output: {
          state: "final",
          stop: { reason: "other", raw: "api_error" },
          accounting: { stop: { reason: "error", raw: "api_error" } },
        },
      });
    });
  });

  describe("shared context propagation", () => {
    it("passes sharedContext into action executions triggered by the agent", async () => {
      let observedSharedContext: Record<string, unknown> | undefined;
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          visibility: "explicit",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: {},
        execute: async () => {
          observedSharedContext = actionExecutionContext.getStore()?.sharedContext;
          return { status: "ok", data: "ok" };
        },
      });

      const runImpl = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentEvent> {
        yield {
          type: "tool_use",
          id: "tu-shared-1",
          tool: "demo_action",
          input: { name: "standup" },
        };
        await executeActionTool(params.tools, "demo_action", { name: "standup" });
        yield {
          type: "tool_result",
          toolUseId: "tu-shared-1",
          tool: "demo_action",
          output: { success: true },
        };
        yield { type: "result", content: "Scheduled" };
      };
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImpl),
      };
      const runner = createRunner(provider);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Schedule standup",
          sharedContext: {
            company_id: "company-1",
            run_id: "run-1",
          },
        }),
      );

      expect(observedSharedContext).toEqual({
        company_id: "company-1",
        run_id: "run-1",
      });
    });
  });

  describe("prompt building", () => {
    it("calls systemPrompts.build() with correct config and contextSuffix", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
      const runner = createRunner(provider);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Build prompt",
          contextSuffix: "Extra context",
        }),
      );

      expect(provider.calls).toHaveLength(1);
      const call = provider.calls[0];
      expect(call.systemPrompt).toContain("You are a test main agent.");
      expect(call.systemPrompt).toContain("Extra context");
    });

    it("attributes app-store agents by listing id and omits local app attribution", async () => {
      const find = agentLoader.find.bind(agentLoader);
      const recordSpy = rs.spyOn(agentLoader, "find").mockImplementation((name) => {
        const agent = find(name);
        if (agent?.localName !== "test-main") return agent;
        return { ...agent, ownerType: "app", ownerId: "test-app" };
      });

      try {
        const built = { type: "result", content: "Built", accounting: MOCK_ACCOUNTING } as const;
        const provider = new MockModelProvider([[built]]);
        const appCatalog = {
          get: rs.fn((appId: string) =>
            appId === "test-app"
              ? {
                  source: {
                    mode: "appstore",
                    listingId: "@publisher/test-app",
                    version: "1.0.0",
                  },
                }
              : null,
          ),
        } as unknown as Pick<AppCatalog, "get">;
        const runner = createRunner(provider, undefined, { appCatalog });

        await collectMessages(
          runner.run({
            agentName: "test-main",
            prompt: "Build prompt",
            contextSuffix: "App-supplied session context.",
            channelThreadKey: "webchat:app-prompt",
          }),
        );

        expect(provider.calls[0].systemPrompt).toBe(
          "You are a test main agent. Handle messages and delegate as needed.\n\n" +
            "App-supplied session context.",
        );
        expect(recordMetrics).toHaveBeenLastCalledWith(MOCK_ACCOUNTING, {
          agentName: "core:test-main",
          appStoreListingId: "@publisher/test-app",
        });

        const localProvider = new MockModelProvider([[built]]);
        const localAppCatalog = {
          get: rs.fn(() => ({
            source: {
              mode: "bundle",
              path: "/tmp/test-app",
            },
          })),
        } as unknown as Pick<AppCatalog, "get">;
        const localRunner = createRunner(localProvider, undefined, {
          appCatalog: localAppCatalog,
        });

        await collectMessages(
          localRunner.run({
            agentName: "test-main",
            prompt: "Build local prompt",
            channelThreadKey: "webchat:local-app-prompt",
          }),
        );

        expect(recordMetrics).toHaveBeenLastCalledWith(MOCK_ACCOUNTING, {
          agentName: "core:test-main",
          appStoreListingId: undefined,
        });
      } finally {
        recordSpy.mockRestore();
      }
    });

    it("adds Mermaid guidance only for webchat interactive surfaces", async () => {
      const webchatProvider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
      const webchatRunner = createRunner(webchatProvider);
      await collectMessages(
        webchatRunner.run({
          agentName: "test-main",
          prompt: "Build prompt",
          channelThreadKey: "webchat:prompt-surface",
          threadContext: { channel: "webchat", threadId: "prompt-surface" },
        }),
      );

      const telegramProvider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
      const telegramRunner = createRunner(telegramProvider);
      await collectMessages(
        telegramRunner.run({
          agentName: "test-main",
          prompt: "Build prompt",
          channelThreadKey: "telegram:prompt-surface",
          threadContext: { channel: "telegram", threadId: "prompt-surface" },
        }),
      );

      expect(webchatProvider.calls[0].systemPrompt).toContain("```mermaid");
      expect(webchatProvider.calls[0].systemPrompt).toContain("interactive SVG diagrams");
      expect(telegramProvider.calls[0].systemPrompt).not.toContain("```mermaid");
      expect(telegramProvider.calls[0].systemPrompt).not.toContain("Mermaid fenced code blocks");
    });

    it("defaults the model provider working directory to the default project folder", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
      const runner = createRunner(provider);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Build prompt",
        }),
      );

      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].workingDir).toBe("/tmp/default-project");
    });
  });

  describe("thread-context first-user-prompt block", () => {
    const webchatThreadContext = {
      channel: "webchat",
      threadId: "tc-session-1",
      channelUserId: "guardian",
      threadType: "private" as const,
      projectName: "alpha",
    };
    const projectWorkingDir = "/tmp/agent-runner-test/projects/alpha";

    /** Provider that yields a single result per turn, for any number of turns. */
    function alwaysResultProvider(): ModelProvider {
      return {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* () {
          yield { type: "result", content: "ok" };
        }),
      };
    }

    function initUserPrompt(messages: AgentEvent[]): string {
      const init = messages.find((m) => m.type === "session_init") as {
        type: "session_init";
        userPrompt?: string;
      };
      return init?.userPrompt ?? "";
    }

    it("prepends <thread_context> to the first user turn of a fresh session", async () => {
      const runner = createRunner(alwaysResultProvider());

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Hello",
          channelThreadKey: "webchat:tc-fresh",
          threadContext: webchatThreadContext,
          workingDir: projectWorkingDir,
        }),
      );

      const userPrompt = initUserPrompt(messages);
      expect(userPrompt).toContain("<thread_context>");
      expect(userPrompt).toMatch(/<\/thread_context>/);
      expect(userPrompt).toContain("channel: webchat");
      expect(userPrompt).toContain("thread id: tc-session-1");
      expect(userPrompt).toContain("channelUserId: guardian");
      expect(userPrompt).toContain("is direct message: yes");
      expect(userPrompt).toContain(`Current selected project is "alpha" at ${projectWorkingDir}`);
      // The block precedes the user's own text.
      expect(userPrompt.indexOf("<thread_context>")).toBeLessThan(userPrompt.indexOf("Hello"));
    });

    it("does not repeat the block on later turns of the same session", async () => {
      const modelResolver = createTestModelResolver({
        providers: [alwaysResultProvider()],
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.open(
        { agentName: "test-main", channelThreadKey: "webchat:tc-kept-alive" },
        { threadContext: webchatThreadContext, workingDir: projectWorkingDir },
      );

      const first = await collectMessages(
        (
          await startAfter(session, { prompt: "First" }, { threadContext: webchatThreadContext })
        ).events(),
      );
      const second = await collectMessages(
        (
          await startAfter(session, { prompt: "Second" }, { threadContext: webchatThreadContext })
        ).events(),
      );

      expect(initUserPrompt(first)).toContain("<thread_context>");
      expect(initUserPrompt(second)).not.toContain("<thread_context>");
      await manager.shutdown();
    });

    it("does not inject into a resumed session (the block is already in its history)", async () => {
      // A row whose model thread the provider resumes already holds the block.
      const seeded = Session.create("core:test-main", { continuityKey: "webchat:tc-resumed" });
      seeded.recordTurn({
        provider: "mock",
        modelThreadId: "mock-thread-1",
        model: "mock-model",
      });
      await sessionRepository.add(seeded);
      const runner = createRunner(alwaysResultProvider());

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue",
          channelThreadKey: "webchat:tc-resumed",
          threadContext: webchatThreadContext,
          workingDir: projectWorkingDir,
        }),
      );

      expect(initUserPrompt(messages)).not.toContain("<thread_context>");
    });

    it("injects into a session whose row never recorded a model thread", async () => {
      // The provider resumes only a recorded thread, so this one starts new
      // and has not seen the block.
      const seeded = Session.create("core:test-main", { continuityKey: "webchat:tc-unthreaded" });
      await sessionRepository.add(seeded);
      const runner = createRunner(alwaysResultProvider());

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue",
          channelThreadKey: "webchat:tc-unthreaded",
          threadContext: webchatThreadContext,
          workingDir: projectWorkingDir,
        }),
      );

      expect(initUserPrompt(messages)).toContain("<thread_context>");
    });

    it("does not inject into subagent sessions", async () => {
      const modelResolver = createTestModelResolver({
        providers: [alwaysResultProvider()],
      });
      const manager = createSessions(managerDeps(modelResolver), {
        isSubagent: true,
      });
      const session = await manager.open(
        { agentName: "test-main", channelThreadKey: "webchat:tc-subagent" },
        { threadContext: webchatThreadContext, workingDir: projectWorkingDir },
      );

      const messages = await collectMessages(
        (
          await startAfter(session, { prompt: "Subtask" }, { threadContext: webchatThreadContext })
        ).events(),
      );

      expect(initUserPrompt(messages)).not.toContain("<thread_context>");
      await manager.shutdown();
    });

    it("prepends <device_folder> on every turn, subagents included", async () => {
      const withFolder = {
        ...webchatThreadContext,
        deviceFolder: { deviceId: "mac-1", deviceName: "macbook", platform: "macos", path: "/w" },
      };
      for (const isSubagent of [false, true]) {
        const manager = createSessions(
          managerDeps(createTestModelResolver({ providers: [alwaysResultProvider()] })),
          { keepAliveAcrossTurns: true, isSubagent },
        );
        const session = await manager.open(
          { agentName: "test-main", channelThreadKey: `webchat:tc-folder-${isSubagent}` },
          { threadContext: withFolder, workingDir: projectWorkingDir },
        );
        for (const prompt of ["First", "Second"]) {
          const userPrompt = initUserPrompt(
            await collectMessages(
              (await startAfter(session, { prompt }, { threadContext: withFolder })).events(),
            ),
          );
          expect(userPrompt).toContain('Work in folder "/w" on Rome node device "macbook"');
          expect(userPrompt.indexOf("<device_folder>")).toBeLessThan(userPrompt.indexOf(prompt));
        }
        await manager.shutdown();
      }
    });

    it("catches up on nothing in a chat whose channel hands the agent every message", async () => {
      const webchatRepo = new ChatsWebChatRepository(testDb.db);
      const conversation = await webchatRepo.ensureChannelChat({
        channel: "discord",
        threadId: "quiet-context",
        agentName: "main",
      });
      const ambient: UnseenLine = {
        id: 7,
        senderName: "Bob",
        text: "ambient update",
        at: new Date("2026-08-03T08:01:00.000Z"),
        fromRome: false,
        quoted: null,
        quotesOutside: false,
      };
      const seen: (readonly number[])[] = [];
      // The same channel chat as above, but its surface says every message
      // already reaches the agent, as webchat's does.
      const promptFacts = chatPromptFacts({
        facts: { unseen: () => [ambient], seen: (ids) => void seen.push(ids) },
        channelOfChat: (chatId) => webchatRepo.channelOfChat(chatId),
        channelSurface: (channel) =>
          channel === "discord" ? { interactiveCards: false, promptContext: false } : null,
      });

      const providerPrompts: string[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* (input) {
          providerPrompts.push(input.prompt);
          yield { type: "result", content: "ok" };
        }),
      };
      await collectMessages(
        createRunner(provider, undefined, { turnLinks: promptFacts }).run({
          agentName: "test-main",
          prompt: "current message",
          channelThreadKey: "discord:quiet-context",
          romeSessionId: conversation.id,
          threadContext: { channel: "discord", threadId: "quiet-context" },
        }),
      );

      expect(providerPrompts).toHaveLength(1);
      expect(providerPrompts[0]).not.toContain("<conversation_context>");
      expect(providerPrompts[0]).not.toContain("ambient update");
      expect(seen).toEqual([]);
    });

    it("catches up on the lines its turn links have not seen, and marks them seen", async () => {
      const webchatRepo = new ChatsWebChatRepository(testDb.db);
      const conversation = await webchatRepo.ensureChannelChat({
        channel: "discord",
        threadId: "linked-context",
        agentName: "main",
      });
      // A legacy row the turn links stand in for: it must not be read.
      await webchatRepo.addConversationMessage({
        sessionId: conversation.id,
        role: "notification",
        content: JSON.stringify([{ type: "text", content: "legacy update" }]),
        platformMessageId: "legacy-message",
        senderName: "Carol",
      });
      const at = new Date("2026-08-03T08:00:00.000Z");
      const unseen: UnseenLine[] = [
        {
          id: 7,
          senderName: "Bob",
          text: "ambient update",
          at,
          fromRome: false,
          quoted: null,
          quotesOutside: false,
        },
        {
          id: 8,
          senderName: "Dana",
          text: "second update",
          at,
          fromRome: false,
          quoted: null,
          quotesOutside: false,
        },
      ];
      const seen: { ids: readonly number[]; sessionId: string; turnId: string }[] = [];
      const turnLinks: Pick<TurnLinks, "unseen" | "seen"> = {
        unseen: (sessionId) => (sessionId === conversation.id ? unseen : []),
        seen: (ids, sessionId, turnId) => {
          seen.push({ ids, sessionId, turnId });
        },
      };

      const providerPrompts: string[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* (input) {
          providerPrompts.push(input.prompt);
          yield { type: "result", content: "ok" };
        }),
      };
      await collectMessages(
        createRunner(provider, undefined, { turnLinks }).run({
          agentName: "test-main",
          prompt: "current message",
          channelThreadKey: "discord:linked-context",
          romeSessionId: conversation.id,
          threadContext: {
            channel: "discord",
            threadId: "linked-context",
            channelUserId: "guardian",
            threadType: "group",
          },
        }),
      );

      const prompt = providerPrompts[0] ?? "";
      expect(prompt).toContain("Bob: ambient update");
      expect(prompt).toContain("Dana: second update");
      expect(prompt).not.toContain("legacy update");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.ids).toEqual([7, 8]);
      expect(seen[0]?.sessionId).toBe(conversation.id);
    });

    async function linkedPrompt(
      unseen: UnseenLine[],
      threadContext: { threadId: string; parentThreadId?: string },
    ): Promise<string> {
      const webchatRepo = new ChatsWebChatRepository(testDb.db);
      if (threadContext.parentThreadId) {
        await webchatRepo.ensureChannelChat({
          channel: "discord",
          threadId: threadContext.parentThreadId,
          agentName: "main",
        });
      }
      const conversation = await webchatRepo.ensureChannelChat({
        channel: "discord",
        threadId: threadContext.threadId,
        ...(threadContext.parentThreadId ? { parentThreadId: threadContext.parentThreadId } : {}),
        agentName: "main",
      });
      const turnLinks: Pick<TurnLinks, "unseen" | "seen"> = {
        unseen: () => unseen,
        seen: () => undefined,
      };
      const prompts: string[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* (input) {
          prompts.push(input.prompt);
          yield { type: "result", content: "ok" };
        }),
      };
      await collectMessages(
        createRunner(provider, undefined, { turnLinks }).run({
          agentName: "test-main",
          prompt: "current message",
          channelThreadKey: `discord:${threadContext.threadId}`,
          romeSessionId: conversation.id,
          threadContext: {
            channel: "discord",
            ...threadContext,
            channelUserId: "guardian",
            threadType: "group",
          },
        }),
      );
      return prompts[0] ?? "";
    }

    it("leaves the line an ordinary reply quotes out of the catch-up", async () => {
      const at = new Date("2026-08-03T08:00:00.000Z");
      const target = { id: 1, senderName: "Bob", text: "the question", at };
      const prompt = await linkedPrompt(
        [
          { ...target, fromRome: false, quoted: null, quotesOutside: false },
          {
            id: 2,
            senderName: "Rome",
            text: "the answer",
            at,
            fromRome: true,
            quoted: target,
            quotesOutside: false,
          },
        ],
        { threadId: "open-chat" },
      );
      expect(prompt.split("Bob: the question")).toHaveLength(2);
    });

    it("carries the line that started a thread before Rome's first line in it", async () => {
      const at = new Date("2026-08-03T08:00:00.000Z");
      const starter = { id: 1, senderName: "Bob", text: "start here", at };
      const prompt = await linkedPrompt(
        [
          {
            id: 2,
            senderName: "Rome",
            text: "on it",
            at,
            fromRome: true,
            quoted: starter,
            quotesOutside: true,
          },
        ],
        { threadId: "thread-1", parentThreadId: "parent-chat" },
      );
      expect(prompt).toContain("Bob: start here");
      expect(prompt.indexOf("Bob: start here")).toBeLessThan(prompt.indexOf("Rome: on it"));
    });

    it("carries only the newest 20 unseen lines, and counts the rest", async () => {
      const at = new Date("2026-08-03T08:00:00.000Z");
      const unseen: UnseenLine[] = Array.from({ length: 21 }, (_, index) => ({
        id: index + 1,
        senderName: "Participant",
        text: `ambient ${index + 1}`,
        at,
        fromRome: false,
        quoted: null,
        quotesOutside: false,
      }));

      const prompt = await linkedPrompt(unseen, { threadId: "bounded-chat" });

      expect(prompt).toContain("[1 earlier messages omitted]");
      expect(prompt).not.toContain("Participant: ambient 1\n");
      expect(prompt).toContain("Participant: ambient 2");
      expect(prompt).toContain("Participant: ambient 21");
    });

    it("quotes the platform's copy of the message replied to when Rome holds none", async () => {
      const webchatRepo = new ChatsWebChatRepository(testDb.db);
      const conversation = await webchatRepo.ensureChannelChat({
        channel: "wechat",
        threadId: "wechat-runtime-reply",
        agentName: "main",
      });
      const turnLinks: Pick<TurnLinks, "unseen" | "seen"> = {
        unseen: () => [],
        seen: () => undefined,
      };
      const providerPrompts: string[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* (input) {
          providerPrompts.push(input.prompt);
          yield { type: "result", content: "ok" };
        }),
      };

      await collectMessages(
        createRunner(provider, undefined, { turnLinks }).run({
          agentName: "test-main",
          prompt: "What does the first word mean?",
          channelThreadKey: "wechat:wechat-runtime-reply",
          romeSessionId: conversation.id,
          platformMessageId: "current-message",
          replyTo: {
            messageId: "wechat-server-42",
            content: "Jack Ma profile",
            senderName: "Rome",
          },
          threadContext: {
            channel: "wechat",
            threadId: "wechat-runtime-reply",
            channelUserId: "guardian",
            threadType: "private",
          },
        }),
      );

      expect(providerPrompts[0]).toContain(
        "<reply_context>\nRome: Jack Ma profile\n</reply_context>",
      );
    });
  });

  describe("model mapping", () => {
    it("uses the agent reasoning effort and defaults missing YAML values to high", async () => {
      const configuredProvider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      await collectMessages(
        createRunner(configuredProvider).run({
          agentName: "test-all-actions",
          prompt: "Use configured effort",
        }),
      );
      expect(configuredProvider.sessions[0].config.reasoningEffort).toBe("low");

      const defaultProvider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      await collectMessages(
        createRunner(defaultProvider).run({
          agentName: "test-main",
          prompt: "Use default effort",
        }),
      );
      expect(defaultProvider.sessions[0].config.reasoningEffort).toBe("high");
    });

    it("maps tier names correctly (large, medium, small)", async () => {
      // test-main maps to "large" tier
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Map model" }));

      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].model).toBe("claude-opus-5-5[1m]");

      // test-sentinel maps to "small" tier
      const provider2 = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner2 = createRunner(provider2);

      await collectMessages(runner2.run({ agentName: "test-sentinel", prompt: "Map model" }));

      expect(provider2.calls[0].model).toBe("claude-haiku-5-5");
    });

    it("pins the session to the agent's configured provider and fails closed", async () => {
      // test-pinned declares `provider: openai` (tier small). The pin must
      // reach session resolution: with Codex usable the session opens on the
      // Codex small model, and with Codex logged out the session must fail
      // instead of silently falling back to Claude — an unpinned agent would
      // have fallen back, so the rejection is what proves the threading.
      const anthropicSessions: ModelSessionParams[] = [];
      const openAiSessions: ModelSessionParams[] = [];
      const anthropic: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          anthropicSessions.push(params);
          return createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: "anthropic" };
            },
            params,
          );
        },
      };
      const openai: ModelProvider = {
        id: "openai",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          openAiSessions.push(params);
          return createSessionFromRun(
            "openai",
            async function* () {
              yield { type: "result", content: "openai" };
            },
            params,
          );
        },
      };

      const modelResolver = createTestModelResolver({ providers: [anthropic, openai] });
      const manager = createSessions(managerDeps(modelResolver));
      const session = await manager.open(
        { agentName: "test-pinned", channelThreadKey: "webchat:pinned-1" },
        {},
      );
      await collectMessages((await startAfter(session, { prompt: "Map model" })).events());

      expect(anthropicSessions).toHaveLength(0);
      expect(openAiSessions).toHaveLength(1);
      expect(openAiSessions[0].config.model).toBe("gpt-6-luna");
      await manager.shutdown();

      const codexLoggedOut = {
        openai: reportOf("unauthorized"),
        anthropic: reportOf("available"),
      };
      const loggedOutResolver = createModelResolver({
        providers: [anthropic, openai],
        accounts: fakeAccounts(() => codexLoggedOut),
      });
      const loggedOutManager = createSessions(managerDeps(loggedOutResolver));

      await expect(
        loggedOutManager.open(
          { agentName: "test-pinned", channelThreadKey: "webchat:pinned-2" },
          {},
        ),
      ).rejects.toMatchObject({
        code: "model_provider_unavailable",
        provider: "openai",
        reason: "not_logged_in",
      });
      expect(anthropicSessions).toHaveLength(0);
      await loggedOutManager.shutdown();
    });

    it("honors an exact per-session model selection", async () => {
      const anthropicSessions: ModelSessionParams[] = [];
      const openAiSessions: ModelSessionParams[] = [];
      const anthropic: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          anthropicSessions.push(params);
          return createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: "anthropic" };
            },
            params,
          );
        },
      };
      const openai: ModelProvider = {
        id: "openai",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          openAiSessions.push(params);
          return createSessionFromRun(
            "openai",
            async function* () {
              yield { type: "result", content: "openai" };
            },
            params,
          );
        },
      };
      const modelResolver = createTestModelResolver({
        providers: [anthropic, openai],
      });
      const manager = createSessions(managerDeps(modelResolver));

      const session = await manager.open(
        {
          agentName: "test-main",
          channelThreadKey: "webchat:session-1",
        },
        { selectionId: "gpt-5-6-terra" },
      );
      const handle = await startAfter(session, { prompt: "Map model" });
      await collectMessages(handle.events());

      expect(anthropicSessions).toHaveLength(0);
      expect(openAiSessions).toHaveLength(1);
      expect(openAiSessions[0].config.model).toBe("gpt-5.6-terra");
    });

    it("restores the selected model from the session pin on explicit cold resume", async () => {
      const openAiSessions: ModelSessionParams[] = [];
      const openai: ModelProvider = {
        id: "openai",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          openAiSessions.push(params);
          const modelSession = createSessionFromRun(
            "openai",
            async function* () {
              yield { type: "result", content: "openai" };
            },
            params,
          );
          return { ...modelSession, modelThreadId: "codex-thread-1" };
        },
      };
      const modelResolver = createTestModelResolver({ providers: [openai] });
      const firstManager = createSessions(managerDeps(modelResolver));
      const key = {
        agentName: "test-main",
        channelThreadKey: "webchat:session-cold",
      };
      const firstSession = await firstManager.open(key, { selectionId: "gpt-5-6-terra" });
      await collectMessages((await startAfter(firstSession, { prompt: "Start" })).events());
      await firstManager.shutdown();

      const resumedManager = createSessions(managerDeps(modelResolver));
      const resumedRunner = new AgentRunner(resumedManager, agentLoader);
      const resumedMessages = await collectMessages(
        resumedRunner.run({
          agentName: "test-main",
          sessionId: firstSession.sessionId,
          prompt: "Continue",
        }),
      );

      expect(openAiSessions).toHaveLength(2);
      expect(openAiSessions[0]).toMatchObject({
        config: { model: "gpt-5.6-terra" },
        thread: { kind: "new" },
      });
      expect(openAiSessions[1]).toMatchObject({
        config: { model: "gpt-5.6-terra" },
        thread: { kind: "resume", modelThreadId: "codex-thread-1" },
      });
      expect(resumedMessages.find((message) => message.type === "session_init")).toMatchObject({
        sessionId: firstSession.sessionId,
      });
      await resumedManager.shutdown();
    });
  });

  describe("per-turn model resolution", () => {
    it("does not replay a failed turn and selects the other provider on the next turn", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("available"),
      };
      let codexTurns = 0;
      let claudeTurns = 0;
      const claudeOpens: ModelSessionParams[] = [];
      const codex: ModelProvider = {
        id: "openai",
        builtinTools: new Set(),
        openSession: async (params) => {
          const session = createSessionFromRun(
            "openai",
            async function* () {
              codexTurns += 1;
              state.openai = reportOf("usage_limit_reached");
              yield { type: "error", error: "Codex quota exhausted", code: "usage_limit" };
            },
            params,
          );
          return { ...session, modelThreadId: "codex-thread" };
        },
      };
      const claude: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set(),
        openSession: async (params) => {
          claudeOpens.push(params);
          const session = createSessionFromRun(
            "anthropic",
            async function* () {
              claudeTurns += 1;
              yield { type: "result", content: "Claude handled the next turn" };
            },
            params,
          );
          return { ...session, modelThreadId: "claude-thread" };
        },
      };
      const modelResolver = createModelResolver({
        providers: [codex, claude],
        accounts: fakeAccounts(() => state),
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:per-turn-fallback",
      });

      const first = await collectMessages(
        (await startAfter(session, { prompt: "first" })).events(),
      );
      expect(first.find((message) => message.type === "error")).toMatchObject({
        error: "Codex quota exhausted",
      });
      expect(codexTurns).toBe(1);
      expect(claudeTurns).toBe(0);

      const second = await collectMessages(
        (await startAfter(session, { prompt: "second" })).events(),
      );
      expect(second.find((message) => message.type === "result")).toMatchObject({
        content: "Claude handled the next turn",
      });
      expect(codexTurns).toBe(1);
      expect(claudeTurns).toBe(1);
      expect(claudeOpens[0].thread).toEqual({ kind: "new" });
      await manager.shutdown();
    });

    it("reopens a provider backend after an auth-revoked terminal", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("unauthorized"),
      };
      const opens: ModelSessionParams[] = [];
      const codex: ModelProvider = {
        id: "openai",
        builtinTools: new Set(),
        openSession: async (params) => {
          opens.push(params);
          const openNumber = opens.length;
          const session = createSessionFromRun(
            "openai",
            async function* () {
              if (openNumber === 1) {
                state.openai = reportOf("unauthorized");
                yield {
                  type: "error",
                  error: "Codex credentials were revoked",
                  code: "auth_revoked",
                };
                return;
              }
              yield { type: "result", content: "Codex reconnected" };
            },
            params,
          );
          return { ...session, modelThreadId: "codex-thread" };
        },
      };
      const modelResolver = createModelResolver({
        providers: [codex],
        accounts: fakeAccounts(() => state),
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:auth-revoked-reopen",
      });

      const first = await collectMessages(
        (await startAfter(session, { prompt: "first" })).events(),
      );
      expect(first.find((message) => message.type === "error")).toMatchObject({
        code: "auth_revoked",
        provider: "openai",
      });

      // Simulate a completed re-login. The next turn must not reuse the model
      // session that observed the revoked credential.
      state.openai = reportOf("available");
      const second = await collectMessages(
        (await startAfter(session, { prompt: "second" })).events(),
      );

      expect(second.find((message) => message.type === "result")).toMatchObject({
        content: "Codex reconnected",
      });
      expect(opens).toHaveLength(2);
      expect(opens[1]).toMatchObject({
        thread: { kind: "resume", modelThreadId: "codex-thread" },
      });
      await manager.shutdown();
    });

    it("reopens the same provider when an unpinned session's resolved model changes and keeps its native thread", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("unauthorized"),
      };
      const opens: ModelSessionParams[] = [];
      const codex: ModelProvider = {
        id: "openai",
        builtinTools: new Set(),
        openSession: async (params) => {
          opens.push(params);
          const openNumber = opens.length;
          const session = createSessionFromRun(
            "openai",
            async function* () {
              if (openNumber === 1) {
                // Fail the first turn so the session never records a pin —
                // per-turn tier re-resolution stays in effect (it survives for
                // unpinned sessions only).
                yield { type: "error", error: "Model API failure" };
                return;
              }
              yield { type: "result", content: params.config.model };
            },
            params,
          );
          return { ...session, modelThreadId: "codex-thread" };
        },
      };
      const modelResolver = createModelResolver({
        providers: [codex],
        accounts: fakeAccounts(() => state),
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:per-turn-model",
      });
      await collectMessages((await startAfter(session, { prompt: "Sol" })).events());

      state.openai = reportOf("available", RESTRICTED_PLAN);
      await collectMessages((await startAfter(session, { prompt: "Terra" })).events());

      expect(opens.map((params) => params.config.model)).toEqual(["gpt-6.1-sol", "gpt-5.6-terra"]);
      expect(opens[1]).toMatchObject({
        thread: { kind: "resume", modelThreadId: "codex-thread" },
      });
      await manager.shutdown();
    });

    it("records the pin of the model that actually ran after an unpinned backend swap", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("available"),
      };
      const codex: ModelProvider = {
        id: "openai",
        builtinTools: new Set(),
        openSession: async (params) =>
          createSessionFromRun(
            "openai",
            async function* () {
              // Codex turns never succeed, so the session stays unpinned.
              yield { type: "error", error: "Codex is down" };
            },
            params,
          ),
      };
      const claude: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set(),
        openSession: async (params) =>
          createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: params.config.model };
            },
            params,
          ),
      };
      const modelResolver = createModelResolver({
        providers: [codex, claude],
        accounts: fakeAccounts(() => state),
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:model-pin-swap",
      });

      // First turn fails on Codex → no pin recorded.
      await collectMessages((await startAfter(session, { prompt: "Sol" })).events());
      expect((await sessionRepository.session(session.sessionId))!.model).toBeNull();

      // Codex quota exhausts; the unpinned session re-resolves to Claude and
      // the first successful turn pins the model that actually ran.
      state.openai = reportOf("usage_limit_reached");
      await collectMessages((await startAfter(session, { prompt: "Terra" })).events());
      expect(await sessionRepository.session(session.sessionId)).toMatchObject({
        provider: "anthropic",
        model: "claude-opus-5-5[1m]",
      });

      await manager.shutdown();
    });
  });

  describe("session model pin resolution", () => {
    const FABLE_MODEL = "claude-fable-5-1[1m]";

    // Records every open and echoes the resolved model back as the turn result,
    // so a test can assert which concrete model actually ran.
    function recordingProvider(
      id: ProviderId,
      modelThreadId: string,
      opens: ModelSessionParams[],
    ): ModelProvider {
      return {
        id,
        builtinTools: new Set(),
        openSession: async (params) => {
          opens.push(params);
          const session = createSessionFromRun(
            id,
            async function* () {
              yield { type: "result", content: params.config.model };
            },
            params,
          );
          return { ...session, modelThreadId: modelThreadId };
        },
      };
    }

    const codexProvider = (opens: ModelSessionParams[]): ModelProvider =>
      recordingProvider("openai", "codex-thread", opens);

    const claudeProvider = (opens: ModelSessionParams[]): ModelProvider =>
      recordingProvider("anthropic", "claude-thread", opens);

    it("a pinned session keeps its model across an entitlement upgrade (no backend reopen)", async () => {
      const state = {
        openai: reportOf("available", { ...RESTRICTED_PLAN }),
        anthropic: reportOf("unauthorized"),
      };
      const opens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens)],
        accounts: fakeAccounts(() => state),
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:pin-sticks",
      });

      await collectMessages((await startAfter(session, { prompt: "first" })).events());
      expect((await sessionRepository.session(session.sessionId))!.model).toBe("gpt-5.6-terra");

      // Sol access arrives mid-session. Tier resolution would now map large →
      // Sol, but the pinned session must keep running Terra on the same
      // backend — no close/reopen, no model switch.
      state.openai = reportOf("available");
      const second = await collectMessages(
        (await startAfter(session, { prompt: "second" })).events(),
      );

      expect(second.find((message) => message.type === "result")).toMatchObject({
        content: "gpt-5.6-terra",
      });
      expect(opens).toHaveLength(1);
      await manager.shutdown();
    });

    it("a pinned session keeps its model after the tier mapping changes", async () => {
      const state = {
        openai: reportOf("unauthorized"),
        anthropic: reportOf("available"),
      };
      let tierModelMappings: unknown = { anthropic: { large: FABLE_MODEL } };
      const opens: ModelSessionParams[] = [];
      const claude: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set(),
        openSession: async (params) => {
          opens.push(params);
          return createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: params.config.model };
            },
            params,
          );
        },
      };
      const modelResolver = createModelResolver({
        providers: [claude],
        accounts: fakeAccounts(() => state),
        tierModels: createTierModelsSetting({
          get: async <T = unknown>(key: string): Promise<T | null> =>
            key === "tierModelMappings" ? (tierModelMappings as T) : null,
        }),
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:mapping-pin",
      });

      await collectMessages((await startAfter(session, { prompt: "first" })).events());
      expect(opens[0].config.model).toBe(FABLE_MODEL);

      // A mapping is a Rome-side preference, not an entitlement: it governs
      // new resolutions only. The pinned session stays on the mapped model.
      tierModelMappings = null;
      const second = await collectMessages(
        (await startAfter(session, { prompt: "second" })).events(),
      );

      expect(second.find((message) => message.type === "result")).toMatchObject({
        content: FABLE_MODEL,
      });
      expect(opens).toHaveLength(1);
      await manager.shutdown();
    });

    it("a stranded pinned session fails the turn with the structured resolution error", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("available"),
      };
      const opens: ModelSessionParams[] = [];
      const claudeOpens: ModelSessionParams[] = [];
      const claude: ModelProvider = {
        id: "anthropic",
        builtinTools: new Set(),
        openSession: async (params) => {
          claudeOpens.push(params);
          return createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: params.config.model };
            },
            params,
          );
        },
      };
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens), claude],
        accounts: fakeAccounts(() => state),
      });
      const manager = createSessions(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.open({
        agentName: "test-main",
        channelThreadKey: "webchat:pin-stranded",
      });

      await collectMessages((await startAfter(session, { prompt: "first" })).events());
      expect(opens.map((params) => params.config.model)).toEqual(["gpt-6.1-sol"]);

      // Sol access is lost. The pinned session must fail closed with the
      // structured error — no tier re-map to Terra, no Claude substitution.
      state.openai = reportOf("available", RESTRICTED_PLAN);
      const second = await collectMessages(
        (await startAfter(session, { prompt: "second" })).events(),
      );
      expect(second.find((message) => message.type === "error")).toMatchObject({
        code: "model_unavailable",
        provider: "openai",
        reason: "model_access_denied",
      });

      // Provider-level outage (quota) fails the same way.
      state.openai = reportOf("available");
      state.openai = reportOf("usage_limit_reached");
      const third = await collectMessages(
        (await startAfter(session, { prompt: "third" })).events(),
      );
      expect(third.find((message) => message.type === "error")).toMatchObject({
        code: "model_provider_unavailable",
        provider: "openai",
        reason: "quota_exhausted",
      });

      expect(opens).toHaveLength(1);
      expect(claudeOpens).toHaveLength(0);
      await manager.shutdown();
    });

    it("a legacy session (NULL pin) resolves by tier, then pins on its next successful turn", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("unauthorized"),
      };
      const opens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens)],
        accounts: fakeAccounts(() => state),
      });
      const seeded = Session.create("core:test-main", { continuityKey: "telegram:legacy-row" });
      // A pre-cutover row: provider + thread persisted, model NULL.
      seeded.recordTurn({ provider: "openai", modelThreadId: "codex-thread" });
      await sessionRepository.add(seeded);
      const legacyId = seeded.id;

      const manager = createSessions(managerDeps(modelResolver));
      const runner = new AgentRunner(manager, agentLoader);
      await collectMessages(
        runner.run({ agentName: "test-main", sessionId: legacyId, prompt: "Continue" }),
      );

      // Tier resolution as before the pin (large → Sol with access), carrying
      // the stored model thread; the successful turn then records the pin.
      expect(opens).toHaveLength(1);
      expect(opens[0]).toMatchObject({
        config: { model: "gpt-6.1-sol" },
        thread: { kind: "resume", modelThreadId: "codex-thread" },
      });
      expect(await sessionRepository.session(legacyId)).toMatchObject({
        provider: "openai",
        model: "gpt-6.1-sol",
      });
      await manager.shutdown();
    });

    it("a new session of another agent on the same thread resolves its own tier (no pin inheritance)", async () => {
      const state = {
        openai: reportOf("available", RESTRICTED_PLAN),
        anthropic: reportOf("unauthorized"),
      };
      const opens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens)],
        accounts: fakeAccounts(() => state),
      });
      // The main agent's session on this thread is pinned to Sol.
      const seeded = Session.create("core:test-main", { continuityKey: "webchat:shared-thread" });
      seeded.recordTurn({
        provider: "openai",
        modelThreadId: "codex-thread",
        model: "gpt-5.6-sol",
      });
      await sessionRepository.add(seeded);
      const mainId = seeded.id;

      // A subagent reuses the parent's channelThreadKey; session lookup is
      // agent-scoped, so its fresh session resolves from its own tier (small
      // → Terra without Luna access) instead of inheriting the parent's pin.
      const manager = createSessions(managerDeps(modelResolver));
      const session = await manager.open({
        agentName: "test-explore",
        channelThreadKey: "webchat:shared-thread",
      });
      await collectMessages((await startAfter(session, { prompt: "explore" })).events());

      expect(session.sessionId).not.toBe(mainId);
      expect(opens).toHaveLength(1);
      expect(opens[0]).toMatchObject({
        config: { model: "gpt-5.6-terra" },
        thread: { kind: "new" },
      });
      await manager.shutdown();
    });

    it("a resumed session runs on its pin even when tier resolution would pick another model", async () => {
      const state = {
        openai: reportOf("available", { ...RESTRICTED_PLAN }),
        anthropic: reportOf("unauthorized"),
      };
      const opens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens)],
        accounts: fakeAccounts(() => state),
      });
      const firstManager = createSessions(managerDeps(modelResolver));
      const first = await firstManager.open({
        agentName: "test-main",
        channelThreadKey: "telegram:pin-resume",
      });
      await collectMessages((await startAfter(first, { prompt: "Start" })).events());
      await firstManager.shutdown();
      expect(opens.map((params) => params.config.model)).toEqual(["gpt-5.6-terra"]);

      // Entitlements improved while the session was cold. Tier resolution
      // would now pick Sol; the pin keeps the resume on Terra.
      state.openai = reportOf("available");
      const resumedManager = createSessions(managerDeps(modelResolver));
      const runner = new AgentRunner(resumedManager, agentLoader);
      await collectMessages(
        runner.run({ agentName: "test-main", sessionId: first.sessionId, prompt: "Continue" }),
      );

      expect(opens).toHaveLength(2);
      expect(opens[1]).toMatchObject({
        config: { model: "gpt-5.6-terra" },
        thread: { kind: "resume", modelThreadId: "codex-thread" },
      });
      await resumedManager.shutdown();
    });

    it("an explicit selection overrides the pin and re-pins to the selected model", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("available"),
      };
      const codexOpens: ModelSessionParams[] = [];
      const claudeOpens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(codexOpens), claudeProvider(claudeOpens)],
        accounts: fakeAccounts(() => state),
      });

      // A session already pinned to Codex Terra.
      const seeded = Session.create("core:test-main", { continuityKey: "webchat:override-pin" });
      seeded.recordTurn({
        provider: "openai",
        modelThreadId: "codex-thread",
        model: "gpt-5.6-terra",
      });
      await sessionRepository.add(seeded);
      const pinnedId = seeded.id;

      // The guardian picks Claude Opus in the selector. Precedence is explicit
      // selection → pin → tier, so the selection wins over the pinned Terra and
      // the turn runs Opus — reusing the existing session, not a new chat.
      const manager = createSessions(managerDeps(modelResolver));
      const session = await manager.open(
        { agentName: "test-main", channelThreadKey: "webchat:override-pin" },
        { selectionId: "claude-opus" },
      );
      expect(session.sessionId).toBe(pinnedId);

      const messages = await collectMessages(
        (await startAfter(session, { prompt: "switch" })).events(),
      );
      expect(messages.find((message) => message.type === "result")).toMatchObject({
        content: "claude-opus-4-8[1m]",
      });
      expect(claudeOpens).toHaveLength(1);
      expect(codexOpens).toHaveLength(0);
      // The successful turn re-pins the session to the model that actually ran.
      expect(await sessionRepository.session(pinnedId)).toMatchObject({
        provider: "anthropic",
        model: "claude-opus-4-8[1m]",
      });
      await manager.shutdown();
    });

    it("a stranded pinned session becomes usable again through an explicit selection", async () => {
      const state = {
        openai: reportOf("available", { ...RESTRICTED_PLAN }),
        anthropic: reportOf("available"),
      };
      const codexOpens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(codexOpens)],
        accounts: fakeAccounts(() => state),
      });

      // A session pinned to Sol, whose access is now lost: the pin strands it.
      const seeded = Session.create("core:test-main", { continuityKey: "webchat:rescue" });
      seeded.recordTurn({
        provider: "openai",
        modelThreadId: "codex-thread",
        model: "gpt-5.6-sol",
      });
      await sessionRepository.add(seeded);
      const strandedId = seeded.id;

      // Resuming on the pin alone fails closed — the pinned model cannot run and
      // there is no silent substitution, so acquiring the session throws the
      // structured resolution error rather than opening a backend.
      const failManager = createSessions(managerDeps(modelResolver));
      await expect(
        failManager.open({ agentName: "test-main", channelThreadKey: "webchat:rescue" }),
      ).rejects.toMatchObject({
        code: "model_unavailable",
        provider: "openai",
        reason: "model_access_denied",
      });
      expect(codexOpens).toHaveLength(0);
      await failManager.shutdown();

      // The guardian selects an available model (Terra). The very same session
      // runs again — no new chat — and re-pins to the selected model.
      const rescueManager = createSessions(managerDeps(modelResolver));
      const rescueSession = await rescueManager.open(
        { agentName: "test-main", channelThreadKey: "webchat:rescue" },
        { selectionId: "gpt-5-6-terra" },
      );
      expect(rescueSession.sessionId).toBe(strandedId);

      const rescued = await collectMessages(
        (await startAfter(rescueSession, { prompt: "use terra" })).events(),
      );
      expect(rescued.find((message) => message.type === "result")).toMatchObject({
        content: "gpt-5.6-terra",
      });
      expect(codexOpens.map((params) => params.config.model)).toEqual(["gpt-5.6-terra"]);
      expect(await sessionRepository.session(strandedId)).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-terra",
      });
      await rescueManager.shutdown();
    });

    it("a legacy resume honors a persisted selection whose provider differs from the stored provider", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("available"),
      };
      const codexOpens: ModelSessionParams[] = [];
      const claudeOpens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(codexOpens), claudeProvider(claudeOpens)],
        accounts: fakeAccounts(() => state),
      });

      // A pre-cutover row (model NULL) whose chat stores a Claude selection,
      // while the stored model thread is Codex. With the resume guard removed,
      // the single precedence rule honors the persisted selection instead of
      // dropping it on provider mismatch.
      await new ChatsWebChatRepository(testDb.db).createSession(
        "legacy-mismatch",
        "Legacy chat",
        undefined,
        undefined,
        "claude-opus",
      );
      const seeded = Session.create("core:test-main", { continuityKey: "webchat:legacy-mismatch" });
      seeded.recordTurn({ provider: "openai", modelThreadId: "codex-thread" });
      await sessionRepository.add(seeded);
      const legacyId = seeded.id;

      const manager = createSessions(managerDeps(modelResolver));
      const runner = new AgentRunner(manager, agentLoader);
      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          sessionId: legacyId,
          prompt: "Continue",
          threadContext: {
            channel: "webchat",
            threadId: "legacy-mismatch",
            romeSessionId: "legacy-mismatch",
          },
        }),
      );

      // The resume opens Claude Opus on a fresh model thread (provider changed
      // from Codex), never the stored-provider tier resolution.
      expect(messages.find((message) => message.type === "result")).toMatchObject({
        content: "claude-opus-4-8[1m]",
      });
      expect(claudeOpens).toHaveLength(1);
      expect(claudeOpens[0]).toMatchObject({
        config: { model: "claude-opus-4-8[1m]" },
        thread: { kind: "new" },
      });
      expect(codexOpens).toHaveLength(0);
      await manager.shutdown();
    });

    it("a legacy resume without a thread context reads the selection through its key", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("available"),
      };
      const codexOpens: ModelSessionParams[] = [];
      const claudeOpens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(codexOpens), claudeProvider(claudeOpens)],
        accounts: fakeAccounts(() => state),
      });

      // A pre-cutover row (model NULL) whose chat stores a Claude selection,
      // while the stored model thread is Codex. With the resume guard removed,
      // the single precedence rule honors the persisted selection instead of
      // dropping it on provider mismatch.
      await new ChatsWebChatRepository(testDb.db).createSession(
        "legacy-no-context",
        "Legacy chat",
        undefined,
        undefined,
        "claude-opus",
      );
      const seeded = Session.create("core:test-main", {
        continuityKey: "webchat:legacy-no-context",
      });
      seeded.recordTurn({ provider: "openai", modelThreadId: "codex-thread" });
      await sessionRepository.add(seeded);
      const legacyId = seeded.id;

      const manager = createSessions(managerDeps(modelResolver));
      const runner = new AgentRunner(manager, agentLoader);
      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          sessionId: legacyId,
          prompt: "Continue",
        }),
      );

      // The resume opens Claude Opus on a fresh model thread (provider changed
      // from Codex), never the stored-provider tier resolution.
      expect(messages.find((message) => message.type === "result")).toMatchObject({
        content: "claude-opus-4-8[1m]",
      });
      expect(claudeOpens).toHaveLength(1);
      expect(claudeOpens[0]).toMatchObject({
        config: { model: "claude-opus-4-8[1m]" },
        thread: { kind: "new" },
      });
      expect(codexOpens).toHaveLength(0);
      await manager.shutdown();
    });

    it("a legacy subagent resume ignores the parent chat's persisted selection", async () => {
      const state = {
        openai: reportOf("available"),
        anthropic: reportOf("available"),
      };
      const codexOpens: ModelSessionParams[] = [];
      const claudeOpens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(codexOpens), claudeProvider(claudeOpens)],
        accounts: fakeAccounts(() => state),
      });

      // The parent chat stores a Claude selection. Its subagent's legacy row
      // (model NULL) ran on Codex, and the subagent opens with the parent's
      // thread context, so the chat's selection must not reach it.
      await new ChatsWebChatRepository(testDb.db).createSession(
        "legacy-parent",
        "Legacy chat",
        undefined,
        undefined,
        "claude-opus",
      );
      const seeded = Session.create("core:test-main", {
        continuityKey: "webchat:legacy-parent:subagent:child-1",
      });
      seeded.recordTurn({ provider: "openai", modelThreadId: "codex-thread" });
      await sessionRepository.add(seeded);
      const legacyId = seeded.id;

      const manager = createSessions(managerDeps(modelResolver), {
        isSubagent: true,
      });
      const runner = new AgentRunner(manager, agentLoader);
      await collectMessages(
        runner.run({
          agentName: "test-main",
          sessionId: legacyId,
          prompt: "Continue",
          threadContext: {
            channel: "webchat",
            threadId: "legacy-parent",
            romeSessionId: "legacy-parent",
          },
        }),
      );

      expect(claudeOpens).toHaveLength(0);
      expect(codexOpens).toHaveLength(1);
      await manager.shutdown();
    });
  });

  describe("tools", () => {
    it("forwards explicit threadContext into action execution", async () => {
      const actionRun = rs
        .spyOn(actionEngine, "run")
        .mockResolvedValue({ status: "ok", data: { ok: true } });

      actionRegistry.register({
        config: {
          name: "send_message",
          type: "system",
          description: "Send a message",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { text: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const runImplAction = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentEvent> {
        yield { type: "tool_use", id: "tu-send-1", tool: "send_message", input: { text: "hello" } };
        await executeActionTool(params.tools, "send_message", { text: "hello" });
        yield { type: "result", content: "Done" };
      };
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImplAction),
      };

      const runner = createRunner(provider);

      await collectMessages(
        runner.run({
          agentName: "test-all-actions",
          prompt: "Use action",
          channelThreadKey: "sentinel:telegram:thread-1",
          threadContext: {
            channel: "telegram",
            threadId: "thread-1",
            channelUserId: "user-1",
            threadName: "Dev Chat",
            threadType: "group",
            projectName: "alpha",
          },
        }),
      );

      expect(actionRun).toHaveBeenCalledWith(
        "send_message",
        { text: "hello" },
        expect.objectContaining({
          channelContext: {
            channel: "telegram",
            threadId: "thread-1",
            channelUserId: "user-1",
            threadName: "Dev Chat",
            threadType: "group",
            projectName: "alpha",
          },
          channelThreadKey: "sentinel:telegram:thread-1",
        }),
      );
    });

    it("passes an action catalog from the registry to the model provider", async () => {
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          visibility: "explicit",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Use tools" }));

      expect(provider.calls).toHaveLength(1);
      const listed = (await parseToolText(
        await provider.calls[0].tools.callTool("actions", "list_actions", {}),
      )) as Array<Record<string, unknown>>;
      // demo_action is in test-main's tools list and registered in registry
      expect(listed.map((action) => action.name)).toContain("demo_action");
      expect(listed[0]).toMatchObject({
        description: "Schedule an event",
        sideEffects: "write",
        requiresApproval: false,
      });
    });

    it("expands wildcard action access to public agent-callable actions", async () => {
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });
      actionRegistry.register({
        config: {
          name: "send_message",
          type: "system",
          description: "Send a message",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { text: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });
      actionRegistry.register({
        config: {
          name: "workflow_only",
          type: "system",
          description: "Workflow only",
          complexity: "complex",
          speed: "slow",
          reliability: "high",
          sideEffects: "write",
        },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });
      actionRegistry.register({
        config: {
          name: "internal_action",
          type: "system",
          description: "Internal app action",
          visibility: "explicit",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: {} },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      let executionWasRejected = false;
      const proposals: Record<string, string> = {};
      const routineDraft = (actionName: string) => ({
        sentence: "Every morning, run it",
        name: "Morning run",
        watchLabel: "Run now",
        thenSummary: `Run ${actionName}`,
        kind: "manual",
        actionName,
        args: {},
        activate: true,
      });
      const openFromRun = makeOpenSessionFromRun("mock", async function* (params) {
        expect(await listActionNames(params.tools)).toEqual(["demo_action", "send_message"]);
        await expect(
          executeActionTool(params.tools, "internal_action", {}, { toolUseId: "tu-0" }),
        ).rejects.toThrow(/Unknown action: internal_action/);
        executionWasRejected = true;
        // propose_routine's auto-enable gate mirrors the same allow-list: a
        // routine on an action the agent may not call stays a draft, one on
        // an unregistered action is refused, and one on a permitted action
        // gets past the target check under this turn's key.
        for (const actionName of ["internal_action", "no_such_action", "demo_action"]) {
          const result = await params.tools.callTool(
            "ask_user",
            "propose_routine",
            routineDraft(actionName),
            { toolUseId: "tu-1" },
          );
          proposals[actionName] = result.content.map((item) => item.text).join("\n");
        }
        yield { type: "result", content: "Done" };
      });
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: openFromRun,
      };
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({
          agentName: "test-all-actions",
          prompt: "Use all tools",
          channelThreadKey: "webchat:routine-gate",
        }),
      );

      expect(executionWasRejected).toBe(true);
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
      expect(proposals.internal_action).toContain(
        '"internal_action" is not an action you are permitted to call',
      );
      expect(proposals.no_such_action).toContain('"no_such_action" is not a registered action');
      // demo_action is permitted and the call carried its id, so the gate only
      // stops at create_routine, which this agent may not call.
      expect(proposals.demo_action).toContain("not permitted to create routines directly");
    });

    it("getActionCatalog reflects actions registered after the session opens (ZHA-98)", async () => {
      // Repro of the in-session app_management install flow: the provider's
      // Rome tools (list_actions, execute_action) must observe registrations
      // that happen *after* openSession captured a snapshot. The session
      // exposes the live view via params.getActionCatalog and routes the
      // executeAction callback through the same allow-list-filtered lookup.
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const captured: ModelSessionParams[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          captured.push(params);
          return createSessionFromRun(
            "mock",
            async function* () {
              yield { type: "result", content: "Done" };
            },
            params,
          );
        },
      };
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-all-actions", prompt: "First turn" }));

      expect(captured).toHaveLength(1);
      const sessionParams = captured[0];
      expect(await listActionNames(sessionParams.tools)).toEqual(["demo_action"]);

      // Simulate `app_management` install finishing and the lifecycle manager
      // resync registering a new app action mid-session.
      const newActionExecutes: unknown[] = [];
      actionRegistry.register({
        config: {
          name: "repro_hello",
          type: "system",
          description: "Newly installed action",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async (input) => {
          newActionExecutes.push(input);
          return { status: "ok", data: { ok: true } };
        },
      });

      // The live getter now reports both actions to anything that reads it
      // (the Rome tools' list_actions / search_actions / read_action).
      // Order is registry-insertion-order; sort for stable comparison.
      expect(await listActionNames(sessionParams.tools)).toEqual(["demo_action", "repro_hello"]);

      // executeAction looks up against the same live, allow-list-filtered set
      // — so the agent can call the freshly-installed action from inside the
      // same conversation without rebinding the MCP token.
      const result = await executeActionTool(sessionParams.tools, "repro_hello", { name: "world" });
      expect(result).toEqual({ ok: true });
      expect(newActionExecutes).toEqual([{ name: "world" }]);
    });

    it("applies a change to an agent's action grants from its next turn, in the same session", async () => {
      const register = (name: string) =>
        actionRegistry.register({
          config: {
            name,
            type: "system",
            description: `The ${name} action`,
            complexity: "simple",
            speed: "fast",
            reliability: "high",
            sideEffects: "write",
          },
          inputSchema: { properties: {} },
          execute: async () => ({ status: "ok", data: { ok: name } }),
        });
      register("demo_action");
      register("granted_later");
      const captured: ModelSessionParams[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          captured.push(params);
          return createSessionFromRun(
            "mock",
            async function* () {
              yield { type: "result", content: "Done" };
            },
            params,
          );
        },
      };
      const runner = createRunner(provider, undefined, { keepAliveAcrossTurns: true });
      const definition = agentLoader.find("test-main")!.definition as { actions?: string[] };
      const granted = definition.actions;
      try {
        const run = () =>
          collectMessages(
            runner.run({
              agentName: "test-main",
              prompt: "Hi",
              channelThreadKey: "webchat:grants",
            }),
          );
        await run();
        expect(await listActionNames(captured[0]!.tools)).toEqual(["demo_action"]);

        // The guardian revokes demo_action and grants granted_later.
        definition.actions = ["granted_later"];
        await run();

        expect(captured).toHaveLength(1);
        expect(await listActionNames(captured[0]!.tools)).toEqual(["granted_later"]);
        expect(await executeActionTool(captured[0]!.tools, "granted_later", {})).toEqual({
          ok: "granted_later",
        });
        await expect(executeActionTool(captured[0]!.tools, "demo_action", {})).rejects.toThrow();
      } finally {
        definition.actions = granted;
      }
    });

    it("grants nothing once an agent's actions are revoked and then left out, in the same session", async () => {
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "The demo action",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: {} },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });
      const captured: ModelSessionParams[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          captured.push(params);
          return createSessionFromRun(
            "mock",
            async function* () {
              yield { type: "result", content: "Done" };
            },
            params,
          );
        },
      };
      const runner = createRunner(provider, undefined, { keepAliveAcrossTurns: true });
      const definition = agentLoader.find("test-main")!.definition as { actions?: string[] };
      const granted = definition.actions;
      try {
        const run = () =>
          collectMessages(
            runner.run({
              agentName: "test-main",
              prompt: "Hi",
              channelThreadKey: "webchat:revoked",
            }),
          );
        await run();
        expect(await listActionNames(captured[0]!.tools)).toEqual(["demo_action"]);

        definition.actions = [];
        await run();
        expect(await listActionNames(captured[0]!.tools)).toEqual([]);

        delete definition.actions;
        await run();

        expect(captured).toHaveLength(1);
        expect(await listActionNames(captured[0]!.tools)).toEqual([]);
        await expect(executeActionTool(captured[0]!.tools, "demo_action", {})).rejects.toThrow();
      } finally {
        definition.actions = granted;
      }
    });

    it("getActionCatalog still honors a non-wildcard agent allow-list", async () => {
      // Security regression guard: an agent yaml that scopes
      // `actions: [demo_action]` must never reach actions it didn't ask
      // for, even if those actions are present in the live registry.
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const captured: ModelSessionParams[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          captured.push(params);
          return createSessionFromRun(
            "mock",
            async function* () {
              yield { type: "result", content: "Done" };
            },
            params,
          );
        },
      };
      const runner = createRunner(provider);
      await collectMessages(runner.run({ agentName: "test-main", prompt: "First turn" }));

      const sessionParams = captured[0];

      // Register something outside `test-main`'s allow-list AFTER session open.
      actionRegistry.register({
        config: {
          name: "send_message",
          type: "system",
          description: "Send a message",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { text: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      expect(await listActionNames(sessionParams.tools)).toEqual(["demo_action"]);
      await expect(
        executeActionTool(sessionParams.tools, "send_message", { text: "x" }),
      ).rejects.toThrow(/Unknown action: send_message/);
    });

    it("executeAction resolves a legacy name before checking the allow-list", async () => {
      const legacyBindings = createEmptyLegacyArtifactBindings();
      const actionId = formatArtifactId("review-app", "demo_action");
      claimLegacyArtifactName(legacyBindings, "action", "demo_action", actionId);
      actionRegistry = new ActionRegistryImpl({ legacyBindings });
      actionEngine = new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db));

      const executed: unknown[] = [];
      actionRegistry.register(
        {
          config: {
            name: "demo_action",
            type: "custom",
            description: "Review code",
            complexity: "simple",
            speed: "fast",
            reliability: "high",
            sideEffects: "read-only",
          },
          inputSchema: { properties: { path: { type: "string" } } },
          execute: async (input) => {
            executed.push(input);
            return { status: "ok", data: { reviewed: true } };
          },
        },
        {
          kind: "action",
          ownerType: "app",
          ownerId: "review-app",
          formatVersion: 1,
          publicName: "demo_action",
          aliases: [],
          sourcePath: "/tmp/review-app/actions/demo_action",
        },
      );

      const captured: ModelSessionParams[] = [];
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          captured.push(params);
          return createSessionFromRun(
            "mock",
            async function* () {
              yield { type: "result", content: "Done" };
            },
            params,
          );
        },
      };

      await collectMessages(
        createRunner(provider).run({ agentName: "test-main", prompt: "Review" }),
      );

      expect(await listActionNames(captured[0].tools)).toEqual([actionId]);
      await expect(
        executeActionTool(captured[0].tools, "demo_action", { path: "src/index.ts" }),
      ).resolves.toEqual({ reviewed: true });
      expect(executed).toEqual([{ path: "src/index.ts" }]);
    });

    it("passes built-in tools from agent config to model provider", async () => {
      // test-main has tools: [Read, Edit, demo_action]
      // Mock provider with builtinTools matching Read and Edit
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      provider.builtinTools = new Set(["Read", "Edit", "Write", "Bash", "Glob", "Grep"]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Use tools" }));

      expect(provider.calls).toHaveLength(1);
      // builtinTools should contain only the built-in tools from test-main's config
      expect(provider.calls[0].builtinTools).toEqual(expect.arrayContaining(["Read", "Edit"]));
      expect(provider.calls[0].builtinTools).not.toContain("demo_action");
      expect(provider.calls[0].builtinTools).not.toContain("Write");
    });

    it("passes only agent-specific built-in tools (not all provider built-ins)", async () => {
      // test-explore has tools: [Read, Glob, Grep] — no Edit, no Write, no Bash
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      provider.builtinTools = new Set(["Read", "Edit", "Write", "Bash", "Glob", "Grep"]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-explore", prompt: "Search" }));

      expect(provider.calls).toHaveLength(1);
      const builtins = provider.calls[0].builtinTools!;
      expect(builtins).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
      expect(builtins).not.toContain("Edit");
      expect(builtins).not.toContain("Write");
      expect(builtins).not.toContain("Bash");
    });
  });

  describe("subagents", () => {
    it("passes subagent definitions for allowed subagents", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Delegated" }]]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Delegate" }));

      expect(provider.calls).toHaveLength(1);
      // test-main has allowedSubagents: ["test-explore"]
      expect(toolNames(provider.calls[0].tools, "subagents")).toContain(EXPLORE_TOOL);

      const subagentTool = provider.calls[0].tools
        .listTools("subagents")
        .find((t) => t.name === EXPLORE_TOOL);
      expect(subagentTool).toBeDefined();
      expect(subagentTool!.description).toContain("test-explore");
      expect(subagentTool!.inputSchema).toHaveProperty("properties");
    });

    it("drops tool input previews for subagent calls, whose tool_use is never published", async () => {
      let calls = 0;
      const runImpl = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentEvent> {
        calls += 1;
        if (calls > 1) {
          yield { type: "result", content: "Explore complete" };
          return;
        }
        yield { type: "tool_input_delta", toolUseId: "tu-lookup-1", tool: "lookup", content: "{" };
        yield { type: "tool_use", id: "tu-lookup-1", tool: "lookup", input: {} };
        yield {
          type: "tool_result",
          toolUseId: "tu-lookup-1",
          tool: "lookup",
          output: { ok: true },
        };
        yield {
          type: "tool_input_delta",
          toolUseId: "tu-explore-1",
          tool: EXPLORE_TOOL,
          content: '{"prompt":',
        };
        yield {
          type: "tool_use",
          id: "tu-explore-1",
          tool: EXPLORE_TOOL,
          input: { prompt: "Inspect" },
        };
        const output = await executeSubagentTool(
          params.tools,
          EXPLORE_TOOL,
          { prompt: "Inspect" },
          { toolUseId: "tu-explore-1" },
        );
        yield { type: "tool_result", toolUseId: "tu-explore-1", tool: EXPLORE_TOOL, output };
        yield { type: "result", content: "Delegated" };
      };
      const provider: ModelProvider = {
        id: "mock",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImpl),
      };
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Delegate" }),
      );

      const previews = messages.filter((m) => m.type === "tool_input_delta");
      expect(previews).toEqual([expect.objectContaining({ toolUseId: "tu-lookup-1" })]);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "subagent_start", toolUseId: "tu-explore-1" }),
        ]),
      );
    });

    it("keeps nested subagent runtime messages out of the Parent stream and observer", async () => {
      const observerEvents: unknown[] = [];
      let delegatedOutput: unknown;
      const nestedCalls: import("./agent-runner.js").ModelRunParams[] = [];
      const runImplNested = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentEvent> {
        nestedCalls.push(params);

        if (nestedCalls.length === 1) {
          yield {
            type: "tool_use",
            id: "tu-explore-1",
            tool: EXPLORE_TOOL,
            input: { prompt: "Inspect" },
          };
          const output = await executeSubagentTool(
            params.tools,
            EXPLORE_TOOL,
            { prompt: "Inspect" },
            { toolUseId: "tu-explore-1" },
          );
          delegatedOutput = output;
          yield { type: "tool_result", toolUseId: "tu-explore-1", tool: EXPLORE_TOOL, output };
          const earlyOutput = await executeSubagentTool(
            params.tools,
            EXPLORE_TOOL,
            { prompt: "Inspect before provider event" },
            { toolUseId: "tu-explore-2" },
          );
          yield {
            type: "tool_use",
            id: "tu-explore-2",
            tool: EXPLORE_TOOL,
            input: { prompt: "Inspect before provider event" },
          };
          yield {
            type: "tool_result",
            toolUseId: "tu-explore-2",
            tool: EXPLORE_TOOL,
            output: earlyOutput,
          };
          yield { type: "result", content: "Delegated" };
          return;
        }

        yield { type: "text", content: "Scratchpad details" };
        yield { type: "thinking", content: "Investigating" };
        yield { type: "tool_use", id: "tu-lookup-1", tool: "lookup", input: { q: "details" } };
        yield {
          type: "tool_result",
          toolUseId: "tu-lookup-1",
          tool: "lookup",
          output: { ok: true },
        };
        yield { type: "result", content: "Explore complete" };
      };
      const provider: ModelProvider & { calls: import("./agent-runner.js").ModelRunParams[] } = {
        id: "mock",
        builtinTools: new Set<string>(),
        calls: nestedCalls,
        openSession: makeOpenSessionFromRun("mock", runImplNested),
      };
      const runner = createRunner(provider);

      const messages = await actionExecutionContext.run(
        {
          executionId: "exec-1",
          rootExecutionId: "exec-1",
          initiator: "test",
          runtimeObserver: {
            onRuntimeEvent: (event) => observerEvents.push(event),
          },
        },
        () => collectMessages(runner.run({ agentName: "test-main", prompt: "Delegate" })),
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "subagent_start",
            toolUseId: "tu-explore-1",
            agentName: "core:test-explore",
            input: { prompt: "Inspect" },
            sessionId: expect.any(String),
            turnId: expect.any(String),
            agent: "core:test-main",
          }),
          expect.objectContaining({
            type: "subagent_result",
            toolUseId: "tu-explore-1",
            agentName: "core:test-explore",
            status: "completed",
            sessionId: expect.any(String),
            turnId: expect.any(String),
            output: "Explore complete",
            agent: "core:test-main",
          }),
          expect.objectContaining({
            type: "subagent_start",
            toolUseId: "tu-explore-2",
            agentName: "core:test-explore",
            sessionId: expect.any(String),
            turnId: expect.any(String),
            agent: "core:test-main",
          }),
          expect.objectContaining({
            type: "subagent_result",
            toolUseId: "tu-explore-2",
            agentName: "core:test-explore",
            status: "completed",
            agent: "core:test-main",
          }),
          expect.objectContaining({
            type: "result",
            content: "Delegated",
            agent: "core:test-main",
          }),
          expect.objectContaining({
            type: "turn_end",
            status: "completed",
            durationMs: expect.any(Number),
            agent: "core:test-main",
          }),
        ]),
      );
      expect(delegatedOutput).toEqual(
        expect.objectContaining({
          status: "completed",
          sessionId: expect.any(String),
          turnId: expect.any(String),
          output: "Explore complete",
        }),
      );
      const firstChild = messages.find(
        (message): message is Extract<AgentEvent, { type: "subagent_start" }> =>
          message.type === "subagent_start" && message.toolUseId === "tu-explore-1",
      );
      expect(firstChild).toBeDefined();
      const storedChild = await new ChatsWebChatRepository(testDb.db).getSession(
        firstChild!.sessionId,
      );
      expect(storedChild).toMatchObject({
        type: "subagent",
        parentSessionId: "action:exec-1:core:test-main",
      });
      expect(
        messages.some((message) => "agent" in message && message.agent === "core:test-explore"),
      ).toBe(false);
      expect(observerEvents).toEqual([]);
    });
  });

  describe("outputSchema", () => {
    function structuredProvider(
      runImpl: (params: import("./agent-runner.js").ModelRunParams) => AsyncIterable<AgentEvent>,
    ): ModelProvider & { sessions: import("./agent-runner.js").ModelSessionParams[] } {
      const provider: ModelProvider & {
        sessions: import("./agent-runner.js").ModelSessionParams[];
      } = {
        id: "mock",
        builtinTools: new Set<string>(),
        sessions: [],
        openSession: async (params) => {
          provider.sessions.push(params);
          return createSessionFromRun("mock", runImpl, params);
        },
      };
      return provider;
    }

    it("forwards outputSchema to the provider and returns its native structured result atomically", async () => {
      const payload = { decision: "REPLY", reason: "trivial" };
      const calls: import("./agent-runner.js").ModelRunParams[] = [];
      const provider = structuredProvider(async function* (params) {
        calls.push(params);
        yield { type: "result", content: "provider text is normalized", structuredOutput: payload };
      });
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const session = await manager.open({
        agentName: "test-structured",
        channelThreadKey: "test:structured-native",
      });

      const events: AgentEvent[] = [];
      for await (const msg of (await startAfter(session, { prompt: "Triage." })).events())
        events.push(msg);

      expect(provider.sessions[0].config.outputSchema).toEqual(
        expect.objectContaining({ type: "object", required: ["decision", "reason"] }),
      );
      expect(calls[0].outputSchema).toEqual(provider.sessions[0].config.outputSchema);
      expect(events.filter((event) => event.type === "result")).toEqual([
        expect.objectContaining({
          type: "result",
          content: JSON.stringify(payload),
          structuredOutput: payload,
        }),
      ]);
      expect(events.some((event) => event.type === "structured_output")).toBe(false);
    });

    it("fails the turn when provider-native output does not match the declared schema", async () => {
      const provider = structuredProvider(async function* () {
        yield {
          type: "result",
          content: "{}",
          structuredOutput: { decision: "NOPE", reason: "invalid enum" },
        };
      });
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const session = await manager.open({
        agentName: "test-structured",
        channelThreadKey: "test:structured-invalid",
      });

      const events: AgentEvent[] = [];
      for await (const msg of (await startAfter(session, { prompt: "Triage." })).events())
        events.push(msg);

      expect(events.find((event) => event.type === "result")).toBeUndefined();
      expect(events.find((event) => event.type === "error")).toMatchObject({
        error: expect.stringContaining("failed Rome validation"),
      });
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("fails the turn when a provider completes without structured output", async () => {
      const provider = structuredProvider(async function* () {
        yield { type: "result", content: "plain text" };
      });
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const session = await manager.open({
        agentName: "test-structured",
        channelThreadKey: "test:structured-missing",
      });

      const events: AgentEvent[] = [];
      for await (const msg of (await startAfter(session, { prompt: "Triage." })).events())
        events.push(msg);

      expect(events.find((event) => event.type === "error")).toMatchObject({
        error: expect.stringContaining("without structured output"),
      });
      expect(events.find((event) => event.type === "result")).toBeUndefined();
    });

    it("fails a suspended turn even if the provider later returns valid structured output", async () => {
      const payload = { decision: "REPLY", reason: "after approval" };
      const provider = structuredProvider(async function* () {
        yield {
          type: "tool_result",
          toolUseId: "tu-park",
          tool: "demo_action",
          output: { pendingApproval: true },
        };
        yield { type: "result", content: JSON.stringify(payload), structuredOutput: payload };
      });
      const manager = createSessions(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const session = await manager.open({
        agentName: "test-structured",
        channelThreadKey: "test:structured-suspended",
      });

      const events: AgentEvent[] = [];
      for await (const msg of (await startAfter(session, { prompt: "Triage." })).events())
        events.push(msg);

      expect(events.find((event) => event.type === "result")).toBeUndefined();
      expect(events.find((event) => event.type === "error")).toMatchObject({
        error: expect.stringContaining("cannot suspend"),
      });
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("does not configure provider-native output for an agent without outputSchema", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "ok" }]]);
      const runner = createRunner(provider);
      await collectMessages(runner.run({ agentName: "test-main", prompt: "hi" }));

      expect(provider.sessions).toHaveLength(1);
      expect(provider.sessions[0].config.outputSchema).toBeUndefined();
    });
  });
});
